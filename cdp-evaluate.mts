import { types } from 'node:util';
import { randomUUID } from 'node:crypto';
import type { CDPSession, Page, Frame } from 'playwright-core';
import type { CdpFrameSelection } from './cdp-frames.mts';

export type CdpEvaluateJson = null | boolean | number | string | CdpEvaluateJson[] | { [key: string]: CdpEvaluateJson };

export interface CdpEvaluateOwner {
    readonly page: Page;
    readonly pageId: string;
    getDocumentId?(): string | null;
}

export interface CdpEvaluateRequest {
    pageId: string;
    script: string;
    arguments?: CdpEvaluateJson;
    frameId?: string | null;
    maxResultChars?: number;
}

/** INTERNAL owner-resolved proof, never a model/transport field. Targets owns document identity. */
export interface CdpEvaluateFrameTarget {
    readonly selection:Pick<CdpFrameSelection,'frame'|'describe'|'assertCurrent'>;
    readonly documentKey:string;
}
interface CdpEvaluateResolvedTarget {
    selection:CdpEvaluateFrameTarget['selection'];frame:Frame;frameId:string;documentId:string;documentKey:string;
    probeKey:string;probeValue:string;afterDocumentId:string|null;
}

export interface CdpEvaluateReceipt {
    outcome: 'returned' | 'javascript-error' | 'execution-error';
    pageId: string;
    frameId?: string;
    userFunctionInvoked?: false;
    documentIdBefore: string | null;
    documentIdAfter: string | null;
    documentChanged: boolean | null;
    mayHaveSideEffects: true;
    rollbackPerformed: false;
    result?: {
        state: 'projected' | 'omitted';
        value?: CdpEvaluateJson;
        serialization: {
            policy: 'descriptor-json-v1';
            truncated: boolean;
            issues: string[];
            chars: number;
            utf8Bytes: number;
            maxChars: number;
            maxUtf8Bytes: number;
        };
    };
    error?: { code: string; message: string; name?: string };
}

export class CdpEvaluateError extends Error {
    readonly code: string;
    constructor(code: string, message: string) {
        super(message);
        this.code = code;
        this.name = 'CdpEvaluateError';
    }
}

/** Standalone helper, not a registered tool. Core owns authorization, ActionId, commit barrier and caller deadlines. */
export class CdpEvaluator {
    private session: CDPSession | null = null;
    private nativeFrameId = '';
    private context: { id: number; uniqueId: string } | null = null;
    private readonly contexts = new Map<string,{id:number;uniqueId:string}>();
    private disposed = false;
    private inFlight = 0;
    private readonly objectGroup = 'cdp-evaluate-' + randomUUID();
    private readonly owningFrame;
    private readonly onCreated = (event: any): void => this.contextCreated(event);
    private readonly onDestroyed = (event: any): void => this.contextDestroyed(event);
    private readonly onCleared = (): void => { this.context = null; this.contexts.clear(); };
    private readonly onNavigated = (event: any): void => this.frameNavigated(event);
    private readonly onClosed = (): void => { this.context = null; this.contexts.clear(); };

    private readonly owner: CdpEvaluateOwner;
    private constructor(owner: CdpEvaluateOwner) {
        CdpEvaluator.validateOwner(owner);
        this.owner = owner;
        this.owningFrame = owner.page.mainFrame();
    }

    static async create(owner: CdpEvaluateOwner): Promise<CdpEvaluator> {
        const evaluator = new CdpEvaluator(owner);
        await evaluator.initialize();
        return evaluator;
    }

    /** The returned promise settles only when the actual CDP evaluation settles. Never retry after a caller deadline. */
    evaluate(request: CdpEvaluateRequest, target?:CdpEvaluateFrameTarget): Promise<CdpEvaluateReceipt> {
        const input = this.preflight(request,target!==undefined);
        this.assertReady();
        const resolved=target===undefined?null:this.resolveTarget(target,request.frameId);
        const context = this.context!;
        const documentId = this.documentId();
        this.inFlight++;
        const work=resolved?this.executeFrame(input,resolved):this.execute(input,context.uniqueId,documentId);
        return work.finally(() => { this.inFlight--; });
    }

