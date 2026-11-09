import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { CdpContract, CdpContractError } from './cdp-contract.mts';
import type { CdpCommand, CdpContext, CdpErrorEnvelope, CdpJsonObject, CdpReply, CdpWireCommand } from './cdp-contract.mts';
import { CdpBrowserSession } from './cdp-browser.mts';
import type { CdpBrowserSettings, CdpOwnedCleanup } from './cdp-browser.mts';
import type { CdpJournalEntry, CdpStore } from './cdp-store.mts';
import { CdpArtifacts } from './cdp-artifacts.mts';
import type { CdpImageTransfer } from './cdp-artifacts.mts';
import {CdpDialogError} from './cdp-dialogs.mts';
import {CdpNetworkError} from './cdp-network.mts';
import {CdpFileError} from './cdp-files.mts';
import {CdpEvaluateError} from './cdp-evaluate.mts';
import {CdpViewportError} from './cdp-viewport.mts';
import {CdpReloadError} from './cdp-reload.mts';
import {CdpProjectFiles} from './cdp-project-files.mts';
import {CdpArtifactReadError} from './cdp-artifact-reader.mts';
import {CdpTraceExport} from './cdp-trace-export.mts';
import {CdpTraceError} from './cdp-trace.mts';
import {CdpFramesError} from './cdp-frames.mts';
import {CdpObservationError} from './cdp-observation.mts';
import {CdpErrorDiagnostics} from './cdp-error-diagnostics.mts';

export interface CdpClientResponse { readonly success: boolean; readonly msg: string; readonly cdp: CdpReply; readonly transfer?: CdpImageTransfer; }
export interface CdpDiagnosticOwner {ordinaryFill(command:CdpCommand,proof:CdpJsonObject,value:string):void;}
export interface CdpClientOptions { readonly store: CdpStore; readonly artifacts: CdpArtifacts; readonly browser: CdpBrowserSettings; }

