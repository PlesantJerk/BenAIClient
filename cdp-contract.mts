import {CdpConditionMatcher} from './cdp-condition-matcher.mts';
// Feature-local v1 data contract only. No browser adapter or tool registration.
export type CdpJson = null | boolean | number | string | CdpJson[] | CdpJsonObject;
export interface CdpJsonObject { [key: string]: CdpJson; }
export type CdpAccess = 'owner' | 'parentInspect';
export type CdpIdKind = 'creation' | 'action';
export type CdpState = 'accepted' | 'dispatchStarted' | 'completed' | 'failedBeforeDispatch' | 'uncertain' | 'cancelledBeforeDispatch';
export type CdpOperation = 'GetCapabilities' | 'GetSessions' | 'CreateSession' | 'CreatePage' | 'GetPages' | 'CloseSession' | 'GetAction' | 'GetCall' | 'Navigate' | 'Observe' | 'Screenshot' | 'ReadArtifact' | 'Click' | 'Fill' | 'PressKey' | 'InspectElement' | 'CreateWatch' | 'WaitFor' | 'CancelWatch' | 'ReadEvents' | 'ClosePage' | 'Reload' | 'SetViewport' | 'Hover' | 'SelectOptions' | 'SetChecked' | 'Scroll' | 'DragAndDrop' | 'HandleDialog' | 'GetNetworkExchange' | 'SetInputFiles' | 'Evaluate' | 'ExportTrace';

export interface CdpContext {
    readonly accountUserId: string;
    readonly actorConversationId: string;
    readonly parentConversationId: string | null;
    readonly clientName: string;
    readonly clientInstallId: string | null;
    readonly clientIncarnationId: string | null;
    readonly access: CdpAccess;
}

export interface CdpCommand {
    readonly protocolVersion: 1;
    readonly callId: string;
    readonly op: CdpOperation;
    readonly context: CdpContext;
    readonly sessionId: string | null;
    readonly pageId: string | null;
    readonly requestId: string | null;
    readonly actionId: string | null;
    readonly fingerprint: string | null;
    readonly args: Readonly<CdpJsonObject>;
}

export interface CdpWireCommand { readonly id: string; readonly command: 'cdp'; readonly cdp: CdpCommand; }
export interface CdpClientIdentity { readonly clientName: string; readonly clientInstallId: string; readonly clientIncarnationId: string; readonly platform: string; }
export interface CdpReceipt {
    readonly idKind: CdpIdKind;
    readonly id: string;
    readonly fingerprint: string;
    readonly state: CdpState;
    readonly acceptedAtUtc: string;
    readonly dispatchStartedAtUtc: string | null;
    readonly completedAtUtc: string | null;
    readonly inputMethod: string | null;
    readonly payloadExpired: boolean;
}

export interface CdpErrorEnvelope {
    readonly code: string;
    readonly message: string;
    readonly phase: string;
    readonly retryDisposition: 'doNotRetry' | 'newIdAfterInspection' | 'safeToRetryRead';
    readonly details: Readonly<CdpJsonObject> | null;
}

export interface CdpReply {
    readonly protocolVersion: 1;
    readonly callId: string;
    readonly op: CdpOperation;
    readonly client: CdpClientIdentity;
    readonly ok: boolean;
    readonly sessionId: string | null;
    readonly pageId: string | null;
    readonly documentId: string | null;
    readonly observedAtUtc: string;
    readonly receipt: CdpReceipt | null;
    readonly result: Readonly<CdpJsonObject> | null;
    readonly error: CdpErrorEnvelope | null;
    readonly limits: { readonly truncated: boolean; readonly nextCursor: string | null; readonly gap: boolean; };
}

export interface CdpLimitValues {
    liveSessionsPerAccount: number; liveSessionsPerClient: number; pagesPerSession: number; watchesPerPage: number;
    eventsPerSession: number; eventBytesPerSession: number; artifactBytesPerSession: number;
    artifactBytesPerAccount: number; artifactBytesPerClient: number; downloadBytes: number;
    sourceImageBytes: number; finalImageBytes: number; encodedReplyBytes: number; argumentBytes: number;
    nonImageReplyBytes: number; dedupIdsPerAccount: number; dedupIdsPerClient: number; evidenceRetentionMs: number;
}

export class CdpLimits {
    static readonly defaults: Readonly<CdpLimitValues> = Object.freeze({
        liveSessionsPerAccount: 8, liveSessionsPerClient: 8, pagesPerSession: 8, watchesPerPage: 32,
        eventsPerSession: 5000, eventBytesPerSession: 4194304, artifactBytesPerSession: 268435456,
        artifactBytesPerAccount: 1073741824, artifactBytesPerClient: 1073741824, downloadBytes: 67108864,
        sourceImageBytes: 8388608, finalImageBytes: 8388608, encodedReplyBytes: 12582912, argumentBytes: 65536,
        nonImageReplyBytes: 131072, dedupIdsPerAccount: 100000, dedupIdsPerClient: 100000, evidenceRetentionMs: 604800000
    });
    readonly values: Readonly<CdpLimitValues>;