    describe(): object {
        return {
            mainFrameOnly: false, exactFrameTargets: true, frameContextBinding: 'owner document proof plus conditional public-Frame nonce and own uniqueContextId',
            visibleDefaultContexts: this.contexts.size, maximumContextScan:128, oopifProcessIsolationMeasured:false, awaitPromise: true, localExecutionTimeoutMs: null,
            disposed: this.disposed, pending: this.inFlight,
            limits: { scriptChars: 32768, scriptUtf8Bytes: 65536, argumentChars: 32768,
                argumentUtf8Bytes: 65536, argumentDepth: 12, argumentItems: 1024,
                resultChars: 65536, resultUtf8Bytes: 65536, resultDepth: 10, resultItems: 512 },
        };
    }

    async dispose(): Promise<void> {
        if (this.disposed) return;
        if (this.inFlight) throw new CdpEvaluateError('EVALUATE_PENDING', 'Cannot detach while an evaluation is still pending.');
        const session = this.session;
        if (!session) { this.disposed = true; return; }
        try { await session.detach(); }
        catch (error) {
            if (!this.owner.page.isClosed()) throw new CdpEvaluateError('EVALUATE_DETACH_UNCERTAIN', this.errorMessage(error));
        }
        this.removeListeners(session);
        this.session = null;
        this.context = null;
        this.contexts.clear();
        this.disposed = true;
    }

    private static validateOwner(owner: CdpEvaluateOwner): void {
        if (!owner || typeof owner.pageId !== 'string' || !owner.pageId || owner.pageId.length > 128)
            throw new CdpEvaluateError('EVALUATE_OWNER', 'A bounded exact owning pageId is required.');
        if (!owner.page || typeof owner.page.context !== 'function' || typeof owner.page.mainFrame !== 'function')
            throw new CdpEvaluateError('EVALUATE_OWNER', 'The actual owning public Playwright Page is required.');
    }

    private async initialize(): Promise<void> {
        if (this.owner.page.isClosed()) throw new CdpEvaluateError('EVALUATE_PAGE_CLOSED', 'The owning Page is closed.');
        this.session = await this.owner.page.context().newCDPSession(this.owner.page);
        this.installListeners(this.session);
        try {
            const tree = await this.session.send('Page.getFrameTree');
            this.nativeFrameId = tree.frameTree.frame.id;
            await this.session.send('Page.enable');
            await this.session.send('Runtime.enable');
            this.assertReady();
        } catch (error) {
            await this.dispose();
            throw error;
        }
    }

    private installListeners(session: CDPSession): void {
        session.on('Runtime.executionContextCreated', this.onCreated);
        session.on('Runtime.executionContextDestroyed', this.onDestroyed);
        session.on('Runtime.executionContextsCleared', this.onCleared);
        session.on('Page.frameNavigated', this.onNavigated);
        session.on('close', this.onClosed);
    }

    private removeListeners(session: CDPSession): void {
        session.off('Runtime.executionContextCreated', this.onCreated);
        session.off('Runtime.executionContextDestroyed', this.onDestroyed);
        session.off('Runtime.executionContextsCleared', this.onCleared);
        session.off('Page.frameNavigated', this.onNavigated);
        session.off('close', this.onClosed);
    }

    private contextCreated(event: any): void {
        const value = event.context;
        if (value?.auxData?.isDefault !== true || typeof value.uniqueId !== 'string' || !value.uniqueId) return;
        const context={id:value.id,uniqueId:value.uniqueId};
        if(this.contexts.size<128||this.contexts.has(value.uniqueId))this.contexts.set(value.uniqueId,context);
        if(value.auxData.frameId===this.nativeFrameId)this.context=context;
    }

    private contextDestroyed(event: any): void {
        for(const [id,context] of this.contexts)if(context.id===event.executionContextId||context.uniqueId===event.executionContextUniqueId)this.contexts.delete(id);
        if (this.context?.id === event.executionContextId || this.context?.uniqueId === event.executionContextUniqueId)
            this.context = null;
    }

    private frameNavigated(event: any): void {
        if (event.frame.parentId) return;
        if (this.nativeFrameId !== event.frame.id) this.context = null;
        this.nativeFrameId = event.frame.id;
    }

