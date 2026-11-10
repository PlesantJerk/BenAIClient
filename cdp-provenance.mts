import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

export interface CdpProducerFacts {
    readonly hostName:string;readonly platform:string;readonly architecture:string;readonly nodeVersion:string;
    readonly pid:number;readonly processInstanceId:string;readonly nodeTimeOriginUtc:string;
}
export interface CdpProducerInfo extends CdpProducerFacts {readonly v:1;readonly clientName:string;}
export type CdpPublicationPhase='received'|'bridge-entered'|'response-constructed'|'reply-post-started'|'reply-http-status'|'reply-body-settled'|'reply-failed';
export interface CdpPublicationMetrics {
    readonly responseBytes?:number;readonly httpStatus?:number;readonly errorCode?:string;
    readonly clientInstallId?:string;readonly clientIncarnationId?:string;
}
export interface CdpPublicationScope {
    readonly transportId:string;readonly callId?:string;readonly op?:string;
    readonly producer:CdpProducerInfo;readonly started:number;
}
export type CdpFetch=(url:string,options:RequestInit)=>Promise<Response>;

// Facts are process-local observations, not routing/authentication or proof that
// a checkout's current disk HEAD is the code loaded by this process.
export class CdpProducer {
    static #bootCache:CdpProducerFacts|null|undefined;
    static #sequence=0;
    readonly #facts:CdpProducerFacts|null;
    readonly #name:()=>string;
    constructor(name:()=>string,facts?:CdpProducerFacts) {this.#name=name;this.#facts=facts??CdpProducer.#bootFacts();}
    static #bootFacts():CdpProducerFacts|null {
        if(this.#bootCache!==undefined)return this.#bootCache;
        try {this.#bootCache=Object.freeze({hostName:hostname(),platform:process.platform,architecture:process.arch,nodeVersion:process.version,pid:process.pid,processInstanceId:randomUUID(),nodeTimeOriginUtc:new Date(performance.timeOrigin).toISOString()});}
        catch{this.#bootCache=null;}
        return this.#bootCache;
    }
    static uuid(value:unknown):value is string {return typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);}
    static nextSequence():number {return this.#sequence=Math.min(2147483647,this.#sequence+1);}
    snapshot():CdpProducerInfo|null {
        try {
            const facts=this.#facts,clientName=(this.#name()??'').trim().toLowerCase()||'default';
            if(!facts||!/^[a-z0-9][a-z0-9._-]{0,99}$/.test(clientName)||!this.#validFacts(facts))return null;
            return Object.freeze({v:1,hostName:facts.hostName,platform:facts.platform,architecture:facts.architecture,nodeVersion:facts.nodeVersion,pid:facts.pid,processInstanceId:facts.processInstanceId,nodeTimeOriginUtc:facts.nodeTimeOriginUtc,clientName});
        }catch{return null;}
    }
    #validFacts(facts:CdpProducerFacts):boolean {
        for(const [key,maximum]of [['hostName',128],['platform',32],['architecture',32],['nodeVersion',32]] as const) {
            const value=facts[key];if(typeof value!=='string'||!value.length||value.length>maximum||/[\u0000-\u001f\u007f]/.test(value))return false;
        }
        return Number.isInteger(facts.pid)&&facts.pid>0&&facts.pid<=2147483647&&CdpProducer.uuid(facts.processInstanceId)&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(facts.nodeTimeOriginUtc)&&Number.isFinite(Date.parse(facts.nodeTimeOriginUtc));
    }
    pollQuery():string {
        try {const value=this.snapshot();if(!value)return '';const json=JSON.stringify(value);return Buffer.byteLength(json)<=2048?'&cdp_producer='+encodeURIComponent(json):'';}
        catch{return '';}
    }
}

interface CdpDiagnosticEntry {readonly body:string;readonly bytes:number;readonly controller:AbortController;timer:ReturnType<typeof setTimeout>;expired:boolean;resolve?:(accepted:boolean)=>void;}
export interface CdpDiagnosticTransportOptions {readonly producer:CdpProducer;readonly fetch?:CdpFetch;readonly localDropped?:()=>number;}

// One bounded lane. If a fetch ignores abort indefinitely it retains only the
// single active slot; later records expire/drop, never unbounded new requests.
export class CdpDiagnosticTransport {
    static readonly #operations=new Set(['GetCapabilities','GetSessions','CreateSession','CreatePage','GetPages','CloseSession','GetAction','GetCall','Navigate','Observe','Screenshot','ReadArtifact','Click','Fill','PressKey','InspectElement','CreateWatch','WaitFor','CancelWatch','ReadEvents','ClosePage','Reload','SetViewport','Hover','SelectOptions','SetChecked','Scroll','DragAndDrop','HandleDialog','GetNetworkExchange','SetInputFiles','Evaluate','ExportTrace']);
    readonly #options:CdpDiagnosticTransportOptions;
    readonly #queue:CdpDiagnosticEntry[]=[];
    #active:CdpDiagnosticEntry|null=null;
    #bytes=0;
    #dropped=0;
    constructor(options:CdpDiagnosticTransportOptions) {this.#options=options;}
    get droppedEvents():number {return this.#dropped;}
    scope(command:any,transportId:string|null):CdpPublicationScope|null {
        try {
            const producer=this.#options.producer.snapshot();if(!producer||!CdpProducer.uuid(transportId))return null;
            const callId=command?.cdp?.callId,op=command?.cdp?.op;
            return Object.freeze({transportId,producer,started:performance.now(),...(CdpProducer.uuid(callId)?{callId}:{}),...(CdpDiagnosticTransport.#operations.has(op)?{op}:{})});
        }catch{return null;}
    }
    received(scope:CdpPublicationScope|null):Promise<boolean> {
        if(!scope)return Promise.resolve(false);
        return new Promise(resolve=>this.#enqueue(scope,'received',{},resolve));
    }
    phase(scope:CdpPublicationScope|null,phase:CdpPublicationPhase,metrics:CdpPublicationMetrics={}):void {if(scope)this.#enqueue(scope,phase,metrics);}
    #event(scope:CdpPublicationScope,phase:CdpPublicationPhase,metrics:CdpPublicationMetrics):string {
        const value:Record<string,unknown>={v:1,transportId:scope.transportId,...(scope.callId?{callId:scope.callId}:{}),...(scope.op?{op:scope.op}:{}),phase,producer:scope.producer,sequence:CdpProducer.nextSequence(),elapsedMs:Math.min(2147483647,Math.max(0,Math.floor(performance.now()-scope.started))),droppedDiagnosticEvents:this.#dropped};
        try {const count=this.#options.localDropped?.();if(typeof count==='number'&&Number.isInteger(count)&&count>=0)value.droppedLocalRecords=Math.min(2147483647,count);}catch{}
        for(const key of ['responseBytes','httpStatus'] as const) {
            const number=metrics[key];if(typeof number==='number'&&Number.isInteger(number)&&number>=0&&number<=2147483647)value[key]=number;
        }
        for(const key of ['clientInstallId','clientIncarnationId'] as const)if(CdpProducer.uuid(metrics[key]))value[key]=metrics[key];
        if(typeof metrics.errorCode==='string'&&/^[A-Z][A-Z0-9_]{0,79}$/.test(metrics.errorCode))value.errorCode=metrics.errorCode;
        return JSON.stringify(value);
    }
    #enqueue(scope:CdpPublicationScope,phase:CdpPublicationPhase,metrics:CdpPublicationMetrics,resolve?:(accepted:boolean)=>void):void {
        try {
            const body=this.#event(scope,phase,metrics),bytes=Buffer.byteLength(body);
            if(bytes>4096||this.#queue.length+(this.#active?1:0)>=16||this.#bytes+bytes>65536){this.#drop();resolve?.(false);return;}
            const entry:CdpDiagnosticEntry={body,bytes,controller:new AbortController(),timer:undefined!,expired:false,resolve};
            entry.timer=setTimeout(()=>this.#expire(entry),150);this.#queue.push(entry);this.#bytes+=bytes;this.#pump();
        }catch{this.#drop();resolve?.(false);}
    }
    #drop():void {this.#dropped=Math.min(2147483647,this.#dropped+1);}
    #expire(entry:CdpDiagnosticEntry):void {
        if(entry.expired)return;entry.expired=true;this.#drop();entry.resolve?.(false);entry.resolve=undefined;entry.controller.abort();
        this.#pump();
    }
    #pump():void {
        if(this.#active)return;
        let entry:CdpDiagnosticEntry|undefined;
        while((entry=this.#queue.shift())&&entry.expired)this.#bytes-=entry.bytes;
        if(!entry)return;this.#active=entry;const current=entry;
        try {Promise.resolve((this.#options.fetch??fetch)('https://benai.org/cdp_diagnostic',{method:'POST',headers:{'content-type':'application/json'},body:entry.body,signal:entry.controller.signal})).then(response=>this.#settled(current,response.status===202),()=>this.#settled(current,false));}
        catch{this.#settled(current,false);}
    }
    #settled(entry:CdpDiagnosticEntry,accepted:boolean):void {
        if(this.#active!==entry)return;
        clearTimeout(entry.timer);if(!entry.expired){if(!accepted)this.#drop();entry.resolve?.(accepted);}
        entry.resolve=undefined;entry.controller.abort();this.#active=null;this.#bytes-=entry.bytes;this.#pump();
    }
}