    constructor(overrides: Partial<CdpLimitValues> = {}) {
        for (const key of Object.keys(overrides)) {
            if (!(key in CdpLimits.defaults)) throw new CdpContractError('INVALID_LIMIT', 'Unknown limit.');
        }
        const values = { ...CdpLimits.defaults, ...overrides };
        for (const value of Object.values(values)) {
            if (!Number.isSafeInteger(value) || value < 1) throw new CdpContractError('INVALID_LIMIT', 'Limits must be positive safe integers.');
        }
        this.values = Object.freeze(values);
        Object.freeze(this);
    }
}

export class CdpContractError extends Error {
    readonly code: string;
    constructor(code: string, message: string) {
        super(message);
        this.name = 'CdpContractError';
        this.code = code;
    }
    toEnvelope(phase = 'validation'): CdpErrorEnvelope {
        return Object.freeze({ code: this.code, message: this.message, phase, retryDisposition: 'doNotRetry', details: null });
    }
}

// Immutable snapshot. A routing installation UUID never proves browser ownership.
export class CdpCapturedIdentity implements CdpContext {
    readonly accountUserId: string;
    readonly actorConversationId: string;
    readonly parentConversationId: string | null;
    readonly clientName: string;
    readonly clientInstallId: string | null;
    readonly clientIncarnationId: string | null;
    readonly access: CdpAccess;
    constructor(value: unknown) {
        const context = CdpContract.context(value);
        this.accountUserId = context.accountUserId;
        this.actorConversationId = context.actorConversationId;
        this.parentConversationId = context.parentConversationId;
        this.clientName = context.clientName;
        this.clientInstallId = context.clientInstallId;
        this.clientIncarnationId = context.clientIncarnationId;
        this.access = context.access;
        Object.freeze(this);
    }
    toObject(): CdpContext {
        return Object.freeze({ accountUserId: this.accountUserId, actorConversationId: this.actorConversationId,
            parentConversationId: this.parentConversationId, clientName: this.clientName, clientInstallId: this.clientInstallId,
            clientIncarnationId: this.clientIncarnationId, access: this.access });
    }
}

export class CdpContract {
    static readonly #operations = new Set<CdpOperation>(['GetCapabilities', 'GetSessions', 'CreateSession', 'CreatePage', 'GetPages', 'CloseSession', 'GetAction', 'GetCall', 'Navigate', 'Observe', 'Screenshot', 'ReadArtifact', 'Click', 'Fill', 'PressKey', 'InspectElement', 'CreateWatch', 'WaitFor', 'CancelWatch', 'ReadEvents', 'ClosePage', 'Reload', 'SetViewport', 'Hover', 'SelectOptions', 'SetChecked', 'Scroll', 'DragAndDrop', 'HandleDialog', 'GetNetworkExchange', 'SetInputFiles', 'Evaluate', 'ExportTrace']);
    static readonly #retainedReads = new Set<CdpOperation>(['GetSessions', 'GetPages', 'GetAction', 'GetCall', 'ReadArtifact', 'ReadEvents', 'WaitFor', 'GetNetworkExchange', 'ExportTrace', 'Observe']);