    private assertReady(): void {
        if (this.disposed || !this.session) throw new CdpEvaluateError('EVALUATE_DISPOSED', 'Evaluator is detached.');
        if (this.owner.page.isClosed()) throw new CdpEvaluateError('EVALUATE_PAGE_CLOSED', 'Owning Page is closed.');
        if (this.owner.page.mainFrame() !== this.owningFrame)
            throw new CdpEvaluateError('EVALUATE_PAGE_CHANGED', 'Owning main Frame reference changed; no fallback target is used.');
        if (this.inFlight) throw new CdpEvaluateError('EVALUATE_BUSY', 'The prior evaluation is still pending.');
        if (!this.context) throw new CdpEvaluateError('EVALUATE_CONTEXT_UNAVAILABLE', 'Exact default main-frame context is unavailable; no fallback or retry.');
    }

    private preflight(request: CdpEvaluateRequest,exactFrame=false): { script: string; argument: CdpEvaluateJson; maxChars: number } {
        if (!request || typeof request !== 'object' || types.isProxy(request) || Object.getPrototypeOf(request) !== Object.prototype)
            throw new CdpEvaluateError('EVALUATE_INPUT', 'A plain Evaluate request is required.');
        const keys = Object.getOwnPropertyDescriptors(request);
        const allowed = ['pageId', 'script', 'arguments', 'frameId', 'maxResultChars'];
        if (!keys.pageId || !keys.script) throw new CdpEvaluateError('EVALUATE_INPUT', 'Own pageId and script data properties are required.');
        for (const key of Reflect.ownKeys(keys)) {
            if (typeof key !== 'string' || !allowed.includes(key) || !('value' in keys[key]))
                throw new CdpEvaluateError('EVALUATE_INPUT', 'Unsupported option or accessor in Evaluate request.');
        }
        if (request.pageId !== this.owner.pageId) throw new CdpEvaluateError('EVALUATE_WRONG_PAGE', 'PageId is not the exact owning Page.');
        if (request.frameId !== undefined && request.frameId !== null) {
            if(typeof request.frameId!=='string'||!request.frameId||request.frameId.length>256)throw new CdpEvaluateError('EVALUATE_FRAME_MISMATCH','Expected a bounded logical FrameId.');
            if(!exactFrame)throw new CdpEvaluateError('EVALUATE_FRAME_UNSUPPORTED','Explicit FrameId requires an exact owner-resolved selection/document proof; no fallback.');
        }
        if (typeof request.script !== 'string' || !request.script.trim() || request.script.length > 32768 || Buffer.byteLength(request.script, 'utf8') > 65536)
            throw new CdpEvaluateError('EVALUATE_SCRIPT_BUDGET', 'Function source must be nonempty and within 32768 chars / 65536 UTF8 bytes.');
        const maxChars = request.maxResultChars ?? 12000;
        if (!Number.isInteger(maxChars) || maxChars < 1 || maxChars > 65536)
            throw new CdpEvaluateError('EVALUATE_RESULT_BUDGET', 'MaxResultChars must be an integer from 1 to 65536.');
        return { script: request.script, argument: this.cloneArgument(request.arguments === undefined ? null : request.arguments), maxChars };
    }

    private resolveTarget(value:CdpEvaluateFrameTarget,requested:string|null|undefined):CdpEvaluateResolvedTarget {
        if(!value||typeof value.documentKey!=='string'||!value.documentKey||value.documentKey.length>256||!value.selection||typeof value.selection.frame!=='function'||typeof value.selection.describe!=='function'||typeof value.selection.assertCurrent!=='function')
            throw new CdpEvaluateError('EVALUATE_DOCUMENT_PROOF','Exact owner selection and bounded document proof key are required.');
        const descriptor=value.selection.describe(),frame=value.selection.frame();
        if(frame.page()!==this.owner.page||descriptor.pageId!==this.owner.pageId)throw new CdpEvaluateError('EVALUATE_WRONG_FRAME','Resolved Frame belongs to another owning Page.');
        if(frame.isDetached())throw new CdpEvaluateError('EVALUATE_FRAME_DETACHED','Exact owning Frame is detached.');
        if(requested==null?frame!==this.owningFrame:descriptor.frameId!==requested)throw new CdpEvaluateError('EVALUATE_FRAME_MISMATCH','Requested logical FrameId and owner selection disagree; no fallback.');
        if(descriptor.documentState!=='verified'||descriptor.changedDuringRead||typeof descriptor.documentId!=='string'||!descriptor.documentId||descriptor.documentId.length>256)
            throw new CdpEvaluateError('EVALUATE_DOCUMENT_PROOF','Selection must contain the existing verified owner document identity.');
        return {selection:value.selection,frame,frameId:descriptor.frameId,documentId:descriptor.documentId,documentKey:value.documentKey,
            probeKey:'__cdp_evaluate_probe_'+randomUUID(),probeValue:randomUUID(),afterDocumentId:null};
    }

