import type {CdpErrorEnvelope,CdpJsonObject} from './cdp-contract.mts';

// Internal error facts are never serialized until the captured owner OFF policy authorizes them.
// Keeps the safe classification/journal code and original phase/retry facts independent of diagnosis.
export class CdpErrorDiagnostics {
    static readonly messageBytes=2048;
    static readonly detailBytes=8192;
    readonly #native=new WeakMap<CdpErrorEnvelope,CdpJsonObject>();
    capture(envelope:CdpErrorEnvelope,source:unknown):CdpErrorEnvelope {
        const safe={...envelope,message:this.#bound(envelope.message,CdpErrorDiagnostics.messageBytes)};
        const native=this.#describe(source);
        this.#native.set(safe,native);return safe;
    }
    project(envelope:CdpErrorEnvelope|null,authorizedOwnerOff:boolean):CdpErrorEnvelope|null {
        if(!envelope||!authorizedOwnerOff)return envelope;
        const native=this.#native.get(envelope);if(!native)return envelope;
        return {...envelope,message:native.message as string,details:{...envelope.details,nativeDiagnostic:native,diagnosticScope:'captured-owner-off'}};
    }
    #describe(source:unknown):CdpJsonObject {
        const message=typeof source==='string'?this.#bound(source,CdpErrorDiagnostics.messageBytes):this.#field(source,'message',CdpErrorDiagnostics.messageBytes)??'Native error details unavailable.';
        const result:CdpJsonObject={name:this.#field(source,'name',80)??'Error',code:this.#field(source,'code',80),message,truncated:typeof source==='string'?Buffer.byteLength(source)>Buffer.byteLength(message):null};
        const errors=this.#value(source,'errors');
        if(Array.isArray(errors))result.causes=errors.slice(0,2).map(error=>({name:this.#field(error,'name',80)??'Error',code:this.#field(error,'code',80),message:this.#field(error,'message',CdpErrorDiagnostics.messageBytes)??'Cause details unavailable.'}));
        if(Buffer.byteLength(JSON.stringify(result))>CdpErrorDiagnostics.detailBytes){delete result.causes;result.truncated=true;}
        return result;
    }
    #field(source:unknown,key:string,bytes:number):string|null {const value=this.#value(source,key);return typeof value==='string'?this.#bound(value,bytes):null;}
    #value(source:unknown,key:string):unknown {
        if(!source||typeof source!=='object')return undefined;
        try{let current:object|null=source;for(let depth=0;current&&depth<4;depth++,current=Object.getPrototypeOf(current)){const field=Object.getOwnPropertyDescriptor(current,key);if(field)return 'value'in field?field.value:undefined;}}
        catch{return undefined;} // A failed diagnostic read must not replace the original failure.
        return undefined;
    }
    #bound(value:string,bytes:number):string {
        const text=value.slice(0,8192).replace(/wss?:\/\/[^\s]+/gi,'[CONTROL_ENDPOINT_OMITTED]').replace(/data:[^;\s,]{0,80};base64,[A-Za-z0-9+/=]+/gi,'[BINARY_OMITTED]');
        let result=Buffer.from(text).subarray(0,bytes).toString('utf8');while(Buffer.byteLength(result)>bytes)result=result.slice(0,-1);return result;
    }
}