class CdpNamedOperation {
    readonly callId: string;
    readonly op: CdpCommand['op'];
    readonly context: CdpContext;
    readonly signature: string;
    readonly sessionId: string | null;
    readonly pageId: string | null;
    readonly acceptedAt = Date.now();
    readonly #manager: CdpClientManager;
    readonly entry: CdpJournalEntry | null;
    readonly redactLogs:boolean;
    #command: CdpCommand | null;
    finished = false;
    result: CdpJsonObject | null = null;
    error: CdpErrorEnvelope | null = null;
    artifactId: string | null = null;
    documentId: string | null = null;
    constructor(manager: CdpClientManager, command: CdpCommand, signature: string, entry: CdpJournalEntry | null) {
        this.redactLogs=manager.diagnosticLogRedaction(command);
        this.#manager = manager; this.#command = command; this.entry = entry;
        this.callId = command.callId; this.op = command.op; this.context = command.context; this.signature = signature;
        this.sessionId = command.sessionId; this.pageId = command.pageId;
    }
    start(): void { queueMicrotask(() => { void this.#run(); }); }
    async #run(): Promise<void> {
        try { await this.#manager.runOperation(this.#command!,this); }
        catch (error) { this.error = this.#manager.operationFailure(this.#command!,this.entry,error); }
        finally { this.#command = null; this.finished = true; }
    }
}

// Owned browser/journal manager. The feature bridge captures the existing configured client identity.
// An optional exact loopback origin restricts owned QC. Production admits ordinary HTTP/HTTPS URLs.
export class CdpClientManager {
    readonly #store: CdpStore;
    readonly #artifacts: CdpArtifacts;
    readonly #browser: CdpBrowserSettings;
    readonly #sessions = new Map<string,CdpBrowserSession>();
    readonly #operations = new Map<string,CdpNamedOperation>();
    readonly #signatureKey = randomBytes(32);
    readonly #errorFacts=new CdpErrorDiagnostics();
    #diagnosticOwner:CdpDiagnosticOwner|null=null;
    readonly #executableVersion: string | null;
    constructor(options: CdpClientOptions) {
        this.#store = options.store; this.#artifacts = options.artifacts; this.#browser = Object.freeze({...options.browser});
        if (this.#browser.fixtureOrigin !== undefined) {
            const origin = new URL(this.#browser.fixtureOrigin);
            if (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1' || !origin.port || origin.origin !== this.#browser.fixtureOrigin) throw new CdpContractError('FIXTURE_ORIGIN_REQUIRED','QC restriction must be an exact trusted owned loopback fixture origin.');
        }
        if (!path.isAbsolute(this.#browser.executablePath) || !fs.statSync(this.#browser.executablePath).isFile()) throw new CdpContractError('BROWSER_UNAVAILABLE','Configured installed Chrome executable is unavailable.');
        this.#executableVersion = CdpBrowserSession.executableVersion(this.#browser.executablePath);
    }
    attachDiagnosticOwner(owner:CdpDiagnosticOwner):void{if(this.#diagnosticOwner&&this.#diagnosticOwner!==owner)throw new CdpContractError('INVALID_TRANSITION','Diagnostic owner is already captured.');this.#diagnosticOwner=owner;}
    async execute(value: unknown): Promise<CdpClientResponse> {
        // Validation errors deliberately propagate before a correlated reply exists. Shared transport is not yet integrated.
        const wire = CdpContract.validate(value,this.#store.limits), command = wire.cdp;
        this.#binding(command);
        try {
            if (CdpContract.isMutation(command.op)) return this.#mutation(wire);
            switch (command.op) {
                case 'GetCapabilities': return this.#response(command,{result:this.#capabilities()});
                case 'GetSessions': return this.#sessionsReply(command);
                case 'GetPages': return this.#pagesReply(command);
                case 'GetAction': return this.#lookup(command,this.#store.getAction(command.sessionId ?? '',command.args.idKind as 'action'|'creation',command.args.id as string,command.context));
                case 'GetCall': return this.#getCall(command);
                case 'Observe': case 'Screenshot': case 'InspectElement': case 'GetNetworkExchange': case 'ExportTrace': return this.#readOperation(wire);
                case 'WaitFor': {
                    const retained=this.#store.getWatch(command.sessionId!,command.args.watchId as string,command.context);
                    if(command.context.access==='parentInspect'||retained.state!=='armed')return this.#response(command,{result:{watch:{...retained,state:retained.state==='armed'?'timedOut':retained.state,retainedInspectionOnly:command.context.access==='parentInspect'}}});
                    return this.#readOperation(wire);
                }
                case 'CancelWatch':{const retained=this.#store.getWatch(command.sessionId!,command.args.watchId as string,command.context);return this.#response(command,{result:{watch:retained.state!=='armed'?retained:this.#liveSession(command).watches.cancel(command.args.watchId as string,command.context)}});}
                case 'ReadEvents':{const result=this.#store.readCanonicalEvents(command.sessionId!,command.pageId,command.context,command.args);return this.#response(command,{result,nextCursor:result.nextCursor as string,gap:result.gap===true});}
                case 'ReadArtifact': {const read=await this.#artifacts.readRetainedArtifact(command.sessionId!,command.args,command.context);return this.#response(command,{result:read.result,transfer:read.transfer});}
            }
        } catch (error) { return this.#response(command,{error:this.#error(error,'admission')}); }
    }
    #mutation(wire: CdpWireCommand): CdpClientResponse {
        const command = wire.cdp, existing = this.#operations.get(command.callId);
        if (existing && existing.signature !== this.#signature(command)) throw new CdpContractError('ID_CONFLICT','Call identity is already bound to different input.');
        const dialogOwner=command.op==='HandleDialog'?this.#sessions.get(command.sessionId!)?.pages().find(page=>page.id===command.pageId):undefined;
        const accepted = this.#store.accept(wire,dialogOwner);
        if (accepted.isNew) this.#start(command,accepted.entry);
        return this.#lookup(command,accepted.entry);
    }
    #readOperation(wire: CdpWireCommand): CdpClientResponse {
        const command = wire.cdp;
        if(command.op==='ExportTrace'){this.#store.getSession(command.sessionId!,command.context);if(command.pageId)this.#store.getPage(command.sessionId!,command.pageId,command.context);if(command.context.access!=='owner')throw new CdpContractError('OWNERSHIP_DENIED','Exact parents may read existing trace artifacts; this initial trace creation adapter is owner-only.');}else if(command.op==='Observe'&&(command.args.options as any).cursor!==null){this.#store.getPage(command.sessionId!,command.pageId!,command.context);this.#retainedSession(command).page(command.pageId!);}else if(command.op==='GetNetworkExchange'){this.#store.getPage(command.sessionId!,command.pageId!,command.context);this.#retainedSession(command).page(command.pageId!);}else if(command.op!=='WaitFor')this.#liveSession(command).page(command.pageId!);else this.#liveSession(command);
        const operation = this.#operations.get(command.callId);
        if (operation) {
            this.#authorizeOperation(operation,command.context);
            if (operation.signature !== this.#signature(command)) throw new CdpContractError('ID_CONFLICT','Call is bound to different normalized input.');
        } else this.#start(command,null);
        return this.#operationReply(command,this.#operations.get(command.callId)!);
    }
    #start(command: CdpCommand, entry: CdpJournalEntry | null): void {
        this.#trimOperations();
        if (this.#operations.size >= 256) {
            if (entry) this.#store.finishWithoutCompletion(entry.reference,command.context,'failedBeforeDispatch','OPERATION_CAPACITY');
            throw new CdpContractError('OPERATION_CAPACITY','Retained operation capacity is exhausted.');
        }
        if (this.#operations.has(command.callId)) throw new CdpContractError('ID_CONFLICT','Call identity already exists.');
        const operation = new CdpNamedOperation(this,command,this.#signature(command),entry);
        this.#operations.set(command.callId,operation); operation.start();
    }
    #getCall(command: CdpCommand): CdpClientResponse {
        const callId = command.args.callId as string;
        const operation = this.#operations.get(callId);
        if (operation) {
            this.#authorizeOperation(operation,command.context);
            this.#queryScope(command,operation.sessionId);
            if (!operation.entry) return this.#operationReply(command,operation);
        }
        const entry=this.#store.getCall(callId,command.context);
        this.#queryScope(command,entry.sessionId);
        return this.#lookup(command,entry);
    }
    #queryScope(command:CdpCommand,sessionId:string|null):void {
        if(command.sessionId!==null && command.sessionId!==sessionId)throw new CdpContractError('OWNERSHIP_DENIED','Retained call does not belong to the explicit session handle.');
    }
    #lookup(command: CdpCommand, entry: CdpJournalEntry): CdpClientResponse {
        const operation = this.#operations.get(entry.callId);
        const state = entry.receipt.state, successful = state === 'completed';
        const result: CdpJsonObject = { originalCallId:entry.callId,originalOperation:entry.op,operationState:state,payloadExpired:entry.payloadExpired,
            mechanicsSettled:operation?.finished===true&&operation.context.clientIncarnationId===this.#store.clientIdentity.clientIncarnationId,
            evidence:entry.evidence as CdpJsonObject ?? null,uncertainty:entry.uncertainty as CdpJsonObject ?? null };
        if (operation?.result && !entry.payloadExpired){if(command.context.access==='parentInspect'&&operation.result.fillDiagnostic){const {fillDiagnostic,...retained}=operation.result;result.output=retained;}else result.output=operation.result;}
        if(operation?.pageId&&operation.sessionId&&!entry.payloadExpired){const page=this.#sessions.get(operation.sessionId)?.pages().find(value=>value.id===operation.pageId);if(page)result.currentPageState=page.describe();}
        const error = operation?.error ?? (entry.errorCode ? { code:entry.errorCode,message:'Retained operation did not produce a definitive successful completion.',phase:'journal',retryDisposition:'doNotRetry' as const,details:null } : null);
        return this.#response(command,{result,error,entry,documentId:operation?.documentId ?? null,ok:successful || state === 'accepted' || state === 'dispatchStarted',redactLogs:operation?.redactLogs??true});
    }
    #operationReply(command: CdpCommand, operation: CdpNamedOperation): CdpClientResponse {
        const result: CdpJsonObject = {originalCallId:operation.callId,originalOperation:operation.op,mechanicsSettled:operation.finished&&operation.context.clientIncarnationId===this.#store.clientIdentity.clientIncarnationId,operationState:operation.finished ? operation.error ? 'failed' : 'completed' : 'pending',output:operation.result};
        const transfer = operation.finished && !operation.error && operation.artifactId ? this.#artifacts.readImage(operation.artifactId,command.context) : undefined;
        return this.#response(command,{result,error:operation.error,documentId:operation.documentId,sessionId:operation.sessionId,pageId:operation.pageId,transfer,redactLogs:operation.redactLogs});
    }
    async runOperation(command: CdpCommand, operation: CdpNamedOperation): Promise<void> {
        if (!operation.entry) {
            if(command.op==='ExportTrace'){operation.result=await new CdpTraceExport(this.#store,this.#artifacts).export(command);return;}
            if(command.op==='GetNetworkExchange'){const page=this.#retainedSession(command).page(command.pageId!);operation.result={exchange:await page.getNetworkExchange(command.args.networkRequestId as string,command.args.options as any) as CdpJsonObject};return;}
            const session=command.op==='Observe'&&(command.args.options as any).cursor!==null?this.#retainedSession(command):this.#liveSession(command);
            if(command.op==='WaitFor'){operation.result={watch:await session.watches.wait(command.args.watchId as string,command.context,command.args.timeoutMs as number)};return;}
            const page=session.page(command.pageId!);
            operation.documentId = page.documentId;
            if(command.op==='InspectElement')operation.result=session.redact(await page.inspect(command.args));
            else if (command.op === 'Observe') operation.result = await page.observe(command.args,command.context.access);
            else {
                const captured = await page.screenshot(command.args),bytes=captured.bytes;
                const image = this.#artifacts.saveImage(bytes,{mime:captured.metadata.mimeType,maximumDimension:(command.args.options as any).maxDimension},command.sessionId!,command.pageId!,command.context);
                operation.documentId=captured.metadata.selectedDocumentId;
                operation.artifactId = (command.args.options as any).attachImage ? image.artifact.artifactId : null; operation.result = { image:image as unknown as CdpJsonObject,capture:captured.metadata as CdpJsonObject,attachmentState:'internal bytes only; provider integration pending' };
            }
            operation.documentId = command.op==='Observe'?operation.result?.documentId as string|null:command.op==='InspectElement'?(operation.result?.target as any)?.documentId??null:operation.documentId;
            return;
        }
        this.#preflight(command);
        if(command.op==='Evaluate'){await this.#runEvaluate(command,operation);return;}
        if(command.op==='SetInputFiles'){await this.#runFiles(command,operation);return;}
        if(command.op==='HandleDialog'){await this.#runHandleDialog(command,operation);return;}
        if(command.op==='Reload'){await this.#runReload(command,operation);return;}
        if(['ClosePage','SetViewport'].includes(command.op)){await this.#runPageLifecycle(command,operation);return;}
        if(['Navigate','Click','Fill','PressKey','Hover','SelectOptions','SetChecked','Scroll','DragAndDrop'].includes(command.op)){await this.#runPageInput(command,operation);return;}
        this.#store.markDispatchStarted(operation.entry.reference,command.context,'playwright.' + command.op);
        switch (command.op) {
            case 'CreateSession': await this.#createSession(command,operation); break;
            case 'CreatePage': {
                const page = await this.#liveSession(command).createPage();
                this.#store.complete(operation.entry.reference,command.context,{pageId:page.id});page.commitEvents(); operation.documentId = page.documentId; operation.result = page.describe(); break;
            }
            case 'CreateWatch': {
                const session=this.#liveSession(command),watch=await session.watches.install(command);
                try{this.#store.complete(operation.entry.reference,command.context,watch.evidence());watch.recorded();if(watch.journalError)throw watch.journalError;}
                catch(error){watch.dispose();throw error;}
                operation.documentId=watch.documentId;operation.result={watch:this.#store.getWatch(session.id,watch.id,command.context),armed:true,inputDispatched:false};break;
            }
            case 'Navigate': {
                const page = this.#liveSession(command).page(command.pageId!);
                operation.result = await page.navigate(command.args); operation.documentId = page.documentId;
                this.#store.complete(operation.entry.reference,command.context); break;
            }
            case 'CloseSession': {
                const session = this.#liveSession(command);
                const deadline = setTimeout(() => this.#closeDeadline(command,operation),command.args.timeoutMs as number);
                try {
                    const cleanup = await session.close();
                    if (cleanup?.browserExited !== true || cleanup?.hostExited !== true || cleanup?.generatedProfileRemoved !== true || cleanup?.privateTemporaryRootRemoved !== true)
                        throw new CdpContractError('OWNED_CLEANUP_UNCERTAIN','All four owned cleanup proofs must be verified before releasing journal resources.');
                    this.#store.complete(operation.entry.reference,command.context);
                    operation.error = null; operation.result = {sessionId:session.id,cleanup:cleanup as unknown as CdpJsonObject,observationCleanup:session.disposeObservation()};
                } finally { clearTimeout(deadline); }
                break;
            }
        }
    }
    async #runPageInput(command:CdpCommand,operation:CdpNamedOperation):Promise<void> {
        const session=this.#liveSession(command),page=session.page(command.pageId!),release=page.reserveInput();
        try {
            const prepared=command.op==='Navigate'?null:await page.prepareInput(command.op,command.args);
            if(prepared?.sensitive)session.noteSensitive(command.args.value as string);
            const evidence=prepared?{target:prepared.identity,...(prepared.destinationIdentity?{destinationTarget:prepared.destinationIdentity}:{})}:{};
            this.#store.markDispatchStarted(operation.entry!.reference,command.context,'playwright.'+command.op,evidence);
            const end=page.beginMechanicalInput(command.callId,command.actionId!,prepared?.identity.documentId??page.documentId,prepared?.identity.frameId??page.mainFrameId);
            try{operation.result=prepared?await prepared.dispatch():await page.navigate(command.args);}finally{end();}
            if(command.op==='Fill'&&operation.result.fillDiagnostic&&session.redact(command.args.value)!==command.args.value){const {fillDiagnostic,...retained}=operation.result;operation.result=retained;}
            operation.documentId=prepared?.identity.documentId??page.documentId;
            operation.result={...operation.result,postAction:{page:page.describe(),inputMechanicsOnly:true}};
            this.#store.complete(operation.entry!.reference,command.context,evidence);
            if(command.op==='Fill'&&operation.result.fillDiagnostic&&!operation.redactLogs)this.#diagnosticOwner?.ordinaryFill(command,operation.result.fillDiagnostic as CdpJsonObject,command.args.value as string);
        }finally{release();}
    }
    async #runEvaluate(command:CdpCommand,operation:CdpNamedOperation):Promise<void>{
        const page=this.#liveSession(command).page(command.pageId!),release=page.reserveInput();let deadline:NodeJS.Timeout|null=null;
        try{
            const target=await page.prepareEvaluation(command.args.frameId as string|null);await target.selection.assertCurrent();
            this.#store.markDispatchStarted(operation.entry!.reference,command.context,'cdp.Runtime.callFunctionOn');
            const end=page.beginMechanicalInput(command.callId,command.actionId!,target.selection.describe().documentId,target.selection.describe().frameId);
            deadline=setTimeout(()=>this.#evaluateDeadline(command,operation),command.args.timeoutMs as number);
            try{operation.result={evaluation:await page.evaluate(command.args,target) as unknown as CdpJsonObject};}finally{end();}
            operation.documentId=target.selection.describe().documentId;
            const outcome=(operation.result.evaluation as CdpJsonObject).outcome;
            if(outcome!=='returned')throw new CdpContractError(outcome==='javascript-error'?'EVALUATE_JAVASCRIPT_EXCEPTION':'EVALUATE_EXECUTION_UNCERTAIN','Page code may have applied effects; inspect retained evaluation result. No replay or rollback.');
            this.#store.complete(operation.entry!.reference,command.context);operation.error=null;
        }finally{if(deadline)clearTimeout(deadline);release();}
    }
    #evaluateDeadline(command:CdpCommand,operation:CdpNamedOperation):void{
        try{const entry=this.#store.get(operation.entry!.reference,command.context);if(entry.receipt.state==='dispatchStarted')this.#store.finishWithoutCompletion(entry.reference,command.context,'uncertain','EVALUATE_DEADLINE_ELAPSED');operation.error={code:'EVALUATE_DEADLINE_ELAPSED',message:'The actual evaluation is still pending; inspect this original GetCall. No cancellation or retry occurred.',phase:'execution',retryDisposition:'doNotRetry',details:null};}
        catch{operation.error={code:'JOURNAL_OUTCOME_UNAVAILABLE',message:'Evaluation deadline could not be durably recorded.',phase:'journal',retryDisposition:'doNotRetry',details:null};}
    }
    async #runFiles(command:CdpCommand,operation:CdpNamedOperation):Promise<void>{
        const page=this.#liveSession(command).page(command.pageId!),release=page.reserveInput();let prepared:any=null,dispatched=false;
        try{
            const paths=await new CdpProjectFiles(this.#browser.virtualRoot).resolve(command.args.files as any);
            prepared=await page.prepareFiles(command.args,paths);const evidence=prepared.target?{target:prepared.target}:{};
            this.#store.markDispatchStarted(operation.entry!.reference,command.context,'playwright.fileInput.setFiles',evidence);dispatched=true;
            const end=page.beginMechanicalInput(command.callId,command.actionId!,page.documentId,page.mainFrameId);
            let applied;try{applied=await page.files.apply(prepared.selection.selectionId);}finally{end();}
            operation.documentId=page.documentId;operation.result={selectionId:applied.selectionId,fileChooserId:applied.chooserId,target:prepared.target,fileTarget:{...applied.target,pageId:page.id,documentId:prepared.documentId,frameId:prepared.frameId},files:applied.observed as unknown as CdpJsonObject,inputDispatched:true,inputMechanicsOnly:true,businessSuccessVerified:false};
            this.#store.complete(operation.entry!.reference,command.context,evidence);
        }finally{if(prepared&&!dispatched)page.files.discardPrepared(prepared.selection.selectionId);release();}
    }
    async #runHandleDialog(command:CdpCommand,operation:CdpNamedOperation):Promise<void>{
        const page=this.#liveSession(command).page(command.pageId!),release=page.reserveDialog(command.args.dialogId as string,command.args.accept as boolean,command.args.promptText as string|null);
        try{const dialog=page.assertDialogControl(command.sessionId!,page.id,command.args.dialogId as string);
            this.#store.markDispatchStarted(operation.entry!.reference,command.context,'playwright.Dialog.resolve',{dialog},page);
            const resolved=await page.resolveDialog(dialog.dialogId,command.args.accept as boolean,command.args.promptText as string|null);
            operation.result={dialog:resolved as unknown as CdpJsonObject,inputDispatched:true,inputMechanicsOnly:true,businessSuccessVerified:false,originalInputReplayed:false,originalUncertaintyReconciled:false,causation:'observed overlap, not verified cause'};operation.documentId=page.documentId;
            this.#store.complete(operation.entry!.reference,command.context,{dialog});
        }finally{release();}
    }
    async #runReload(command:CdpCommand,operation:CdpNamedOperation):Promise<void>{
        const page=this.#liveSession(command).page(command.pageId!),release=page.reserveInput();
        try{
            await page.lifecycle.prepare('Reload',command.args);await page.resolveFrame(null);
            this.#store.markDispatchStarted(operation.entry!.reference,command.context,'cdp.Page.reload');
            const end=page.beginMechanicalInput(command.callId,command.actionId!,page.documentId,page.mainFrameId);
            try{
                const caller=page.reload.reload({pageId:page.id,...command.args} as any),mechanics=page.reload.pendingCompletion();
                const notice=caller.catch(error=>{this.#reloadDeadline(command,operation,error);return null;});
                let result;try{result=await(mechanics??caller);}finally{await notice;}
                const selection=await page.resolveFrame(null);await page.refreshInventory();operation.documentId=selection.describe().documentId;
                operation.result={...result,documentId:operation.documentId,after:{...result.after,documentId:operation.documentId},documentIdSource:'current core Targets proof after native completion',postAction:{page:page.describe(),inputMechanicsOnly:true}} as unknown as CdpJsonObject;
                this.#store.complete(operation.entry!.reference,command.context);operation.error=null;
            }finally{end();}
        }finally{release();}
    }
    #reloadDeadline(command:CdpCommand,operation:CdpNamedOperation,error:unknown):void{
        try{const current=this.#store.get(operation.entry!.reference,command.context);if(current.receipt.state==='dispatchStarted')this.#store.finishWithoutCompletion(current.reference,command.context,'uncertain',error instanceof CdpReloadError?error.code:'RELOAD_OUTCOME_UNCERTAIN');operation.error=this.#error(error,'execution');}
        catch{operation.error={code:'JOURNAL_OUTCOME_UNAVAILABLE',message:'Reload outcome could not be durably recorded.',phase:'journal',retryDisposition:'doNotRetry',details:null};}
    }
    async #runPageLifecycle(command:CdpCommand,operation:CdpNamedOperation):Promise<void>{
        const page=this.#liveSession(command).page(command.pageId!),release=page.reserveInput(command.op==='ClosePage');
        try{
            await page.lifecycle.prepare(command.op,command.args);
            this.#store.markDispatchStarted(operation.entry!.reference,command.context,'playwright.'+command.op);
            const end=page.beginMechanicalInput(command.callId,command.actionId!,page.documentId,page.mainFrameId);
            try{operation.result=await page.lifecycle.dispatch(command.op,command.args);}finally{end();}operation.documentId=page.documentId;
            if(command.op==='ClosePage'){
                if(operation.result.pageId!==page.id||operation.result.pageClosed!==true||operation.result.closedVerified!==true||!page.closed)throw new CdpContractError('PAGE_CLOSE_UNVERIFIED','Exact owned page closure must be verified before releasing capacity.');
                this.#store.complete(operation.entry!.reference,command.context,{pageClose:{pageId:page.id,closed:true}});
            }else this.#store.complete(operation.entry!.reference,command.context);
            operation.result={...operation.result,postAction:{page:page.describe(),inputMechanicsOnly:true}};
        }finally{release();}
    }
    #closeDeadline(command: CdpCommand, operation: CdpNamedOperation): void {
        try {
            const entry = this.#store.get(operation.entry!.reference,command.context);
            if (entry.receipt.state === 'dispatchStarted') {
                this.#store.finishWithoutCompletion(entry.reference,command.context,'uncertain','CLOSE_DEADLINE_ELAPSED');
                operation.error = {code:'CLOSE_DEADLINE_ELAPSED',message:'Owned cleanup is still running. Inspect this same call for a late authoritative result; do not repeat input.',phase:'cleanup',retryDisposition:'doNotRetry',details:null};
            }
        } catch { operation.error = {code:'JOURNAL_OUTCOME_UNAVAILABLE',message:'Close deadline could not be durably classified.',phase:'journal',retryDisposition:'doNotRetry',details:null}; }
    }
    #preflight(command: CdpCommand): void {
        if (command.op === 'CreateSession' && (command.args.options as any).headless !== true) throw new CdpContractError('HEADFUL_UNSUPPORTED','Only isolated headless sessions are supported.');
        if (command.op !== 'CreateSession') this.#liveSession(command);
        if(command.op==='CloseSession'&&[...this.#operations.values()].some(operation=>operation.callId!==command.callId&&operation.sessionId===command.sessionId&&!operation.finished&&operation.op!=='WaitFor'))throw new CdpContractError('PAGE_BUSY','Owned cleanup cannot overlap a still-running named browser operation. Retained uncertainty is not proof mechanics stopped.');
        if(command.op==='CloseSession')this.#liveSession(command).beginCleanupObservations();
        if(command.op==='ClosePage'&&[...this.#operations.values()].some(operation=>operation.callId!==command.callId&&operation.sessionId===command.sessionId&&(operation.pageId===command.pageId||operation.pageId===null)&&!operation.finished&&operation.op!=='WaitFor'))throw new CdpContractError('PAGE_BUSY','Explicit page cleanup cannot overlap unfinished browser mechanics. Active observation waiters do not block cleanup.');
        if (command.op === 'Navigate' && !this.#liveSession(command).permitsUrl(command.args.url as string)) throw new CdpContractError(this.#browser.fixtureOrigin ? 'FIXTURE_ORIGIN_REQUIRED' : 'NAVIGATION_URL_UNSUPPORTED','Navigation URL is outside the admitted HTTP/HTTPS or explicit owned-QC policy.');
    }
    async #createSession(command: CdpCommand, operation: CdpNamedOperation): Promise<void> {
        const session = new CdpBrowserSession(command.context,command.args.options,this.#browser);
        this.#sessions.set(session.id,session);
        try {
            await session.launch();session.initializeObservation(this.#store,this.#artifacts);
            const page=await session.createPage();
            this.#store.complete(operation.entry!.reference,command.context,{sessionId:session.id,pageId:page.id});
            page.commitEvents();operation.documentId=page.documentId;operation.result={...session.describe(),pageId:page.id,initialPage:page.describe(),initialUrl:'about:blank'};
        }catch(error){try{await session.close();}catch(cleanup){throw new AggregateError([error,cleanup],'Owned creation failed and cleanup was not fully verified.');}throw error;}
    }
    operationFailure(command: CdpCommand, entry: CdpJournalEntry | null, error: unknown): CdpErrorEnvelope {
        const classified = this.#error(error,'execution');
        if (entry) {
            try {
                const current = this.#store.get(entry.reference,command.context);
                if (current.receipt.state === 'accepted') this.#store.finishWithoutCompletion(entry.reference,command.context,'failedBeforeDispatch',classified.code);
                else if (current.receipt.state === 'dispatchStarted') this.#store.finishWithoutCompletion(entry.reference,command.context,'uncertain',classified.code);
            } catch { return {code:'JOURNAL_OUTCOME_UNAVAILABLE',message:'Operation outcome could not be durably classified; inspect the retained dispatch state before any new input.',phase:'journal',retryDisposition:'doNotRetry',details:null}; }
        }
        return classified;
    }
    #sessionsReply(command: CdpCommand): CdpClientResponse {
        if(command.sessionId){const retained=this.#store.getSession(command.sessionId,command.context),session=this.#sessions.get(command.sessionId);return this.#response(command,{result:{session:{...retained,...session?.describe(),pages:[...this.#store.listPages(command.sessionId,command.context,null,50).items],available:retained.state==='live'&&session?.describe().available===true,restartReattach:false}}});}
        const list = this.#store.listSessions(command.context,command.args.cursor as string|null,command.args.limit as number);
        const items = list.items.map(item => ({...item,available:this.#sessions.get(item.sessionId)?.describe().available === true && item.state === 'live',restartReattach:false}));
        return this.#response(command,{result:{sessions:items},nextCursor:list.nextCursor});
    }
    async #pagesReply(command: CdpCommand): Promise<CdpClientResponse> {
        const list = this.#store.listPages(command.sessionId!,command.context,command.args.cursor as string|null,command.args.limit as number);
        const session = this.#sessions.get(command.sessionId!);
        if(command.context.access==='owner')await session?.refreshInventory();
        const items = list.items.map(item => { const page = session?.pages().find(page => page.id === item.pageId); return {...item,...(page?.describe() ?? {available:false,documentId:null,pendingDialog:null})}; });
        return this.#response(command,{result:{pages:items},nextCursor:list.nextCursor});
    }
    #retainedSession(command:CdpCommand):CdpBrowserSession{this.#store.getSession(command.sessionId!,command.context);const session=this.#sessions.get(command.sessionId!);if(!session)throw new CdpContractError('SESSION_UNAVAILABLE','No in-process retained resource exists. No replacement, reattachment or replay was attempted.');return session;}
    #liveSession(command: CdpCommand): CdpBrowserSession {
        const retained = this.#store.getSession(command.sessionId!,command.context), session = this.#sessions.get(command.sessionId!);
        if (retained.state !== 'live' || !session) throw new CdpContractError('SESSION_UNAVAILABLE','Session is not owned and live in this process; no attachment or replacement was attempted.');
        return session;
    }
    #binding(command: CdpCommand): void {
        const actual = this.#store.clientIdentity, captured = command.context;
        if (captured.clientName !== actual.clientName || (captured.clientInstallId !== null && captured.clientInstallId !== actual.clientInstallId)) throw new CdpContractError('CLIENT_BINDING_CONFLICT','Command is not bound to this configured installation.');
        if (!CdpContract.isRetainedRead(command.op) && command.op !== 'GetCapabilities' && captured.clientIncarnationId !== actual.clientIncarnationId) throw new CdpContractError('CLIENT_BINDING_CONFLICT','Live operation requires the captured current incarnation.');
        if (command.op === 'GetCapabilities' && captured.clientIncarnationId !== null && captured.clientIncarnationId !== actual.clientIncarnationId) throw new CdpContractError('CLIENT_BINDING_CONFLICT','Discovery carries an incompatible incarnation.');
    }
    #authorizeOperation(operation: CdpNamedOperation, caller: CdpContext): void {
        const owner = operation.context;
        const actor = owner.access === 'parentInspect'
            ? caller.access === 'parentInspect' && CdpContract.isRetainedRead(operation.op) && caller.actorConversationId === owner.actorConversationId && caller.parentConversationId === owner.parentConversationId
            : caller.access === 'owner' ? caller.actorConversationId === owner.actorConversationId && caller.parentConversationId === owner.parentConversationId : owner.parentConversationId !== null && caller.actorConversationId === owner.parentConversationId;
        if (!actor || caller.accountUserId !== owner.accountUserId || caller.clientName !== owner.clientName || caller.clientInstallId !== owner.clientInstallId || caller.clientIncarnationId !== owner.clientIncarnationId) throw new CdpContractError('OWNERSHIP_DENIED','Retained operation is outside the captured account/actor/parent/client binding.');
    }
    #signature(command: CdpCommand): string { return createHmac('sha256',this.#signatureKey).update(CdpContract.canonical(command)).digest('hex'); }
    #trimOperations(): void {
        for (const [id,operation] of this.#operations) if (operation.finished && (Date.now() - operation.acceptedAt >= this.#store.limits.values.evidenceRetentionMs || this.#operations.size >= 240)) this.#operations.delete(id);
    }
    #error(error: unknown, phase: string): CdpErrorEnvelope {
        let envelope:CdpErrorEnvelope;
        if (error instanceof CdpContractError) envelope=error.toEnvelope(phase);
        else if(error instanceof CdpDialogError||error instanceof CdpNetworkError||error instanceof CdpFileError||error instanceof CdpEvaluateError||error instanceof CdpViewportError||error instanceof CdpReloadError||error instanceof CdpArtifactReadError||error instanceof CdpTraceError||error instanceof CdpFramesError||error instanceof CdpObservationError){const code=error.code.replace(/([a-z])([A-Z])/g,'$1_$2').replace(/[^a-zA-Z0-9_]/g,'_').toUpperCase().slice(0,80);envelope={code,message:error.message,phase,retryDisposition:'doNotRetry',details:null};}
        else envelope={code:'BROWSER_OPERATION_FAILED',message:'Owned browser operation failed. Inspect the retained receipt before any new input.',phase,retryDisposition:'doNotRetry',details:null};
        return this.#errorFacts.capture(envelope,error);
    }
    #response(command: CdpCommand, value: {result?:CdpJsonObject|null;error?:CdpErrorEnvelope|null;entry?:CdpJournalEntry;documentId?:string|null;transfer?:CdpImageTransfer;sessionId?:string|null;pageId?:string|null;ok?:boolean;nextCursor?:string|null;gap?:boolean;redactLogs?:boolean;}): CdpClientResponse {
        const entry = value.entry;
        const ownerOff=command.context.access==='owner'&&value.redactLogs!==true&&!this.diagnosticLogRedaction(command);
        const error=this.#errorFacts.project(value.error??null,ownerOff);
        const reply: CdpReply = {protocolVersion:1,callId:command.callId,op:command.op,client:this.#store.clientIdentity,ok:value.ok ?? !error,
            sessionId:entry?.evidence?.sessionId ?? entry?.sessionId ?? value.sessionId ?? command.sessionId,pageId:entry?.evidence?.pageId ?? entry?.pageId ?? value.pageId ?? command.pageId,documentId:value.documentId ?? null,
            observedAtUtc:new Date().toISOString(),receipt:entry?.receipt ?? null,result:value.result ? CdpContract.freezeJson(value.result) : null,error,
            limits:{truncated:(value.result?.output as any)?.truncated === true,nextCursor:value.nextCursor ?? (value.result?.output as any)?.paging?.nextCursor??null,gap:value.gap??false}};
        if (Buffer.byteLength(JSON.stringify(reply)) > this.#store.limits.values.nonImageReplyBytes) throw new CdpContractError('REPLY_LIMIT','Nonimage reply exceeds its admitted byte bound.');
        const response: CdpClientResponse = {success:reply.ok,msg:reply.ok ? 'CDP feature reply.' : 'CDP feature operation failed.',cdp:Object.freeze(reply),...(value.transfer ? {transfer:value.transfer} : {})};
        if (Buffer.byteLength(JSON.stringify(response)) > this.#store.limits.values.encodedReplyBytes) throw new CdpContractError('REPLY_LIMIT','Encoded response exceeds its admitted byte bound.');
        return Object.freeze(response);
    }
    #capabilities(): CdpJsonObject {
        return {contractRevision:'v1-redactLogs-2026-11-08',createSessionRedactLogs:true,screenshotAfterSensitiveFill:true,sessionCapabilities:{initialBlankPage:true,logicalSessionSelector:true,downloadPolicies:['capture','deny']},operationCapabilities:{Click:true,Fill:true,PressKey:true,InspectElement:true,CreateWatch:true,WaitFor:true,CancelWatch:true,ReadEvents:true,ClosePage:true,Reload:true,SetViewport:true,Hover:true,SelectOptions:true,SetChecked:true,Scroll:true,DragAndDrop:true,HandleDialog:true,GetNetworkExchange:true,SetInputFiles:true,Evaluate:true,ExportTrace:true},frameCapabilities:{exactPublicFrameGraph:true,singleDocumentAuthority:'CdpTargets document handles',childOperations:['Observe','InspectElement','Click','Fill','PressKey','Hover','SelectOptions','SetChecked','Scroll','Evaluate'],pointerDragMainFrameOnly:true,fileInputMainFrameOnly:true,oopifProcessIsolationMeasured:false,nativeIdMapping:false},observationCapabilities:{immutableSnapshotCursor:true,wholeResultUtf16Budget:true,nodeBudget:'nodes plus frames',parentRetainedCursorOnly:true,epochCoverage:'DOM mutations and input/change/focus; not all property writes',passwordValuesOmitted:true,nonpasswordControlValues:true},pageInventoryCapabilities:{url:true,title:true,opener:true,automaticOwnedPages:true,atomicPageCapacity:true,popupEarlyCoverage:'partial after context page event'},traceCapabilities:{include:['actions','console','network-summary'],retainedOnly:true,fullHar:false,ownerExportOnly:true,parentExport:false,parentReadExisting:true,cursorSemantics:'exclusive-after-event-id'},artifactCapabilities:{pngAttachment:true,jpegAttachment:true,retainedImageSourceImmutable:true,jpegResizeQuality:85,utf8BytePaging:true,unknownMimeStrictWindow:true,binaryText:false},downloadCapabilities:{nativeCapture:true,nativeDeny:true,denyProducesArtifacts:false,policyScope:'exact owned browserContextId',denyEventCoverage:'observed native events only; native denial may be silent',applicationRollbackClaimed:false,completedArtifactAdmission:true,soleGuidStream:true,retainedByteLimit:'hard artifact quota',nativeTransientLimit:'best-effort; overshoot may occur',mime:'unknown unless exactly known'},fileCapabilities:{namespaces:this.#browser.virtualRoot?['virtual']:[],virtualRootCaptured:!!this.#browser.virtualRoot,mainFrameOnly:true,exactObservedChooser:true,emptyClears:true,timeoutMs:10000,perCallTimeout:false,secretBytesInWire:false},evaluationCapabilities:{functionSource:true,oneJsonArgument:true,awaitPromise:true,realPendingAfterDeadline:true,mainFrameOnly:false,exactFrameContextGuard:true,serializer:'descriptor-json-v1'},imageCapabilities:{png:true,jpeg:true,jpegQuality:true,clipCss:true,persistentPageDpr:true,initialConfiguredDpr:true,elementTarget:true,childVisibleRectangles:true,geometry:'untransformed single fully visible rectangle; no scroll; occlusion possible',isolatedElementPaint:false,maximumDimension:4096,maximumEncodedBytes:8388608},dialogCapabilities:{nativeTypes:['alert','confirm','prompt','beforeunload'],exactActiveOnly:true,controlDuringOriginInput:true,originCorrelation:'observed mechanical overlap; cause unverified',restartRecovery:false},networkCapabilities:{authoritativeIdStream:'native-session-request-hop-v1',mainFrameOnly:true,logicalFrameMapping:'unknown',documentMapping:'unknown',boundedTextBodies:true,requestPostData:'bounded event only',responseBufferBytes:32768,retainedRecordsPerPage:128,retainedBytesPerPage:1048576,restartBodyRecovery:false,networkReplay:false},lifecycleCapabilities:{verifiedPageClose:true,reloadBypassCache:!this.#browser.fixtureOrigin,effectiveHttpCache:this.#browser.fixtureOrigin?'disabled by explicit fixture routing':'browser-managed',reloadMode:this.#browser.fixtureOrigin?'fixture-guarded':'general',reloadMechanicsRetainedAfterDeadline:true,deviceScaleFactorChanges:true,resizeScale:'per-page measured CSS/DPR, persistent owning CDPSession',screenshotScale:'measured captureScale; native DPR preserved'},interactionCapabilities:{mainFrameOnly:false,pointerDragMainFrameOnly:true,nativeSelectOnly:true,nativeCheckableOnly:true,cssPixelScroll:true,dragInputMethods:['pointer'],syntheticFallback:false},watchCapabilities:{historyReplay:'gap-and-omission-aware-v1',mainFrameOnly:false,childFrameConditions:['element','text','predicate'],literalMainFrameConditions:['url','load'],elementStates:['attached','detached','visible','hidden','enabled','disabled','checked','unchecked'],textComparisons:['equals','contains','regex'],urlComparisons:['equals','contains','regex'],loadStates:['domcontentloaded','load'],conditionKinds:['element','text','url','load','event','response','predicate'],requestJsonMatch:{pathScalarEquals:true,requiresCompleteCapturedBody:true,httpReplay:false},regex:{engine:'fixed-code node:vm RegExp',flags:'u',patternChars:1024,inputChars:32768,timeoutMs:100},predicate:{functionSource:true,oneJsonArgument:true,exactFrameDocument:true,repeatedObservationalPolling:true,purityClaimed:false,maximumPendingPerPage:1,waitTimeoutCancelsExecution:false,cancelStopsFuturePollsOnly:true},eventFilters:{console:['level','textMatch'],pageError:['textMatch'],navigation:['urlMatch'],request:['urlMatch','method','requestJsonMatch'],response:['urlMatch','method','status','requestJsonMatch'],dialog:['dialogType','messageMatch'],fileChooser:['multiple'],download:['downloadId','state','suggestedFilenameMatch'],pageOpened:['openerPageId','urlMatch'],pageClosed:['closedPageId']},captureKinds:['console','pageError','navigation','request','response','dialog','fileChooser','download','pageOpened','pageClosed'],networkFrameScope:'main native capture only; logical frame/document unknown',restartRearm:false},platform:process.platform,architecture:process.arch,node:process.version,library:'playwright-core',libraryVersion:CdpBrowserSession.libraryVersion(),browser:'installed Chrome',browserExecutableVersion:this.#executableVersion,
            verifiedSessionVersions:[...this.#sessions.values()].map(session => session.version).filter(Boolean) as string[],headlessOnly:true,navigationPolicy:this.#browser.fixtureOrigin ? 'explicit owned loopback QC restriction' : 'ordinary HTTP/HTTPS; other schemes rejected',generalUrlValidation:true,networkSandbox:false,automaticSubresourceRedirectInterception:!!this.#browser.fixtureOrigin,generalApplicationAcceptance:false,restartReattach:false,productionIntegration:'importable feature bridge; deployed feed/provider acceptance not established',diagnosticPolicy:{createSessionOption:'options.redactLogs',default:true,rawDiagnostics:'exact authorized session OFF may log sensitive Fill and page text; no classification/proof prerequisite; no privacy guarantee; image bytes excluded',rawFillValues:true,limitsAlwaysOn:true},
            supported:['GetCapabilities','CreateSession','GetSessions','CreatePage','GetPages','CloseSession','GetCall','GetAction(exact owner or unique exact parent)','Navigate(HTTP/HTTPS; optional explicit QC origin)','Observe(exact frame, immutable bounded snapshot cursor)','Screenshot(PNG/JPEG, visible target rectangles, including after sensitive input; no masking guarantee)','ReadArtifact(retained PNG/JPEG attachment or bounded UTF8 text/JSON/download window, exact owner/immediate parent)','Click(exact selected frame)','Fill(text-like exact selected frame)','PressKey(page-scoped restricted keys)','InspectElement(exact selected frame)','CreateWatch(frame-scoped element/text/predicate, literal-main URL/load, native request/response JSON and canonical event filters)','WaitFor','CancelWatch','ReadEvents(bounded canonical metadata)','ClosePage(verified explicit page only)','Reload(native operation-scoped ignoreCache; general browser cache, guarded QC distinction unsupported)','SetViewport(measured per-page CSS/DPR)' ,'Hover(exact selected frame)','SelectOptions(native select values)','SetChecked(native checkbox/radio)','Scroll(CSS pixels)','DragAndDrop(pinned native pointer only)','HandleDialog(exact current native dialog, new journaled action)','GetNetworkExchange(retained native request/hop ID, bounded text only)','SetInputFiles(virtual project namespace, pinned input/exact chooser)','Evaluate(function source, one JSON argument, real promise retained)','ExportTrace(owner retained journal/event snapshot to immutable JSON artifact)'],
            watchPolicy:{maximumActivePerPage:this.#store.limits.values.watchesPerPage,restartRearm:false,readiness:'50ms sampling; transient states may be missed; browser predicate code may mutate/await and is not cancelled by watch stop',network:'bounded retained native request/hop evidence only; unavailable is not no-match',unsupported:['requestJSON beyond retained complete preview','HTTP replay','child-frame network capture','response body match fields not present in literal schema'],pageOpened:'exact owned pages, early network coverage partial'},targetPolicy:{mainFrameOnly:false,strategies:['role','testId','label','placeholder','text','css'],exactlyOne:true,ordinalSupported:false,maximumRetainedHandlesPerPage:5000,preflight:'visible/enabled/stable; Fill editable; public browser hit testing/scroll after barrier'},sensitivePolicy:'Best-effort known-literal text redaction remains; screenshots are permitted without masking after sensitive input; authorized OFF logs may contain sensitive values; no privacy certification',artifactPolicy:'one retained registry; PNG/JPEG images, JSON trace and completed download artifacts; strict bounded UTF8 text windows, no binary base64; provider attachment integration pending',unsupported:[...(this.#browser.fixtureOrigin?['Reload(BypassCache=true in fixture-guarded mode)']:[]),'DragAndDrop(syntheticDataTransfer)','SecretRef','clipboard/browser/global keyboard shortcuts','binary artifact text pagination','headful','browser takeover','provider image attachment','macOS runtime'],limits:this.#store.limits.values as unknown as CdpJsonObject};
    }
    diagnosticLogRedaction(command: CdpCommand): boolean {
        try {
            const sessionId=this.#diagnosticSession(command);
            return sessionId === null || this.#store.getSessionLogRedaction(sessionId,command.context);
        } catch { return true; } // Missing/invalid/unauthorized scope cannot select raw diagnostics.
    }
    sanitizeDiagnostics(command: CdpCommand, value: any): any {
        try { const sessionId=this.#diagnosticSession(command); return sessionId ? this.#sessions.get(sessionId)?.redact(value) ?? value : value; }
        catch { return {redacted:true,code:'DIAGNOSTIC_SCOPE_UNAVAILABLE'}; }
    }
    #diagnosticSession(command: CdpCommand): string|null {
        this.#binding(command);
        if(command.op==='CreateSession'||command.op==='GetCapabilities'||command.op==='GetSessions')return null;
        if(command.op==='GetCall') {
            const original=this.#operations.get(command.args.callId as string);
            if(original) {this.#authorizeOperation(original,command.context);this.#queryScope(command,original.sessionId);return original.sessionId;}
            const entry=this.#store.getCall(command.args.callId as string,command.context);this.#queryScope(command,entry.sessionId);return entry.sessionId;
        }
        if(command.op==='GetAction')return this.#store.getAction(command.sessionId ?? '',command.args.idKind as 'action'|'creation',command.args.id as string,command.context).sessionId;
        if(command.op==='ReadArtifact') {
            const artifact=this.#store.getArtifact(command.args.artifactId as string,command.context);
            if(artifact.sessionId!==command.sessionId)throw new CdpContractError('OWNERSHIP_DENIED','Artifact is outside the explicit diagnostic session scope.');
        }
        if(command.sessionId)this.#store.getSession(command.sessionId,command.context);
        return command.sessionId;
    }
    async shutdownOwned(timeoutMs=10000): Promise<CdpJsonObject> {
        const deadline=Date.now()+timeoutMs, calls:{sessionId:string;callId:string}[]=[], unavailable:CdpJsonObject[]=[];
        for(const session of this.#sessions.values()) {
            try {
                if(this.#store.getSession(session.id,session.owner).state==='closed')continue;
                const callId=randomUUID(),actionId=randomUUID();
                const wire=CdpContract.validate({id:callId,command:'cdp',cdp:{protocolVersion:1,callId,op:'CloseSession',context:session.owner,sessionId:session.id,pageId:null,requestId:null,actionId,
                    fingerprint:'h1:'+createHmac('sha256',this.#signatureKey).update(callId).digest('hex'),args:{timeoutMs}}},this.#store.limits);
                this.#mutation(wire);calls.push({sessionId:session.id,callId});
            }catch(error){unavailable.push({sessionId:session.id,errorCode:this.#error(error,'shutdown').code,cleanup:session.cleanupEvidence as unknown as CdpJsonObject|null});}
        }
        while(calls.some(call=>this.#operations.get(call.callId)?.finished===false)&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,25));
        const sessions=calls.map(call=>{const entry=this.#store.getCall(call.callId,this.#sessions.get(call.sessionId)!.owner);return {...call,state:entry.receipt.state,cleanup:this.#sessions.get(call.sessionId)!.cleanupEvidence as unknown as CdpJsonObject|null};});
        return {sessions,unavailable,pendingOperations:[...this.#operations.values()].filter(operation=>!operation.finished).length,mechanicsOnly:true};
    }
    readArtifact(id: string, context: CdpContext): CdpImageTransfer { return this.#artifacts.readImage(id,context); }
    cleanupEvidence(): readonly (CdpOwnedCleanup|null)[] { return [...this.#sessions.values()].map(session => session.cleanupEvidence); }
}
