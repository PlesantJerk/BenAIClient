import { CdpContract, CdpContractError, CdpLimits } from './cdp-contract.mts';
import type { CdpCommand, CdpWireCommand } from './cdp-contract.mts';
import { CdpClientBootstrap } from './cdp-bootstrap.mts';
import type { CdpBootstrapOptions, CdpConfiguredRoute, CdpOwnedRuntime } from './cdp-bootstrap.mts';
import { CdpBodyAdmission, CdpDiagnosticProjection } from './cdp-diagnostics.mts';
import type { CdpClientResponse } from './cdp-client.mts';
import { CdpLocalDiagnosticSink } from './cdp-local-diagnostics.mts';

export interface CdpBridgeOptions {
    readonly route:()=>CdpConfiguredRoute;
    readonly bootstrap?:CdpBootstrapOptions;
    readonly diagnostic?:(record:string)=>void;
    readonly handleSignals?:boolean;
}
export interface CdpBridgeFailure {readonly success:false;readonly msg:string;readonly cdpError:{readonly code:string;readonly phase:string;};}

// Importing this file does not create directories, start a poller or launch a browser.
// The existing configured route, not command context, selects the private runtime.
export class CdpClientBridge {
    readonly #options:CdpBridgeOptions;
    readonly #limits:CdpLimits;
    #runtime:CdpOwnedRuntime|null=null;
    #route:CdpConfiguredRoute|null=null;
    #shutdown:Promise<unknown>|null=null;
    #stopping=false;
    readonly #signals=new Map<NodeJS.Signals,()=>void>();
    static isCdpCandidate(value:any):boolean {return !!value && typeof value==='object' && (Object.hasOwn(value,'cdp') || (typeof value.command==='string' && value.command.trim().toLowerCase()==='cdp'));}
    static replyId(value:any):string|null {try{return CdpContract.token(value?.id);}catch{return null;}}
    constructor(options:CdpBridgeOptions) {this.#options=Object.freeze({...options});this.#limits=options.bootstrap?.limits ?? new CdpLimits();}
    #diagnosticFailures=0;
    get diagnosticFailures():number {return this.#diagnosticFailures;}
    diagnosticIdentity():{readonly clientInstallId:string;readonly clientIncarnationId:string}|undefined {
        const identity=this.#runtime?.identity;
        return identity?{clientInstallId:identity.clientInstallId,clientIncarnationId:identity.clientIncarnationId}:undefined;
    }
    async handle(value:unknown,entered?:()=>void):Promise<CdpClientResponse|CdpBridgeFailure> {
        try {entered?.();}catch{}
        let wire:CdpWireCommand|undefined;
        try {
            if(this.#stopping)throw new CdpContractError('CDP_STOPPING','CDP owned cleanup has started.');
            new CdpBodyAdmission(this.#limits.values.argumentBytes+8192).assert(value);
            wire=CdpContract.validate(value,this.#limits);
            const runtime=this.#open(wire.cdp),redactLogs=this.#redactLogs(runtime,wire.cdp);
            this.#diagnostic(()=>new CdpDiagnosticProjection().project('request',wire!,undefined,redactLogs,runtime.manager));
            const reply=await runtime.manager.execute(value);
            this.#assertReplyBytes(reply);
            // Use the exact request-time policy, never reply fields or asynchronously changed selection.
            this.#diagnostic(()=>new CdpDiagnosticProjection().project('reply',wire!,reply,redactLogs,runtime.manager));
            return reply;
        }catch(error) {
            const code=error instanceof CdpContractError&&/^[A-Z][A-Z0-9_]{0,79}$/.test(error.code)?error.code:'CDP_BRIDGE_FAILED';
            this.#diagnostic(()=>JSON.stringify({kind:'cdp-diagnostic',phase:'rejected',redactLogs:true,op:wire?.cdp.op ?? null,callId:wire?.cdp.callId ?? null,errorCode:code}));
            // No invented installation, accepted receipt or successful browser claim on bootstrap/validation failure.
            return Object.freeze({success:false,msg:'CDP command rejected or unavailable. Inspect retained state before any new input.',cdpError:Object.freeze({code,phase:'bridge'})});
        }
    }
    #redactLogs(runtime:CdpOwnedRuntime,command:CdpCommand):boolean {
        try {return runtime.manager.diagnosticLogRedaction(command);}
        catch {this.#diagnosticFailures=Math.min(2147483647,this.#diagnosticFailures+1);return true;}
    }
    #diagnostic(record:()=>string):void {
        try {this.#emit(record());}
        catch {this.#diagnosticFailures=Math.min(2147483647,this.#diagnosticFailures+1);}
    }
    #open(command:CdpCommand):CdpOwnedRuntime {
        const selected=this.#options.route(),route=Object.freeze({clientName:CdpContract.clientName(selected.clientName),email:selected.email,...(selected.rootDirectory?{rootDirectory:selected.rootDirectory}:{})});
        if(command.context.clientName!==route.clientName)throw new CdpContractError('CLIENT_BINDING_CONFLICT','CDP command does not match the existing selected client route.');
        if(this.#route&&(this.#route.clientName!==route.clientName||this.#route.email!==route.email))throw new CdpContractError('CLIENT_ROUTE_CHANGED','Existing CDP resources retain their captured route. Restart is required for a new CDP route; legacy selection is unchanged.');
        if(!this.#runtime) {this.#runtime=new CdpClientBootstrap(this.#options.bootstrap).open(route);this.#route=route;this.#runtime.manager.attachDiagnosticOwner(this);this.#attachSignals();}
        return this.#runtime;
    }
    ordinaryFill(command:CdpCommand,proof:any,value:string):void {
        if(!this.#runtime)return;
        this.#diagnostic(()=>new CdpDiagnosticProjection().ordinaryFill(command,proof,value,this.#runtime!.manager));
    }
    #assertReplyBytes(reply:CdpClientResponse):void {
        if(Buffer.byteLength(JSON.stringify(reply.cdp))>this.#limits.values.nonImageReplyBytes||Buffer.byteLength(JSON.stringify(reply))>this.#limits.values.encodedReplyBytes)throw new CdpContractError('REPLY_LIMIT','CDP reply exceeds an always-on admission bound.');
    }
    #emit(record:string):void {if(this.#options.diagnostic)this.#options.diagnostic(record);else CdpLocalDiagnosticSink.shared.record(record);}
    #attachSignals():void {
        if(!this.#options.handleSignals)return;
        for(const [signal,exitCode]of [['SIGINT',130],['SIGTERM',143]] as const) {
            const handler=()=>{void this.shutdown().then(report=>{this.#emit(JSON.stringify({kind:'cdp-owned-shutdown',report}));process.exit(exitCode);},()=>{console.error(JSON.stringify({kind:'cdp-owned-shutdown',errorCode:'CLEANUP_UNVERIFIED'}));process.exit(exitCode);});};
            this.#signals.set(signal,handler);process.once(signal,handler);
        }
    }
    shutdown(timeoutMs=10000):Promise<unknown> {
        for(const [signal,handler]of this.#signals)process.off(signal,handler);this.#signals.clear();
        this.#stopping=true;this.#shutdown ??= this.#runtime?.shutdown(timeoutMs) ?? Promise.resolve({sessions:[],pendingOperations:0,journalClosed:true});return this.#shutdown;
    }
}