    private async executeFrame(input:object,target:CdpEvaluateResolvedTarget):Promise<CdpEvaluateReceipt> {
        try {
            await target.selection.assertCurrent();
            if(target.frame.isDetached())throw new CdpEvaluateError('EVALUATE_FRAME_DETACHED','Selected Frame detached before harness binding.');
            const installed=await target.frame.evaluate(CdpEvaluator.installFrameProbe,this.probeInput(target));
            if(installed!==true)throw new CdpEvaluateError('EVALUATE_DOCUMENT_PROOF','Exact document marker is unavailable, stale, accessor-backed or mutable; no user source dispatched.');
            const uniqueId=await this.findFrameContext(target);
            await this.session!.send('Runtime.releaseObjectGroup',{objectGroup:this.objectGroup});
            return await this.execute({...input,documentGuard:{documentKey:target.documentKey,documentId:target.documentId,probeKey:target.probeKey,probeValue:target.probeValue}},uniqueId,target.documentId,target);
        } finally {
            // Harness-only cleanup remains conditional inside the document, even if public Frame.evaluate observes a replacement.
            try {
                if(!target.frame.isDetached()&&!this.owner.page.isClosed())await target.frame.evaluate(CdpEvaluator.removeFrameProbe,this.probeInput(target));
            } finally {
                if(this.session&&!this.owner.page.isClosed())await this.session.send('Runtime.releaseObjectGroup',{objectGroup:this.objectGroup});
            }
        }
    }

    private probeInput(target:CdpEvaluateResolvedTarget):{documentKey:string;documentId:string;probeKey:string;probeValue:string} {
        return {documentKey:target.documentKey,documentId:target.documentId,probeKey:target.probeKey,probeValue:target.probeValue};
    }

    private async findFrameContext(target:CdpEvaluateResolvedTarget):Promise<string> {
        const matches:string[]=[];
        for(const context of [...this.contexts.values()]){
            try{
                const reply=await this.session!.send('Runtime.callFunctionOn',{functionDeclaration:CdpEvaluator.checkFrameProbe.toString(),uniqueContextId:context.uniqueId,
                    arguments:[{value:this.probeInput(target)}],awaitPromise:false,returnByValue:true,generatePreview:false,objectGroup:this.objectGroup});
                if(!reply.exceptionDetails&&reply.result.value===true)matches.push(context.uniqueId);
            }catch{/* A context destroyed during this bounded harness-only scan is not a reason to retry user source. */}
        }
        if(matches.length!==1)throw new CdpEvaluateError(matches.length?'EVALUATE_CONTEXT_AMBIGUOUS':'EVALUATE_FRAME_CONTEXT_UNAVAILABLE','Exact nonce-proved public Frame default context is not uniquely available; no URL/name join or main fallback.');
        return matches[0];
    }

    private static readonly installFrameProbe=function(input:{documentKey:string;documentId:string;probeKey:string;probeValue:string}):boolean {
        const proof=Object.getOwnPropertyDescriptor(document,input.documentKey);
        if(!proof||!('value' in proof)||proof.value!==input.documentId||proof.writable!==false||proof.configurable!==false||Object.getOwnPropertyDescriptor(document,input.probeKey))return false;
        Object.defineProperty(document,input.probeKey,{value:input.probeValue,writable:false,configurable:true,enumerable:false});
        return true;
    };

    private static readonly checkFrameProbe=function(input:{documentKey:string;documentId:string;probeKey:string;probeValue:string}):boolean {
        const proof=Object.getOwnPropertyDescriptor(document,input.documentKey),probe=Object.getOwnPropertyDescriptor(document,input.probeKey);
        return !!proof&&'value' in proof&&proof.value===input.documentId&&proof.writable===false&&proof.configurable===false
            &&!!probe&&'value' in probe&&probe.value===input.probeValue&&probe.writable===false&&probe.configurable===true;
    };