    static validate(value: unknown, limits = new CdpLimits()): CdpWireCommand {
        const wire = this.object(value, ['id', 'command', 'cdp']);
        this.token(wire.id);
        if (wire.command !== 'cdp') this.fail('Unsupported command.');
        const command = this.object(wire.cdp, ['protocolVersion', 'callId', 'op', 'context', 'sessionId', 'pageId', 'requestId', 'actionId', 'fingerprint', 'args']);
        if (command.protocolVersion !== 1) this.fail('Unsupported protocol version.');
        const op = command.op as CdpOperation;
        if (!this.#operations.has(op)) throw new CdpContractError('UNSUPPORTED_OPERATION', 'Operation has no v1 schema in this foundation.');
        const context = new CdpCapturedIdentity(command.context);
        const result: CdpCommand = Object.freeze({
            protocolVersion: 1, callId: this.uuid(command.callId), op, context,
            sessionId: this.nullToken(command.sessionId), pageId: this.nullToken(command.pageId),
            requestId: this.nullToken(command.requestId), actionId: this.nullToken(command.actionId),
            fingerprint: command.fingerprint === null ? null : this.token(command.fingerprint, 256),
            args: this.freezeJson(this.normalizeArgs(op, command.args, limits))
        });
        this.validateEnvelope(result);
        return Object.freeze({ id: wire.id as string, command: 'cdp', cdp: result });
    }

    static context(value: unknown): CdpContext {
        if (value instanceof CdpCapturedIdentity) return value.toObject();
        const c = this.object(value, ['accountUserId', 'actorConversationId', 'parentConversationId', 'clientName', 'clientInstallId', 'clientIncarnationId', 'access']);
        if (c.access !== 'owner' && c.access !== 'parentInspect') this.fail('Invalid access mode.');
        return Object.freeze({
            accountUserId: this.int64(c.accountUserId), actorConversationId: this.int64(c.actorConversationId),
            parentConversationId: c.parentConversationId === null ? null : this.int64(c.parentConversationId),
            clientName: this.clientName(c.clientName), clientInstallId: c.clientInstallId === null ? null : this.uuid(c.clientInstallId),
            clientIncarnationId: c.clientIncarnationId === null ? null : this.uuid(c.clientIncarnationId), access: c.access
        });
    }

    static isMutation(op: CdpOperation): boolean { return op === 'CreateSession' || op === 'CreatePage' || op === 'CloseSession' || op === 'Navigate' || op === 'Click' || op === 'Fill' || op === 'PressKey' || op === 'CreateWatch' || ['ClosePage','Reload','SetViewport','Hover','SelectOptions','SetChecked','Scroll','DragAndDrop','HandleDialog','SetInputFiles','Evaluate'].includes(op); }
    static isCreation(op: CdpOperation): boolean { return op === 'CreateSession' || op === 'CreatePage' || op === 'CreateWatch'; }
    static isRetainedRead(op: CdpOperation): boolean { return this.#retainedReads.has(op); }
    static scope(command: CdpCommand): string { return command.sessionId ?? ''; }
    static dedupId(command: CdpCommand): string { return (this.isCreation(command.op) ? command.requestId : command.actionId) ?? this.fail('Missing dedup identity.'); }
    static idKind(command: CdpCommand): CdpIdKind { return this.isCreation(command.op) ? 'creation' : 'action'; }

    static validateEnvelope(c: CdpCommand): void {
        const discovery = c.op === 'GetCapabilities';
        if (!discovery && (!c.context.clientInstallId || !c.context.clientIncarnationId)) this.fail('Captured client binding is required.');
        if ((c.context.clientInstallId === null) !== (c.context.clientIncarnationId === null)) this.fail('Incomplete client binding.');
        if (c.context.access === 'parentInspect' && !this.isRetainedRead(c.op)) throw new CdpContractError('OWNERSHIP_DENIED', 'Parent inspection is retained-read only.');
        if(c.context.access==='parentInspect'&&c.op==='Observe'&&(c.args.options as any).cursor===null)throw new CdpContractError('OWNERSHIP_DENIED','Parent Observe requires an existing retained cursor; no snapshot creation or DOM proof renewal.');
        if (this.isMutation(c.op)) {
            if (!c.fingerprint || !/^h1:[a-f0-9]{64}$/.test(c.fingerprint)) this.fail('Opaque h1 mutation fingerprint is required.');
            if (this.isCreation(c.op) ? (!c.requestId || c.actionId !== null) : (!c.actionId || c.requestId !== null)) this.fail('Invalid mutation dedup fields.');
        } else if (c.requestId !== null || c.actionId !== null || c.fingerprint !== null) this.fail('Read must not carry mutation dedup fields.');
        if (['CreatePage', 'GetPages', 'CloseSession', 'Navigate', 'Observe', 'Screenshot', 'ReadArtifact', 'Click', 'Fill', 'PressKey', 'InspectElement', 'CreateWatch', 'WaitFor', 'CancelWatch', 'ReadEvents', 'ClosePage', 'Reload', 'SetViewport', 'Hover', 'SelectOptions', 'SetChecked', 'Scroll', 'DragAndDrop', 'HandleDialog', 'GetNetworkExchange', 'SetInputFiles', 'Evaluate', 'ExportTrace'].includes(c.op) && !c.sessionId) this.fail('Session handle is required.');
        if (['Navigate', 'Observe', 'Screenshot', 'Click', 'Fill', 'PressKey', 'InspectElement', 'CreateWatch', 'ClosePage', 'Reload', 'SetViewport', 'Hover', 'SelectOptions', 'SetChecked', 'Scroll', 'DragAndDrop', 'HandleDialog', 'GetNetworkExchange', 'SetInputFiles', 'Evaluate'].includes(c.op) && !c.pageId) this.fail('Page handle is required.');
        if (['GetCapabilities', 'CreateSession'].includes(c.op) && (c.sessionId || c.pageId)) this.fail('Unexpected resource handles.');
        if (['CreatePage', 'GetPages', 'GetSessions', 'CloseSession', 'GetCall', 'ReadArtifact', 'WaitFor', 'CancelWatch'].includes(c.op) && c.pageId) this.fail('Unexpected page handle.');
    }

    static normalizeArgs(op: CdpOperation, value: unknown, limits: CdpLimits): CdpJsonObject {
        const cloned = this.cloneJson(value, 0, new Set<object>());
        if (Buffer.byteLength(this.canonical(cloned), 'utf8') > limits.values.argumentBytes) throw new CdpContractError('ARGUMENT_LIMIT', 'Command arguments exceed the admitted byte limit.');
        const a = this.object(cloned);
        switch (op) {
            case 'GetCapabilities': case 'CreatePage': this.only(a, []); return {};
            case 'GetSessions': case 'GetPages':
                this.only(a, ['cursor', 'limit']); return { cursor: this.nullToken(a.cursor ?? null), limit: this.integer(a.limit ?? 20, 1, 50) };
            case 'GetAction':
                this.only(a, ['idKind', 'id']);
                if (a.idKind !== undefined && a.idKind !== 'action' && a.idKind !== 'creation') this.fail('Invalid lookup ID kind.');
                return { idKind: a.idKind === 'creation' ? 'creation' : 'action', id: this.token(a.id) };
            case 'GetCall': this.only(a, ['callId']); return { callId: this.uuid(a.callId) };
            case 'CreateSession': return this.sessionArgs(a, limits);
            case 'CloseSession': this.only(a, ['timeoutMs']); return { timeoutMs: this.integer(a.timeoutMs ?? 10000, 1, 120000) };
            case 'Evaluate': return this.evaluateArgs(a);
            case 'ExportTrace':return this.traceArgs(a);
            case 'SetInputFiles': {
                this.only(a,['files','target','fileChooserId','options']);const target=a.target==null?null:this.target(a.target),chooser=this.nullToken(a.fileChooserId??null);
                if((target===null)===(chooser===null))this.fail('Exactly one Target or FileChooserId is required.');
                if(!Array.isArray(a.files)||a.files.length>16)this.fail('Files must be an array of at most sixteen project references.');
                const files=a.files.map(value=>{const f=this.object(value,['spaceId','path']);return {spaceId:this.token(f.spaceId),path:this.text(f.path,32768)};});
                return {files,target,fileChooserId:chooser,options:this.actionOptions(a.options)};
            }
            case 'HandleDialog': {
                this.only(a,['dialogId','accept','promptText']);const text=a.promptText??null;
                if(text!==null&&(typeof text!=='string'||text.length>8192||Buffer.byteLength(text,'utf8')>32768))this.fail('PromptText exceeds its bounded text contract.');
                return {dialogId:this.token(a.dialogId),accept:this.boolean(a.accept),promptText:typeof text==='string'?text:null};
            }
            case 'GetNetworkExchange': {
                this.only(a,['networkRequestId','options']);const o=this.object(a.options??{});this.only(o,['includeRequestBody','includeResponseBody','maxBodyChars']);
                return {networkRequestId:this.token(a.networkRequestId),options:{includeRequestBody:this.boolean(o.includeRequestBody===undefined?false:o.includeRequestBody),includeResponseBody:this.boolean(o.includeResponseBody===undefined?false:o.includeResponseBody),maxBodyChars:this.integer(o.maxBodyChars??16000,1,65536)}};
            }
            case 'ClosePage': this.only(a,[]);return {};
            case 'Reload': {
                this.only(a,['bypassCache','waitUntil','timeoutMs']);const waitUntil=a.waitUntil??'domcontentloaded';
                if(!['commit','domcontentloaded','load'].includes(waitUntil as string))this.fail('Invalid reload wait mode.');
                return {bypassCache:this.boolean(a.bypassCache===undefined?false:a.bypassCache),waitUntil:waitUntil as string,timeoutMs:this.integer(a.timeoutMs??30000,1,120000)};
            }
            case 'SetViewport':this.only(a,['width','height','deviceScaleFactor']);return {width:this.integer(a.width,320,7680),height:this.integer(a.height,240,4320),deviceScaleFactor:this.integer(a.deviceScaleFactor??1,1,4)};
            case 'Hover':case 'SelectOptions':case 'SetChecked':case 'Scroll':case 'DragAndDrop':return this.interactionArgs(op,a);
            case 'Navigate': return this.navigationArgs(a);
            case 'Observe': return this.observationArgs(a);
            case 'Screenshot': return this.screenshotArgs(a);
            case 'ReadArtifact': return this.artifactArgs(a, limits);
            case 'InspectElement': return this.inspectionArgs(a);
            case 'CreateWatch': this.only(a,['condition','afterEventId','expireAfterMs']); return {condition:this.condition(a.condition),afterEventId:this.eventCursor(a.afterEventId??null),expireAfterMs:this.integer(a.expireAfterMs??60000,1,600000)};
            case 'WaitFor': this.only(a,['watchId','timeoutMs']);return {watchId:this.token(a.watchId),timeoutMs:this.integer(a.timeoutMs??10000,1,120000)};
            case 'CancelWatch': this.only(a,['watchId']);return {watchId:this.token(a.watchId)};
            case 'ReadEvents': {
                this.only(a,['afterEventId','kinds','maxItems','maxChars']);const kinds=a.kinds??[];
                if(!Array.isArray(kinds)||new Set(kinds).size!==kinds.length) this.fail('Expected unique event kinds.');
                for(const kind of kinds)this.eventKind(kind);
                return {afterEventId:this.eventCursor(a.afterEventId??null),kinds:kinds as string[],maxItems:this.integer(a.maxItems??50,1,50),maxChars:this.integer(a.maxChars??12000,256,32000)};
            }
            case 'Click': case 'Fill': case 'PressKey': return this.inputArgs(op,a);
        }
    }

    static readonly eventKinds=Object.freeze(['console','pageError','navigation','request','response','dialog','fileChooser','download','pageOpened','pageClosed']);
    static eventKind(value:unknown):string {if(typeof value!=='string'||!this.eventKinds.includes(value))this.fail('Unknown canonical event kind.');return value;}
    static eventCursor(value:unknown):string|null {return value===null?null:value==='0'?'0':this.int64(value);}
    static inspectionArgs(a:Record<string,unknown>):CdpJsonObject {
        this.only(a,['target','options']);const o=this.object(a.options??{});
        this.only(o,['attributes','styleProperties','pseudo','includeText','includeRect','maxChars']);
        const names=(value:unknown):string[]=>{if(!Array.isArray(value)||value.length>32||new Set(value).size!==value.length)this.fail('Expected bounded unique names.');return value.map(name=>{const text=this.text(name,100);if(!/^[a-zA-Z_-][a-zA-Z0-9_:.-]*$/.test(text))this.fail('Invalid attribute/style name.');return text;});};
        const pseudo=o.pseudo??null;
        if(pseudo!==null&&pseudo!=='before'&&pseudo!=='after')this.fail('Invalid pseudo element.');
        return {target:this.target(a.target),options:{attributes:names(o.attributes??[]),styleProperties:names(o.styleProperties??[]),pseudo:typeof pseudo==='string'?pseudo:null,includeText:this.boolean(o.includeText??true),includeRect:this.boolean(o.includeRect??true),maxChars:this.integer(o.maxChars??6000,1,32000)}};
    }
    static match(value:unknown):CdpJsonObject {
        const m=this.object(value,['comparison','value']);
        if(!['equals','contains','regex'].includes(m.comparison as string))this.fail('Invalid match comparison.');
        if(typeof m.value!=='string'||m.value.length>4096)this.fail('Expected bounded literal match text.');
        if(m.comparison==='regex')CdpConditionMatcher.validateRegex(m.value);
        return {comparison:m.comparison as string,value:m.value};
    }
    static matchMethod(value:unknown):string|null {
        if(value===null||value===undefined)return null;
        const method=this.text(value,32);if(!/^[!#$%&'*+.^_ 60|~0-9A-Za-z-]{1,32}$/.test(method))this.fail('Invalid HTTP method token.');return method.toUpperCase();
    }
    static requestJsonMatch(value:unknown):CdpJsonObject|null {
        if(value===null||value===undefined)return null;
        const m=this.object(value,['path','comparison','value']);
        if(!Array.isArray(m.path)||m.path.length>32||m.path.some(item=>typeof item==='string'?item.length>128:!Number.isSafeInteger(item)||item<0||item>1000000))this.fail('Expected bounded JSON property/index path.');
        if(m.comparison!=='equals')this.fail('Request JSON comparison is equals only.');
        if(m.value!==null&&!['string','number','boolean'].includes(typeof m.value)||typeof m.value==='string'&&m.value.length>4096)this.fail('Expected bounded JSON scalar.');
        return {path:m.path as (string|number)[],comparison:'equals',value:this.cloneJson(m.value,0,new Set<object>())};
    }
    static condition(value:unknown):CdpJsonObject {
        const c=this.object(value);
        switch(c.kind){
            case 'element':this.only(c,['kind','target','state']);if(!['attached','detached','visible','hidden','enabled','disabled','checked','unchecked'].includes(c.state as string))this.fail('Invalid element condition.');return {kind:'element',target:this.target(c.target),state:c.state as string};
            case 'text':this.only(c,['kind','target','match']);return {kind:'text',target:this.target(c.target),match:this.match(c.match)};
            case 'url':this.only(c,['kind','match']);return {kind:'url',match:this.match(c.match)};
            case 'load':this.only(c,['kind','state']);if(!['domcontentloaded','load'].includes(c.state as string))this.fail('Invalid load state.');return {kind:'load',state:c.state as string};
            case 'response':this.only(c,['kind','urlMatch','method','status','requestJsonMatch']);return {kind:'response',urlMatch:this.match(c.urlMatch),method:this.matchMethod(c.method),status:c.status==null?null:this.integer(c.status,100,599),requestJsonMatch:this.requestJsonMatch(c.requestJsonMatch)};
            case 'predicate':{this.only(c,['kind','expression','arguments','frameId']);const args=this.evaluateArgs({script:c.expression,arguments:c.arguments??null,frameId:c.frameId??null});return {kind:'predicate',expression:args.script,arguments:args.arguments,frameId:args.frameId};}
            case 'event':return this.eventCondition(c);
            default:this.fail('Unknown condition kind.');
        }
    }
    static eventCondition(c:Record<string,unknown>):CdpJsonObject {
        this.only(c,['kind','eventType','filters']);const type=this.eventKind(c.eventType),f=this.object(c.filters??{});
        let fields:string[];
        switch(type){case 'console':fields=['level','textMatch'];break;case 'pageError':fields=['textMatch'];break;case 'navigation':fields=['urlMatch'];break;case 'request':fields=['urlMatch','method','requestJsonMatch'];break;case 'response':fields=['urlMatch','method','status','requestJsonMatch'];break;case 'dialog':fields=['dialogType','messageMatch'];break;case 'fileChooser':fields=['multiple'];break;case 'download':fields=['downloadId','state','suggestedFilenameMatch'];break;case 'pageOpened':fields=['openerPageId','urlMatch'];break;case 'pageClosed':fields=['closedPageId'];break;default:this.fail('Unknown event filter kind.');}
        this.only(f,fields);const filters:CdpJsonObject={};
        for(const[key,value]of Object.entries(f)){
            if(key==='requestJsonMatch')filters[key]=this.requestJsonMatch(value);
            else if(key.endsWith('Match'))filters[key]=this.match(value);
            else if(key==='method')filters[key]=this.matchMethod(value);
            else if(key==='status')filters[key]=value===null?null:this.integer(value,100,599);
            else if(key==='multiple')filters[key]=this.boolean(value);
            else if(key==='level'){if(!['log','info','warning','error','debug'].includes(value as string))this.fail('Invalid console level.');filters[key]=value as string;}
            else if(key==='state'){if(!['started','progress','completed','failed'].includes(value as string))this.fail('Invalid download state.');filters[key]=value as string;}
            else if(key==='dialogType'){if(!['alert','confirm','prompt','beforeunload'].includes(value as string))this.fail('Invalid dialog type.');filters[key]=value as string;}
            else filters[key]=this.token(value);
        }
        return {kind:'event',eventType:type,filters};
    }

    static sessionArgs(a: Record<string, unknown>, limits: CdpLimits): CdpJsonObject {
        this.only(a, ['options']);
        const o = this.object(a.options ?? {});
        this.only(o, ['headless', 'startupTimeoutMs', 'browser', 'viewport', 'locale', 'timezoneId', 'downloadPolicy', 'maxDownloadMiB', 'artifactSpaceId', 'redactLogs']);
        const v = this.object(o.viewport ?? {}); this.only(v, ['width', 'height', 'deviceScaleFactor']);
        const downloadPolicy = o.downloadPolicy === undefined ? 'capture' : o.downloadPolicy;
        if (downloadPolicy !== 'capture' && downloadPolicy !== 'deny') this.fail('Unsupported downloadPolicy.');
        if ((o.browser ?? 'chrome') !== 'chrome' || (o.artifactSpaceId ?? 'virtual') !== 'virtual') this.fail('Unsupported session option.');
        return { options: { headless: this.boolean(o.headless ?? true), startupTimeoutMs: this.integer(o.startupTimeoutMs ?? 30000, 1, 120000), browser: 'chrome',
            viewport: { width: this.integer(v.width ?? 1440, 320, 7680), height: this.integer(v.height ?? 1000, 240, 4320), deviceScaleFactor: this.integer(v.deviceScaleFactor ?? 1, 1, 4) },
            locale: this.nullText(o.locale ?? null, 100), timezoneId: this.nullText(o.timezoneId ?? null, 100), downloadPolicy,
            maxDownloadMiB: this.integer(o.maxDownloadMiB ?? 64, 1, Math.max(1, Math.floor(limits.values.downloadBytes / 1048576))), artifactSpaceId: 'virtual', redactLogs: this.boolean(o.redactLogs === undefined ? true : o.redactLogs) } };
    }

    static navigationArgs(a: Record<string, unknown>): CdpJsonObject {
        this.only(a, ['url', 'waitUntil', 'timeoutMs']);
        const url = this.text(a.url, 16384);
        let parsed: URL;
        try { parsed = new URL(url); } catch { return this.fail('Invalid navigation URL.'); }
        if (parsed.username || parsed.password) this.fail('Navigation credentials in URL are not admitted.');
        if (!['http:', 'https:', 'about:'].includes(parsed.protocol) || (parsed.protocol === 'about:' && url !== 'about:blank')) this.fail('Navigation scheme is not admitted.');
        const waitUntil = a.waitUntil ?? 'domcontentloaded';
        if (!['commit', 'domcontentloaded', 'load', 'networkidle'].includes(waitUntil as string)) this.fail('Invalid navigation wait mode.');
        return { url, waitUntil: waitUntil as string, timeoutMs: this.integer(a.timeoutMs ?? 30000, 1, 120000) };
    }

    static observationArgs(a: Record<string, unknown>): CdpJsonObject {
        this.only(a, ['target', 'options']);
        const target = a.target == null ? null : this.target(a.target);
        const o = this.object(a.options ?? {});
        this.only(o, ['frameId', 'includeText', 'includeControls', 'includeFrames', 'includeRects', 'maxNodes', 'maxChars', 'cursor']);
        return { target, options: { frameId: this.nullToken(o.frameId ?? null), includeText: this.boolean(o.includeText ?? true),
            includeControls: this.boolean(o.includeControls ?? true), includeFrames: this.boolean(o.includeFrames ?? true), includeRects: this.boolean(o.includeRects ?? false),
            maxNodes: this.integer(o.maxNodes ?? 150, 1, 500), maxChars: this.integer(o.maxChars ?? 12000, 1, 32000), cursor: this.nullToken(o.cursor ?? null) } };
    }

    static screenshotArgs(a: Record<string, unknown>): CdpJsonObject {
        this.only(a, ['options']); const o = this.object(a.options ?? {});
        this.only(o, ['target', 'clip', 'fullPage', 'format', 'jpegQuality', 'maxDimension', 'attachImage']);
        const target=o.target==null?null:this.target(o.target);
        let clip:CdpJsonObject|null=null;
        if(o.clip!=null){const c=this.object(o.clip,['x','y','width','height']);for(const [key,v]of Object.entries(c))if(typeof v!=='number'||!Number.isFinite(v)||v<0||v>1000000||(['width','height'].includes(key)&&v===0))this.fail('Expected bounded positive CSS clip dimensions and nonnegative offsets.');clip=c as CdpJsonObject;}
        if((clip&&(o.fullPage??false))||(target&&(clip||(o.fullPage??false))))this.fail('Target, clip and fullPage are mutually exclusive.');
        const format = o.format ?? 'png'; if (format !== 'png' && format !== 'jpeg') this.fail('Invalid image format.');
        return { options: { target, clip, fullPage: this.boolean(o.fullPage ?? false), format,
            jpegQuality: this.integer(o.jpegQuality ?? 85, 1, 100), maxDimension: this.integer(o.maxDimension ?? 1600, 1, 4096), attachImage: this.boolean(o.attachImage ?? true) } };
    }

    static target(value:unknown): CdpJsonObject {
        const t=this.object(value);
        if(t.kind==='element') {this.only(t,['kind','elementId','documentId','frameId']);return {kind:'element',elementId:this.token(t.elementId),documentId:this.token(t.documentId),frameId:this.nullToken(t.frameId??null)};}
        this.only(t,['kind','strategy','value','name','exact','frameId','withinElementId']);
        if(t.kind!=='locator'||!['role','testId','label','placeholder','text','css'].includes(t.strategy as string)) this.fail('Unsupported target kind or strategy.');
        if(t.strategy!=='role'&&t.name!=null) this.fail('Only role targets accept name.');
        return {kind:'locator',strategy:t.strategy as string,value:this.text(t.value,4096),name:this.nullText(t.name??null,4096),exact:this.boolean(t.exact??true),frameId:this.nullToken(t.frameId??null),withinElementId:this.nullToken(t.withinElementId??null)};
    }
    static actionOptions(value:unknown):CdpJsonObject {
        const o=this.object(value??{});this.only(o,['timeoutMs','expectedDocumentId']);
        return {timeoutMs:this.integer(o.timeoutMs??10000,1,120000),expectedDocumentId:this.nullToken(o.expectedDocumentId??null)};
    }
    static inputArgs(op:string,a:Record<string,unknown>):CdpJsonObject {
        const options=this.actionOptions(a.options);
        if(op==='Click') {
            this.only(a,['target','button','clickCount','modifiers','options']);const button=a.button??'left';
            if(!['left','right'].includes(button as string))this.fail('Unsupported click button.');
            const modifiers=a.modifiers??[];
            if(!Array.isArray(modifiers)||modifiers.length>4||new Set(modifiers).size!==modifiers.length||modifiers.some(m=>!['Alt','Control','Meta','Shift'].includes(m)))this.fail('Invalid click modifiers.');
            return {target:this.target(a.target),button:button as string,clickCount:this.integer(a.clickCount??1,1,2),modifiers:modifiers as string[],options};
        }
        if(op==='Fill') {
            this.only(a,['target','value','secretRef','sensitive','options']);
            const value=a.value??null,secretRef=a.secretRef??null;
            if((value===null)===(secretRef===null))this.fail('Fill requires exactly one value or SecretRef.');
            if(value!==null&&(typeof value!=='string'||value.length>32000||value.includes('\0')))this.fail('Invalid bounded fill text.');
            return {target:this.target(a.target),value:value as string|null,secretRef:this.nullToken(secretRef),sensitive:this.boolean(a.sensitive??false),options};
        }
        this.only(a,['target','key','options']);const key=this.text(a.key,100);
        if(!/^(Enter|Tab|Shift\+Tab|Escape|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|Space|Backspace|Delete|Home|End|PageUp|PageDown|(?:Control|Meta|ControlOrMeta)\+(?:A|a|Enter|Home|End|ArrowLeft|ArrowRight))$/.test(key))throw new CdpContractError('KEY_UNSUPPORTED','Only the advertised page-scoped key vocabulary is supported.');
        return {key,target:a.target==null?null:this.target(a.target),options};
    }
    static interactionArgs(op:string,a:Record<string,unknown>):CdpJsonObject {
        const options=this.actionOptions(a.options);
        if(op==='DragAndDrop'){
            this.only(a,['source','destination','inputMethod','options']);const method=a.inputMethod??'pointer';
            if(!['pointer','syntheticDataTransfer'].includes(method as string))this.fail('Unknown drag input method.');
            return {source:this.target(a.source),destination:this.target(a.destination),inputMethod:method as string,options};
        }
        if(op==='Scroll'){
            this.only(a,['target','deltaX','deltaY','options']);
            const delta=(v:unknown):number=>{if(typeof v!=='number'||!Number.isFinite(v)||Math.abs(v)>1000000)this.fail('Expected bounded finite CSS scroll delta.');return Object.is(v,-0)?0:v;};
            return {target:a.target==null?null:this.target(a.target),deltaX:delta(a.deltaX??0),deltaY:delta(a.deltaY??0),options};
        }
        if(op==='SelectOptions'){
            this.only(a,['target','values','options']);const values=a.values;
            if(!Array.isArray(values)||values.length>128||new Set(values).size!==values.length||values.some(v=>typeof v!=='string'||v.length>4096||/[\x00-\x1f\x7f]/.test(v)))this.fail('Expected bounded unique native option values.');
            return {target:this.target(a.target),values:values as string[],options};
        }
        if(op==='SetChecked'){this.only(a,['target','checked','options']);return {target:this.target(a.target),checked:this.boolean(a.checked),options};}
        this.only(a,['target','options']);return {target:this.target(a.target),options};
    }
    static artifactArgs(a:Record<string,unknown>,limits:CdpLimits):CdpJsonObject {
        this.only(a,['artifactId','offset','maxBytes','attachImage','maxImageDimension','maxImageMiB']);
        return {artifactId:this.token(a.artifactId),offset:this.integer(a.offset??0,0,Number.MAX_SAFE_INTEGER),maxBytes:this.integer(a.maxBytes??16000,1,65536),attachImage:this.boolean(a.attachImage??false),maxImageDimension:this.integer(a.maxImageDimension??1600,1,4096),maxImageMiB:this.integer(a.maxImageMiB??8,1,Math.max(1,Math.floor(limits.values.finalImageBytes/1048576)))};
    }

    static traceArgs(a:Record<string,unknown>):CdpJsonObject {
        this.only(a,['afterEventId','throughEventId','include','maxEvents','maxBytes']);
        const after=this.eventCursor(a.afterEventId??null),through=this.eventCursor(a.throughEventId??null),include=a.include??['actions','console','network-summary'];
        if(after!==null&&through!==null&&BigInt(through)<BigInt(after))this.fail('Trace interval is reversed.');
        if(!Array.isArray(include)||!include.length||include.length>3||new Set(include).size!==include.length||include.some(value=>!['actions','console','network-summary'].includes(value)))this.fail('Expected unique supported trace sections.');
        return {afterEventId:after,throughEventId:through,include:include as string[],maxEvents:this.integer(a.maxEvents??1000,1,10000),maxBytes:this.integer(a.maxBytes??5000000,1,20000000)};
    }
    static evaluateArgs(a:Record<string,unknown>):CdpJsonObject {
        this.only(a,['script','arguments','frameId','timeoutMs','maxResultChars']);const script=a.script;
        if(typeof script!=='string'||!script.trim()||script.length>32768||Buffer.byteLength(script)>65536)this.fail('Evaluate requires bounded JavaScript function source.');
        const argument=(a.arguments??null) as CdpJson;const stats={items:0};this.evaluateArgument(argument,0,stats);
        const serialized=JSON.stringify(argument);if(serialized.length>32768||Buffer.byteLength(serialized)>65536)this.fail('Evaluate Arguments exceed helper bounds.');
        return {script,arguments:argument,frameId:this.nullToken(a.frameId??null),timeoutMs:this.integer(a.timeoutMs??10000,1,120000),maxResultChars:this.integer(a.maxResultChars??12000,1,65536)};
    }
    static evaluateArgument(value:CdpJson,depth:number,stats:{items:number}):void {
        if(++stats.items>1024||depth>12)this.fail('Evaluate Arguments exceed depth/item bounds.');
        if(value&&typeof value==='object')for(const item of Object.values(value))this.evaluateArgument(item,depth+1,stats);
    }
    static canonical(value: unknown): string {
        const safe = this.cloneJson(value, 0, new Set<object>());
        return JSON.stringify(safe);
    }
    static cloneJson(value: unknown, depth: number, seen: Set<object>): CdpJson {
        if (value instanceof CdpCapturedIdentity) value = value.toObject();
        if (depth > 32) this.fail('JSON nesting exceeds the admitted depth.');
        if (value === null) return null;
        if (typeof value === 'string' || typeof value === 'boolean') return value;
        if (typeof value === 'number' && Number.isFinite(value)) return Object.is(value, -0) ? 0 : value;
        if (typeof value !== 'object' || value === null || seen.has(value)) this.fail('Expected finite acyclic JSON data.');
        seen.add(value);
        let result: CdpJson;
        if (Array.isArray(value)) result = value.map(item => this.cloneJson(item, depth + 1, seen));
        else {
            const o = this.object(value); const target: CdpJsonObject = Object.create(null);
            for (const key of Object.keys(o).sort()) {
                if (['__proto__', 'prototype', 'constructor'].includes(key)) this.fail('Reserved JSON key.');
                target[key] = this.cloneJson(o[key], depth + 1, seen);
            }
            result = target;
        }
        seen.delete(value);
        return result;
    }
    static freezeJson<T extends CdpJson>(value: T): T {
        if (value !== null && typeof value === 'object') { for (const child of Object.values(value)) this.freezeJson(child); Object.freeze(value); }
        return value;
    }
    static object(value: unknown, fields?: readonly string[]): Record<string, unknown> {
        if (value === null || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) this.fail('Expected JSON object.');
        const result = value as Record<string, unknown>;
        if (fields) { this.only(result, fields); for (const field of fields) if (!Object.hasOwn(result, field)) this.fail('Missing required wire field.'); }
        return result;
    }
    static only(value: Record<string, unknown>, fields: readonly string[]): void { if (Object.keys(value).some(key => !fields.includes(key))) this.fail('Unknown field.'); }
    static int64(value: unknown): string {
        if (typeof value !== 'string' || !/^[1-9][0-9]{0,18}$/.test(value) || (value.length === 19 && value > '9223372036854775807')) this.fail('Expected canonical positive Int64 string.');
        return value;
    }
    static uuid(value: unknown): string { if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) this.fail('Expected canonical UUID.'); return value; }
    static clientName(value: unknown): string { if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,99}$/.test(value)) this.fail('Expected normalized client name.'); return value; }
    static token(value: unknown, max = 128): string { if (typeof value !== 'string' || value.length < 1 || value.length > max || /[\s\x00-\x1f\x7f]/.test(value)) this.fail('Invalid opaque identifier.'); return value; }
    static nullToken(value: unknown): string | null { return value === null ? null : this.token(value); }
    static text(value: unknown, max: number): string { if (typeof value !== 'string' || value.length < 1 || value.length > max || /[\x00-\x1f\x7f]/.test(value)) this.fail('Invalid bounded text.'); return value; }
    static nullText(value: unknown, max: number): string | null { return value === null ? null : this.text(value, max); }
    static integer(value: unknown, min: number, max: number): number { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) this.fail('Integer is outside the admitted range.'); return value; }
    static boolean(value: unknown): boolean { if (typeof value !== 'boolean') this.fail('Expected boolean.'); return value; }
    static fail(message: string): never { throw new CdpContractError('INVALID_WIRE', message); }
}
