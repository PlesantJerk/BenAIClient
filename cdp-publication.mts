import { CdpContract } from './cdp-contract.mts';
import { CdpProducer } from './cdp-provenance.mts';
import type { CdpDiagnosticTransport, CdpFetch, CdpPublicationMetrics, CdpPublicationScope, CdpPublicationPhase } from './cdp-provenance.mts';

export interface CdpPublicationBridge {
    handle(command:unknown,entered?:()=>void):Promise<unknown>;
    diagnosticIdentity():{readonly clientInstallId:string;readonly clientIncarnationId:string}|undefined;
}
export interface CdpPublicationOptions {readonly diagnostics:CdpDiagnosticTransport;readonly fetch?:CdpFetch;readonly replyDeadlineMs?:number;}
export interface CdpPublicationOutcome {
    readonly postAttempted:boolean;
    readonly state:'http-response-settled'|'failed'|'unaddressable';
    readonly serverAcceptance:'unknown';readonly httpStatus?:number;readonly errorCode?:string;
}

// Only the CDP branch uses this publisher. No retry, alternative POST or business
// receipt/result is manufactured after a send starts, including an ambiguous send.
export class CdpCommandPublication {
    readonly #options:CdpPublicationOptions;
    constructor(options:CdpPublicationOptions) {
        if(options.replyDeadlineMs!==undefined&&(!Number.isInteger(options.replyDeadlineMs)||options.replyDeadlineMs<1||options.replyDeadlineMs>10000))throw new RangeError('CDP reply deadline must be 1..10000ms.');
        this.#options=options;
    }
    unexpectedFailure(command:unknown):void {
        try {const id=CdpContract.token((command as any)?.id);this.#phase(this.#scope(command,id),'reply-failed',{errorCode:'CDP_PUBLICATION_BOUNDARY_FAILED'});}catch{}
    }
    async execute(command:unknown,bridge:CdpPublicationBridge):Promise<CdpPublicationOutcome> {
        let id:string|null=null;try{id=CdpContract.token((command as any)?.id);}catch{}
        const scope=this.#scope(command,id);
        try {await this.#options.diagnostics.received(scope);}catch{}
        let reply:unknown;
        try {reply=await bridge.handle(command,()=>this.#phase(scope,'bridge-entered',this.#identity(bridge)));}
        catch {reply=this.#fallback('CDP_HANDLER_FAILED');}
        let body:string;
        try {body=this.#serialize(reply);}
        catch {body=this.#serialize(this.#fallback('CDP_REPLY_SERIALIZATION_FAILED'));}
        const metrics={...this.#identity(bridge),responseBytes:Buffer.byteLength(body)};
        this.#phase(scope,'response-constructed',metrics);
        if(id===null){this.#phase(scope,'reply-failed',{...metrics,errorCode:'CDP_REPLY_ID_UNAVAILABLE'});return {postAttempted:false,state:'unaddressable',serverAcceptance:'unknown',errorCode:'CDP_REPLY_ID_UNAVAILABLE'};}
        return this.#post(id,body,scope,metrics);
    }
    #scope(command:unknown,id:string|null):CdpPublicationScope|null {try{return this.#options.diagnostics.scope(command,id);}catch{return null;}}
    #identity(bridge:CdpPublicationBridge):CdpPublicationMetrics {
        try {const identity=bridge.diagnosticIdentity();if(identity&&CdpProducer.uuid(identity.clientInstallId)&&CdpProducer.uuid(identity.clientIncarnationId))return {clientInstallId:identity.clientInstallId,clientIncarnationId:identity.clientIncarnationId};}catch{}
        return {};
    }
    #phase(scope:CdpPublicationScope|null,phase:CdpPublicationPhase,metrics:CdpPublicationMetrics={}):void {try{this.#options.diagnostics.phase(scope,phase,metrics);}catch{}}
    #serialize(value:unknown):string {const body=JSON.stringify(value);if(typeof body!=='string')throw new Error('CDP_REPLY_SERIALIZATION_FAILED');return body;}
    #fallback(code:string):unknown {return {success:false,msg:'CDP response unavailable. Inspect retained state before any new input.',cdpError:{code,phase:'publication'}};}
    async #post(id:string,body:string,scope:CdpPublicationScope|null,metrics:CdpPublicationMetrics):Promise<CdpPublicationOutcome> {
        const controller=new AbortController();let httpStatus:number|undefined,timer:ReturnType<typeof setTimeout>;
        const deadline=this.#options.replyDeadlineMs??10000;
        const timeout=new Promise<CdpPublicationOutcome>(resolve=>{timer=setTimeout(()=>{controller.abort();resolve(this.#failure(scope,metrics,'CDP_REPLY_TIMEOUT',httpStatus));},deadline);});
        this.#phase(scope,'reply-post-started',metrics);
        const attempt=this.#request(id,body,controller,scope,metrics,status=>{httpStatus=status;});
        try {return await Promise.race([attempt,timeout]);}
        finally {clearTimeout(timer!);controller.abort();}
    }
    async #request(id:string,body:string,controller:AbortController,scope:CdpPublicationScope|null,metrics:CdpPublicationMetrics,status:(value:number)=>void):Promise<CdpPublicationOutcome> {
        let response:Response;
        try {response=await (this.#options.fetch??fetch)('https://benai.org/debugger_reply?id='+encodeURIComponent(id),{method:'POST',body,signal:controller.signal});}
        catch {if(controller.signal.aborted)return {postAttempted:true,state:'failed',serverAcceptance:'unknown',errorCode:'CDP_REPLY_TIMEOUT'};return this.#failure(scope,metrics,'CDP_REPLY_FETCH_FAILED');}
        if(controller.signal.aborted)return {postAttempted:true,state:'failed',serverAcceptance:'unknown',errorCode:'CDP_REPLY_TIMEOUT'};
        status(response.status);this.#phase(scope,'reply-http-status',{...metrics,httpStatus:response.status});
        try {await response.text();}
        catch {if(controller.signal.aborted)return {postAttempted:true,state:'failed',serverAcceptance:'unknown',httpStatus:response.status,errorCode:'CDP_REPLY_TIMEOUT'};return this.#failure(scope,metrics,'CDP_REPLY_BODY_FAILED',response.status);}
        if(controller.signal.aborted)return {postAttempted:true,state:'failed',serverAcceptance:'unknown',httpStatus:response.status,errorCode:'CDP_REPLY_TIMEOUT'};
        this.#phase(scope,'reply-body-settled',{...metrics,httpStatus:response.status});
        if(response.status<200||response.status>=300)return this.#failure(scope,metrics,'CDP_REPLY_HTTP_STATUS',response.status);
        return {postAttempted:true,state:'http-response-settled',serverAcceptance:'unknown',httpStatus:response.status};
    }
    #failure(scope:CdpPublicationScope|null,metrics:CdpPublicationMetrics,errorCode:string,httpStatus?:number):CdpPublicationOutcome {
        this.#phase(scope,'reply-failed',{...metrics,errorCode,...(httpStatus===undefined?{}:{httpStatus})});
        return {postAttempted:true,state:'failed',serverAcceptance:'unknown',errorCode,...(httpStatus===undefined?{}:{httpStatus})};
    }
}
