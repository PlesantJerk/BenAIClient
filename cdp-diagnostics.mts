import { CdpContract, CdpContractError } from './cdp-contract.mts';
import type { CdpCommand, CdpWireCommand } from './cdp-contract.mts';
import type { CdpClientManager, CdpClientResponse } from './cdp-client.mts';

// Runs before contract cloning, private bootstrap and any raw CDP diagnostic. The legacy batched poll
// has already parsed JSON. This is a command admission bound, not a claim to bound legacy HTTP parsing.
export class CdpBodyAdmission {
    readonly #maximum:number;
    #bytes=0;
    readonly #seen=new Set<object>();
    constructor(maximum:number) {this.#maximum=maximum;}
    assert(value:unknown):void {this.#visit(value,0);}
    #add(bytes:number):void {this.#bytes+=bytes;if(this.#bytes>this.#maximum)throw new CdpContractError('CDP_BODY_LIMIT','CDP command exceeds its admitted byte bound.');}
    #string(value:string):void {
        if(value.length>this.#maximum)throw new CdpContractError('CDP_BODY_LIMIT','CDP string exceeds its admitted byte bound.');
        this.#add(Buffer.byteLength(JSON.stringify(value)));
    }
    #visit(value:unknown,depth:number):void {
        if(depth>32)throw new CdpContractError('INVALID_WIRE','CDP JSON nesting is excessive.');
        if(value===null||typeof value==='boolean'||(typeof value==='number'&&Number.isFinite(value))){this.#add(JSON.stringify(value).length);return;}
        if(typeof value==='string'){this.#string(value);return;}
        if(typeof value!=='object'||this.#seen.has(value))throw new CdpContractError('INVALID_WIRE','CDP JSON must be finite and acyclic.');
        if(!Array.isArray(value)&&![Object.prototype,null].includes(Object.getPrototypeOf(value)))throw new CdpContractError('INVALID_WIRE','CDP JSON requires plain objects.');
        this.#seen.add(value);this.#add(2);
        const keys=Object.keys(value);
        for(let index=0;index<keys.length;index++) {
            const key=keys[index],descriptor=Object.getOwnPropertyDescriptor(value,key)!;
            if(!Object.hasOwn(descriptor,'value'))throw new CdpContractError('INVALID_WIRE','CDP accessors are not data.');
            if(index)this.#add(1);
            if(!Array.isArray(value)){this.#string(key);this.#add(1);}
            this.#visit(descriptor.value,depth+1);
        }
        if(Array.isArray(value)&&keys.length!==value.length)throw new CdpContractError('INVALID_WIRE','Sparse CDP arrays are not data.');
        this.#seen.delete(value);
    }
}

// Authorized OFF exposes bounded diagnostic values, including sensitive Fill text.
// Transfer bytes stay excluded. This is functionality-first logging, not a privacy guarantee.
// This projects only feature-local diagnostic output. It does not change any generic logger.
export class CdpDiagnosticProjection {
    static readonly maximumBytes=16384;
    #visited=0;
    project(phase:'request'|'reply',wire:CdpWireCommand,reply:CdpClientResponse|undefined,redactLogs:boolean,manager:CdpClientManager):string {
        const command=wire.cdp;
        const metadata={kind:'cdp-diagnostic',phase,redactLogs,op:command.op,callId:command.callId,sessionId:command.sessionId,pageId:command.pageId,state:reply?.cdp.receipt?.state ?? null,errorCode:reply?.cdp.error?.code ?? null};
        if(redactLogs)return JSON.stringify(metadata);
        const source=phase==='request'?wire:reply;
        const safe=this.#sanitize(source,command,0);
        let raw=JSON.stringify(safe),truncated=false;
        if(Buffer.byteLength(raw)>CdpDiagnosticProjection.maximumBytes){raw=Buffer.from(raw).subarray(0,CdpDiagnosticProjection.maximumBytes).toString('utf8');truncated=true;}
        let record=JSON.stringify({...metadata,raw,truncated});
        while(Buffer.byteLength(record)>CdpDiagnosticProjection.maximumBytes){raw=raw.slice(0,Math.max(0,Math.floor(raw.length*0.8)));truncated=true;record=JSON.stringify({...metadata,raw,truncated});}
        return record;
    }
    ordinaryFill(command:CdpCommand,proof:Record<string,any>,value:string,manager:CdpClientManager):string {
        if(command.op!=='Fill'||command.context.access!=='owner'||command.args.sensitive!==false||command.args.secretRef!==null||proof.classification!=='ordinary'||manager.diagnosticLogRedaction(command))throw new CdpContractError('DIAGNOSTIC_SCOPE_UNAVAILABLE','Only completed classified owner OFF Fill can expose ordinary text.');
        for(const key of ['elementId','documentId','frameId'])CdpContract.token(proof[key]);
        const metadata={kind:'cdp-diagnostic',phase:'classifiedFill',redactLogs:false,op:'Fill',callId:command.callId,sessionId:command.sessionId,pageId:command.pageId,fillDiagnostic:proof};
        let text=manager.sanitizeDiagnostics(command,value),truncated=false,record=JSON.stringify({...metadata,typedValue:text,truncated});
        while(Buffer.byteLength(record)>CdpDiagnosticProjection.maximumBytes){text=text.slice(0,Math.floor(text.length*0.8));truncated=true;record=JSON.stringify({...metadata,typedValue:text,truncated});}
        return record;
    }
    #sanitize(value:any,command:CdpCommand,depth:number):any {
        if(++this.#visited>4096||depth>24)return '[BOUNDED]';
        if(value===null||typeof value==='boolean'||typeof value==='number'||typeof value==='string')return value;
        if(Array.isArray(value))return value.map(item=>this.#sanitize(item,command,depth+1));
        if(value&&typeof value==='object') {
            const result:Record<string,unknown>={};
            for(const [key,item]of Object.entries(value)) {
                if(['dataBase64','file_base_64','image','hmacKey','endpoint'].includes(key))result[key]='[REDACTED]';
                else result[key]=this.#sanitize(item,command,depth+1);
            }
            return result;
        }
        return '[UNSUPPORTED]';
    }
}