    private static readonly removeFrameProbe=function(input:{documentKey:string;documentId:string;probeKey:string;probeValue:string}):void {
        const probe=Object.getOwnPropertyDescriptor(document,input.probeKey);
        if(probe&&'value' in probe&&probe.value===input.probeValue&&probe.configurable===true)delete (document as any)[input.probeKey];
    };

    private cloneArgument(value: unknown): CdpEvaluateJson {
        const budget = { chars: 0, bytes: 0, items: 0 };
        const clone = this.cloneJson(value, 0, [], budget);
        return clone;
    }

    private cloneJson(value: unknown, depth: number, ancestors: object[], budget: { chars: number; bytes: number; items: number }): CdpEvaluateJson {
        if (++budget.items > 1024 || depth > 12) throw new CdpEvaluateError('EVALUATE_ARGUMENT_BUDGET', 'Arguments exceed depth 12 or 1024 items.');
        if (value === null || typeof value === 'boolean' || typeof value === 'number') {
            if (typeof value === 'number' && !Number.isFinite(value)) throw new CdpEvaluateError('EVALUATE_ARGUMENT_JSON', 'Arguments require finite JSON numbers.');
            this.countArgument(JSON.stringify(value), budget);
            return value as null | boolean | number;
        }
        if (typeof value === 'string') {
            if (value.length > 32768) throw new CdpEvaluateError('EVALUATE_ARGUMENT_BUDGET', 'Argument string exceeds budget.');
            this.countArgument(JSON.stringify(value), budget);
            return value;
        }
        if (typeof value !== 'object' || types.isProxy(value)) throw new CdpEvaluateError('EVALUATE_ARGUMENT_JSON', 'Arguments require non-proxy JSON data values.');
        if (ancestors.includes(value)) throw new CdpEvaluateError('EVALUATE_ARGUMENT_JSON', 'Circular Arguments are unsupported.');
        return this.cloneContainer(value, depth, [...ancestors, value], budget);
    }

    private cloneContainer(value: object, depth: number, ancestors: object[], budget: { chars: number; bytes: number; items: number }): CdpEvaluateJson {
        const array = Array.isArray(value);
        if (!array && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
            throw new CdpEvaluateError('EVALUATE_ARGUMENT_JSON', 'Arguments require plain JSON objects or arrays.');
        const output: any = array ? [] : Object.create(null);
        this.countArgument(array ? '[]' : '{}', budget);
        let count = 0;
        for (const key of Reflect.ownKeys(value)) {
            if (array && key === 'length') continue;
            const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
            if (!descriptor.enumerable) continue;
            if (typeof key !== 'string' || !('value' in descriptor)) throw new CdpEvaluateError('EVALUATE_ARGUMENT_JSON', 'Argument symbols/accessors are unsupported.');
            if (array && key !== String(count)) throw new CdpEvaluateError('EVALUATE_ARGUMENT_JSON', 'Argument arrays must be dense without extra properties.');
            if (key.length > 32768) throw new CdpEvaluateError('EVALUATE_ARGUMENT_BUDGET', 'Argument property name exceeds budget.');
            if (!array) this.countArgument(JSON.stringify(key) + ':', budget);
            if (count++) this.countArgument(',', budget);
            output[key] = this.cloneJson(descriptor.value, depth + 1, ancestors, budget);
        }
        if (array && count !== (value as unknown[]).length) throw new CdpEvaluateError('EVALUATE_ARGUMENT_JSON', 'Sparse argument arrays are unsupported.');
        return output;
    }

    private countArgument(token: string, budget: { chars: number; bytes: number }): void {
        budget.chars += token.length;
        budget.bytes += Buffer.byteLength(token, 'utf8');
        if (budget.chars > 32768 || budget.bytes > 65536)
            throw new CdpEvaluateError('EVALUATE_ARGUMENT_BUDGET', 'Serialized Arguments exceed 32768 chars / 65536 UTF8 bytes.');
    }

    private async execute(input: object, uniqueContextId: string, documentIdBefore: string | null,target?:CdpEvaluateResolvedTarget): Promise<CdpEvaluateReceipt> {
        try {
            const reply = await this.session!.send('Runtime.callFunctionOn', {
                functionDeclaration: CdpEvaluator.browserEvaluate.toString(), uniqueContextId,
                arguments: [{ value: input }], awaitPromise: true, returnByValue: true,
                generatePreview: false, userGesture: false, objectGroup: this.objectGroup,
            });
            await this.session!.send('Runtime.releaseObjectGroup', { objectGroup: this.objectGroup });
            if(target){try{target.afterDocumentId=(await target.selection.assertCurrent()).documentId;}catch{target.afterDocumentId=null;}}
            if (reply.exceptionDetails) return this.receipt(documentIdBefore, { outcome: 'execution-error', error: { code: 'EVALUATE_WRAPPER_EXCEPTION', message: 'Browser wrapper failed after execution may have begun; no rollback or retry.' } },target);
            if (typeof reply.result.value !== 'string') return this.receipt(documentIdBefore, { outcome: 'execution-error', error: { code: 'EVALUATE_VALUE_UNAVAILABLE', message: 'No bounded by-value browser receipt was available.' } },target);
            return this.decode(reply.result.value, documentIdBefore,target);
        } catch (error) {
            return this.receipt(documentIdBefore, { outcome: 'execution-error', error: { code: 'EVALUATE_EXECUTION_UNCERTAIN', message: this.errorMessage(error) } },target);
        }
    }

    private decode(text: string, before: string | null,target?:CdpEvaluateResolvedTarget): CdpEvaluateReceipt {
        if (text.length > 150000 || Buffer.byteLength(text) > 300000) throw new CdpEvaluateError('EVALUATE_RECEIPT_BUDGET', 'Browser receipt exceeds wrapper bounds.');
        const payload = JSON.parse(text);
        if (payload.outcome === 'returned') {
            payload.result = { state: payload.json === null ? 'omitted' : 'projected', serialization: payload.serialization };
            if (payload.json !== null) payload.result.value = JSON.parse(payload.json);
            delete payload.json;
            delete payload.serialization;
        }
        return this.receipt(before, payload,target);
    }

    private receipt(before: string | null, payload: any,target?:CdpEvaluateResolvedTarget): CdpEvaluateReceipt {
        const after = target?target.afterDocumentId:this.documentId();
        return { ...payload, pageId: this.owner.pageId, ...(target?{frameId:target.frameId}:{}), documentIdBefore: before, documentIdAfter: after,
            documentChanged: before === null || after === null ? null : before !== after,
            mayHaveSideEffects: true, rollbackPerformed: false };
    }

    private documentId(): string | null {
        try {
            const value = this.owner.getDocumentId?.();
            return typeof value === 'string' && value.length <= 128 ? value : null;
        } catch { return null; }
    }

    private errorMessage(error: unknown): string {
        return error instanceof Error ? error.message.slice(0, 2000) : 'Execution failed; underlying completion or side effects may be uncertain.';
    }

    /** This function and its nested class execute ONLY inside Chrome. No Node eval, handles or remote object IDs. */
    private static readonly browserEvaluate = async function(input: any): Promise<string> {
        class BrowserProjection {
            readonly quote = JSON.stringify;
            readonly descriptor = Object.getOwnPropertyDescriptor;
            readonly prototype = Object.getPrototypeOf;
            readonly array = Array.isArray;
            readonly finite = Number.isFinite;
            readonly stringSlice = Function.call.bind(String.prototype.slice);
            readonly charCode = Function.call.bind(String.prototype.charCodeAt);
            readonly objectPrototype = Object.prototype;
            readonly promisePrototype = Promise.prototype;
            readonly nodePrototype = typeof Node === 'undefined' ? null : Node.prototype;
            readonly evaluator = eval;
            text = '';
            bytes = 0;
            items = 0;
            truncated = false;
            issues: string[] = [];
            ancestors: object[] = [];
            readonly limit: number;
            constructor(limit: number) { this.limit = limit; }

            issue(reason: string): void {
                this.truncated = true;
                if (this.issues.length < 16) this.issues[this.issues.length] = reason;
            }

            utf8(text: string): number {
                let bytes = 0;
                for (let i = 0; i < text.length; i++) {
                    const code = this.charCode(text, i);
                    if (code < 128) bytes++; else if (code < 2048) bytes += 2;
                    else if (code >= 0xD800 && code <= 0xDBFF && i + 1 < text.length && this.charCode(text, i + 1) >= 0xDC00 && this.charCode(text, i + 1) <= 0xDFFF) { bytes += 4; i++; }
                    else bytes += 3;
                }
                return bytes;
            }

            write(token: string, reserve: number): boolean {
                const bytes = this.utf8(token);
                if (this.text.length + token.length + reserve > this.limit || this.bytes + bytes + reserve > 65536) return false;
                this.text += token;
                this.bytes += bytes;
                return true;
            }

            tag(reason: string, reserve: number): boolean {
                this.issue(reason);
                return this.write('{"$cdpType":' + this.quote(reason) + '}', reserve);
            }

            string(value: string, reserve: number): boolean {
                let token = '"';
                let bytes = 1;
                let index = 0;
                for (; index < value.length; index++) {
                    const code = this.charCode(value, index);
                    const pair = code >= 0xD800 && code <= 0xDBFF && index + 1 < value.length && this.charCode(value, index + 1) >= 0xDC00 && this.charCode(value, index + 1) <= 0xDFFF;
                    const part = this.stringSlice(value, index, index + (pair ? 2 : 1));
                    const escaped = this.stringSlice(this.quote(part), 1, -1);
                    const size = this.utf8(escaped);
                    if (this.text.length + token.length + escaped.length + 1 + reserve > this.limit || this.bytes + bytes + size + 1 + reserve > 65536) break;
                    token += escaped; bytes += size;
                    if (pair) index++;
                }
                if (index < value.length) this.issue('string-truncated');
                return this.write(token + '"', reserve);
            }

            value(value: any, depth: number, reserve: number): boolean {
                if (++this.items > 512) return this.tag('item-limit', reserve);
                if (depth > 10) return this.tag('depth-limit', reserve);
                if (value === null) return this.write('null', reserve);
                const type = typeof value;
                if (type === 'string') return this.string(value, reserve);
                if (type === 'boolean') return this.write(value ? 'true' : 'false', reserve);
                if (type === 'number') return this.finite(value) ? this.write('' + value, reserve) : this.tag('nonfinite-number', reserve);
                if (type !== 'object') return this.tag(type, reserve);
                for (let i = 0; i < this.ancestors.length; i++) if (this.ancestors[i] === value) return this.tag('circular', reserve);
                return this.object(value, depth, reserve);
            }

            special(value: object): string | null {
                let prototype = this.prototype(value);
                if (prototype === null || prototype === this.objectPrototype || this.array(value)) return null;
                for (let i = 0; prototype && i < 32; i++, prototype = this.prototype(prototype)) {
                    if (prototype === this.promisePrototype) return 'promise';
                    if (prototype === this.nodePrototype) return 'dom-node';
                }
                return 'unsupported-object';
            }

            object(value: any, depth: number, reserve: number): boolean {
                const special = this.special(value);
                if (special) return this.tag(special, reserve);
                const array = this.array(value);
                if (!this.write(array ? '[' : '{', reserve + 1)) return false;
                this.ancestors[this.ancestors.length] = value;
                if (array) this.arrayValues(value, depth, reserve + 1);
                else this.objectValues(value, depth, reserve + 1);
                this.ancestors.length--;
                return this.write(array ? ']' : '}', reserve);
            }

            arrayValues(value: any[], depth: number, reserve: number): void {
                const length = this.descriptor(value, 'length')?.value;
                for (let i = 0; i < length; i++) {
                    if (this.items >= 512) { this.issue('item-limit'); break; }
                    const descriptor = this.descriptor(value, '' + i);
                    if (!this.item(descriptor, null, i > 0, depth, reserve)) break;
                }
            }

            objectValues(value: object, depth: number, reserve: number): void {
                let count = 0;
                for (const key in value) {
                    const descriptor = this.descriptor(value, key);
                    if (!descriptor?.enumerable) continue;
                    if (this.items >= 512) { this.issue('item-limit'); break; }
                    if (key.length > 1024) { this.issue('key-omitted'); continue; }
                    if (!this.item(descriptor, key, count > 0, depth, reserve)) break;
                    count++;
                }
            }

            item(descriptor: PropertyDescriptor | undefined, key: string | null, comma: boolean, depth: number, reserve: number): boolean {
                const before = this.text.length, bytes = this.bytes;
                let valid = !comma || this.write(',', reserve + 4);
                if (valid && key !== null) valid = this.write(this.quote(key) + ':', reserve + 4);
                if (valid) valid = descriptor === undefined ? this.tag('array-hole', reserve)
                    : 'value' in descriptor ? this.value(descriptor.value, depth + 1, reserve) : this.tag('accessor', reserve);
                if (!valid) { this.text = this.stringSlice(this.text, 0, before); this.bytes = bytes; this.issue('result-limit'); }
                return valid;
            }

            error(error: any): string {
                let name = 'ThrownValue', message = 'Page code threw a non-string value.';
                if (typeof error === 'string') message = this.stringSlice(error, 0, 1000);
                else if (error && (typeof error === 'object' || typeof error === 'function')) {
                    const data = this.descriptor(error, 'message');
                    if (data && 'value' in data && typeof data.value === 'string') message = this.stringSlice(data.value, 0, 1000);
                    const prototype = this.prototype(error);
                    const tag = prototype && this.descriptor(prototype, 'name');
                    if (tag && 'value' in tag && typeof tag.value === 'string') name = this.stringSlice(tag.value, 0, 100);
                }
                return '{"outcome":"javascript-error","error":{"code":"EVALUATE_JAVASCRIPT_EXCEPTION","name":' + this.quote(name) + ',"message":' + this.quote(message) + '}}';
            }

            finish(value: any): string {
                const projected = this.value(value, 0, 0);
                if (!projected) { this.text = ''; this.bytes = 0; this.issue('result-limit'); }
                let issues = '';
                for (let i = 0; i < this.issues.length; i++) issues += (i ? ',' : '') + this.quote(this.issues[i]);
                return '{"outcome":"returned","json":' + (projected ? this.quote(this.text) : 'null')
                    + ',"serialization":{"policy":"descriptor-json-v1","truncated":' + this.truncated + ',"issues":[' + issues
                    + '],"chars":' + this.text.length + ',"utf8Bytes":' + this.bytes + ',"maxChars":' + this.limit + ',"maxUtf8Bytes":65536}}';
            }
        }
        const projection = new BrowserProjection(input.maxChars);
        let value: any;
        if(input.documentGuard){
            const guard=input.documentGuard,proof=projection.descriptor(document,guard.documentKey),probe=projection.descriptor(document,guard.probeKey);
            if(!proof||!('value' in proof)||proof.value!==guard.documentId||proof.writable!==false||proof.configurable!==false
                ||!probe||!('value' in probe)||probe.value!==guard.probeValue||probe.writable!==false||probe.configurable!==true)
                return '{"outcome":"execution-error","userFunctionInvoked":false,"error":{"code":"EVALUATE_DOCUMENT_MISMATCH","message":"Exact owner document/context proof changed before invocation; user source was not compiled or invoked."}}';
            if(!delete (document as any)[guard.probeKey])return '{"outcome":"execution-error","userFunctionInvoked":false,"error":{"code":"EVALUATE_PROBE_UNAVAILABLE","message":"Owned temporary context proof could not be consumed; user source not invoked."}}';
        }
        try {
            // Compiles and invokes ONLY in this exact Chrome default context. Not a sandbox.
            const callable = (0, projection.evaluator)('(' + input.script + '\n)');
            if (typeof callable !== 'function') throw new TypeError('Script must evaluate to JavaScript function source.');
            value = await callable(input.argument);
        } catch (error) {
            try { return projection.error(error); }
            catch { return '{"outcome":"javascript-error","error":{"code":"EVALUATE_JAVASCRIPT_EXCEPTION","message":"Thrown value could not be inspected without additional failure."}}'; }
        }
        try { return projection.finish(value); }
        catch { return '{"outcome":"execution-error","error":{"code":"EVALUATE_PROJECTION_FAILED","message":"Page code returned, but result inspection failed. Proxy traps or modified intrinsics may have run. No rollback or retry."}}'; }
    };
}
