import {randomUUID} from 'node:crypto';
import type {CDPSession,Page} from 'playwright-core';

export interface CdpNetworkOwner {
    readonly page:Page;
    readonly pageId:string;
    captureNetworkEvent(event:CdpNetworkEvent):void;
}
export interface CdpNetworkEvent {
    readonly kind:'request'|'response';
    readonly pageId:string;
    readonly frameId:null;
    readonly documentId:null;
    readonly capturedAtUtc:string;
    readonly data:Readonly<Record<string,unknown>>;
}
export interface CdpNetworkLimits {
    maxRecords:number;
    maxRetainedBytes:number;
    maxResourceBufferBytes:number;
    maxTotalBufferBytes:number;
    maxPostDataBytes:number;
    maxHeaderBytes:number;
    maxUrlChars:number;
    maxConcurrentBodyReads:number;
    bodyReadTimeoutMs:number;
}
export interface CdpNetworkOptions {
    includeRequestBody?:boolean;
    includeResponseBody?:boolean;
    maxBodyChars?:number;
}
export interface CdpNetworkBody {
    state:'captured'|'unavailable'|'omitted'|'notRequested';
    reason:string|null;
    source:string;
    representation:'cdp-postData-text'|'decoded-text'|null;
    text:string|null;
    utf8ByteLength:number|null;
    truncated:boolean;
}
interface NetworkRecord {
    networkRequestId:string;
    source:{cdpSessionScope:string;nativeRequestId:string;redirectHop:number|null;nativeFrameId:string;loaderId:string};
    pageId:string;frameId:null;documentId:null;
    frameScope:'main';logicalFrameMapping:'unknown';
    capturedAtUtc:string;method:string;url:string;urlTruncated:boolean;resourceType:string;
    state:'requesting'|'responding'|'completed'|'redirected'|'failed'|'detached';
    redirectedFrom:string|null;redirectedTo:string|null;priorHopUnavailable:boolean;
    status:number|null;failure:{errorText:string;canceled:boolean;blockedReason:string|null}|null;
    requestHeaders:NetworkHeaders;responseHeaders:NetworkHeaders|null;
    contentType:string|null;requestContentType:string|null;
    timing:{requestMonotonicSeconds:number;requestWallTimeSeconds:number;responseMonotonicSeconds:number|null;finishedMonotonicSeconds:number|null;durationMs:number|null;response:Record<string,number>|null};
    decodedBytesReceived:number;encodedBytesReceived:number|null;responseContentLength:number|null;
    fromDiskCache:boolean|null;fromServiceWorker:boolean|null;
    requestBody:CdpNetworkBody;responseBody:CdpNetworkBody;
}
interface NetworkHeaders {values:{name:string;value:string}[];truncated:boolean;source:string;rawHeadersCaptured:false;}

export class CdpNetworkError extends Error {
    readonly code:string;
    constructor(code:string,message:string){super(message);this.name='CdpNetworkError';this.code=code;}
}

/** One page, one owned CDPSession, one authoritative logical request/hop ID stream. */
export class CdpNetworkRecorder {
    readonly #owner:CdpNetworkOwner;
    readonly #session:CDPSession;
    readonly #limits:Readonly<CdpNetworkLimits>;
    readonly #scope=randomUUID();
    readonly #records=new Map<string,NetworkRecord>();
    readonly #current=new Map<string,NetworkRecord>();
    readonly #evicted=new Set<string>();
    readonly #reads=new Map<string,Promise<CdpNetworkBody>>();
    readonly #listeners:{name:string;listener:(event:any)=>void}[]=[];
    #mainFrameId='';
    #retainedBytes=0;
    #evictedCount=0;
    #ignoredFrames=0;
    #detached=false;
    #disposed=false;
    #captureFailure:string|null=null;

    private constructor(owner:CdpNetworkOwner,session:CDPSession,limits:Readonly<CdpNetworkLimits>){
        this.#owner=owner;this.#session=session;this.#limits=limits;
    }
    static async create(owner:CdpNetworkOwner,options:Partial<CdpNetworkLimits>={}):Promise<CdpNetworkRecorder>{
        if(!owner.pageId||owner.pageId.length>128)throw new CdpNetworkError('INVALID_NETWORK_OWNER','A bounded owned page ID is required.');
        const limits=this.#validateLimits(options),session=await owner.page.context().newCDPSession(owner.page);
        const recorder=new CdpNetworkRecorder(owner,session,limits);
        try{await recorder.#start();return recorder;}catch(error){await recorder.dispose();throw error;}
    }
    static #validateLimits(options:Partial<CdpNetworkLimits>):Readonly<CdpNetworkLimits>{
        if(!options||typeof options!=='object'||Array.isArray(options))throw new CdpNetworkError('INVALID_NETWORK_LIMIT','Expected network limits object.');
        const value:CdpNetworkLimits={maxRecords:128,maxRetainedBytes:1048576,maxResourceBufferBytes:32768,maxTotalBufferBytes:262144,maxPostDataBytes:8192,maxHeaderBytes:4096,maxUrlChars:4096,maxConcurrentBodyReads:2,bodyReadTimeoutMs:3000,...options};
        const ranges:Record<string,[number,number]>={maxRecords:[1,1024],maxRetainedBytes:[16384,8388608],maxResourceBufferBytes:[1024,65536],maxTotalBufferBytes:[1024,8388608],maxPostDataBytes:[1,65536],maxHeaderBytes:[128,16384],maxUrlChars:[128,16384],maxConcurrentBodyReads:[1,4],bodyReadTimeoutMs:[100,10000]};
        for(const key of Object.keys(options))if(!Object.hasOwn(ranges,key))throw new CdpNetworkError('INVALID_NETWORK_LIMIT','Unknown network limit.');
        for(const [key,[min,max]]of Object.entries(ranges))if(!Number.isSafeInteger(value[key as keyof CdpNetworkLimits])||value[key as keyof CdpNetworkLimits]<min||value[key as keyof CdpNetworkLimits]>max)throw new CdpNetworkError('INVALID_NETWORK_LIMIT','Network limit is outside its bounded range.');
        if(value.maxTotalBufferBytes<value.maxResourceBufferBytes)throw new CdpNetworkError('INVALID_NETWORK_LIMIT','Total browser buffer must cover one resource.');
        return Object.freeze(value);
    }
    async #start():Promise<void>{
        this.#on('close',()=>this.#closed());
        this.#on('Page.frameNavigated',event=>{if(!event.frame.parentId)this.#mainFrameId=event.frame.id;});
        this.#on('Network.requestWillBeSent',event=>this.#request(event));
        this.#on('Network.responseReceived',event=>this.#response(event));
        this.#on('Network.dataReceived',event=>this.#data(event));
        this.#on('Network.loadingFinished',event=>this.#finished(event));
        this.#on('Network.loadingFailed',event=>this.#failed(event));
        const tree=await this.#session.send('Page.getFrameTree',{}, {timeout:this.#limits.bodyReadTimeoutMs});
        this.#mainFrameId=tree.frameTree.frame.id;
        await this.#session.send('Page.enable',{}, {timeout:this.#limits.bodyReadTimeoutMs});
        await this.#session.send('Network.enable',{maxTotalBufferSize:this.#limits.maxTotalBufferBytes,maxResourceBufferSize:this.#limits.maxResourceBufferBytes,maxPostDataSize:this.#limits.maxPostDataBytes}, {timeout:this.#limits.bodyReadTimeoutMs});
    }
    #on(name:string,listener:(event:any)=>void):void{
        const guarded=(event:any):void=>{if(this.#disposed)return;try{listener(event);}catch{this.#captureFailure='NETWORK_EVENT_CAPTURE_FAILED';}};
        this.#listeners.push({name,listener:guarded});this.#session.on(name as any,guarded);
    }
    #request(event:any):void{
        if(typeof event.requestId!=='string'||event.requestId.length>256||!event.requestId.length){this.#captureFailure='UNSUPPORTED_NATIVE_REQUEST_ID';return;}
        const prior=this.#current.get(event.requestId);
        if(prior&&event.redirectResponse)this.#redirect(prior,event.redirectResponse,event.timestamp);
        else if(prior){prior.responseBody=this.#body('unavailable','NATIVE_ID_REUSED','Network');prior.state='detached';this.#current.delete(event.requestId);}
        if(!event.frameId||event.frameId!==this.#mainFrameId){this.#ignoredFrames++;return;}
        const record=this.#newRecord(event,prior);
        if(prior&&event.redirectResponse)prior.redirectedTo=record.networkRequestId;
        this.#records.set(record.networkRequestId,record);this.#current.set(event.requestId,record);
        this.#balance();this.#emit('request',record);
    }
    #newRecord(event:any,prior:NetworkRecord|undefined):NetworkRecord{
        const request=event.request,headers=this.#headers(request.headers,'Network.requestWillBeSent.request.headers');
        const contentType=this.#header(headers,'content-type'),url=this.#text(request.url,this.#limits.maxUrlChars);
        return {networkRequestId:randomUUID(),source:{cdpSessionScope:this.#scope,nativeRequestId:this.#text(event.requestId,256),redirectHop:event.redirectResponse?(prior&&prior.source.redirectHop!==null?prior.source.redirectHop+1:null):0,nativeFrameId:this.#text(event.frameId,256),loaderId:this.#text(event.loaderId??'',256)},pageId:this.#owner.pageId,frameId:null,documentId:null,frameScope:'main',logicalFrameMapping:'unknown',capturedAtUtc:new Date().toISOString(),method:this.#text(request.method,32),url,urlTruncated:url!==request.url,resourceType:this.#text(event.type??'Unknown',64),state:'requesting',redirectedFrom:event.redirectResponse?prior?.networkRequestId??null:null,redirectedTo:null,priorHopUnavailable:!!event.redirectResponse&&!prior,status:null,failure:null,requestHeaders:headers,responseHeaders:null,contentType:null,requestContentType:contentType,timing:{requestMonotonicSeconds:event.timestamp,requestWallTimeSeconds:event.wallTime,responseMonotonicSeconds:null,finishedMonotonicSeconds:null,durationMs:null,response:null},decodedBytesReceived:0,encodedBytesReceived:null,responseContentLength:null,fromDiskCache:null,fromServiceWorker:null,requestBody:this.#postBody(request,headers,contentType),responseBody:this.#body('unavailable','LOADING','Network.getResponseBody')};
    }
    #postBody(request:any,headers:NetworkHeaders,contentType:string|null):CdpNetworkBody{
        if(!request.hasPostData&&typeof request.postData!=='string')return this.#body('unavailable','NO_REQUEST_BODY','Network.requestWillBeSent.postData');
        const length=this.#contentLength(headers);
        if(length!==null&&length>this.#limits.maxPostDataBytes)return this.#body('omitted','REQUEST_POST_DATA_LIMIT','Network.requestWillBeSent.postData');
        if(typeof request.postData!=='string')return this.#body('unavailable','POST_DATA_NOT_IN_EVENT','Network.requestWillBeSent.postData');
        if(Buffer.byteLength(request.postData)>this.#limits.maxPostDataBytes)return this.#body('omitted','REQUEST_POST_DATA_LIMIT','Network.requestWillBeSent.postData');
        if(!this.#textMedia(contentType))return this.#body('unavailable','UNSUPPORTED_MEDIA_TYPE','Network.requestWillBeSent.postData');
        return {...this.#body('captured',null,'Network.requestWillBeSent.postData'),representation:'cdp-postData-text',text:request.postData,utf8ByteLength:Buffer.byteLength(request.postData)};
    }
    #redirect(record:NetworkRecord,response:any,timestamp:number):void{
        this.#applyResponse(record,response,timestamp);record.state='redirected';this.#endTiming(record,timestamp);
        record.responseBody=this.#body('unavailable','REDIRECT_BODY_UNAVAILABLE','Network.getResponseBody');
        this.#emit('response',record);
    }
    #response(event:any):void{
        const record=this.#current.get(event.requestId);if(!record)return;
        this.#applyResponse(record,event.response,event.timestamp);record.state='responding';this.#balance();this.#emit('response',record);
    }
    #applyResponse(record:NetworkRecord,response:any,timestamp:number):void{
        record.status=response.status;record.responseHeaders=this.#headers(response.headers,'Network.responseReceived.response.headers');
        record.contentType=this.#header(record.responseHeaders,'content-type')??this.#text(response.mimeType??'',128);
        record.responseContentLength=this.#contentLength(record.responseHeaders);record.timing.responseMonotonicSeconds=timestamp;
        record.fromDiskCache=response.fromDiskCache??false;record.fromServiceWorker=response.fromServiceWorker??false;
        const timing:Record<string,number>={};
        for(const key of ['requestTime','proxyStart','proxyEnd','dnsStart','dnsEnd','connectStart','connectEnd','sslStart','sslEnd','sendStart','sendEnd','receiveHeadersStart','receiveHeadersEnd'])if(Number.isFinite(response.timing?.[key]))timing[key]=response.timing[key];
        record.timing.response=response.timing?timing:null;
    }
    #data(event:any):void{
        const record=this.#current.get(event.requestId);if(!record)return;
        record.decodedBytesReceived=Math.min(Number.MAX_SAFE_INTEGER,record.decodedBytesReceived+Math.max(0,event.dataLength));
    }
    #finished(event:any):void{
        const record=this.#current.get(event.requestId);if(!record)return;
        record.state='completed';record.encodedBytesReceived=event.encodedDataLength;this.#endTiming(record,event.timestamp);
        record.responseBody=this.#body('unavailable',this.#responseOmission(record)??'NOT_READ','Network.getResponseBody');this.#balance();
    }
    #endTiming(record:NetworkRecord,timestamp:number):void{
        record.timing.finishedMonotonicSeconds=timestamp;record.timing.durationMs=Math.max(0,(timestamp-record.timing.requestMonotonicSeconds)*1000);
    }
    #failed(event:any):void{
        const record=this.#current.get(event.requestId);if(!record)return;
        record.state='failed';record.failure={errorText:this.#text(event.errorText,256),canceled:event.canceled===true,blockedReason:event.blockedReason?this.#text(event.blockedReason,128):null};
        this.#endTiming(record,event.timestamp);record.responseBody=this.#body('unavailable','REQUEST_FAILED','Network.getResponseBody');this.#balance();
    }
    #emit(kind:'request'|'response',record:NetworkRecord):void{
        this.#owner.captureNetworkEvent(Object.freeze({kind,pageId:record.pageId,frameId:null,documentId:null,capturedAtUtc:new Date().toISOString(),data:Object.freeze({networkRequestId:record.networkRequestId,method:record.method,url:record.url,status:record.status,resourceType:record.resourceType,frameScope:'main',nativeFrameId:record.source.nativeFrameId,logicalFrameMapping:'unknown',redirectedFrom:record.redirectedFrom,bodyCaptured:kind==='request'?record.requestBody.state==='captured':record.responseBody.state==='captured',headersCaptured:true})}));
    }
    #headers(input:Record<string,unknown>,source:string):NetworkHeaders{
        const result:NetworkHeaders={values:[],truncated:false,source,rawHeadersCaptured:false};let bytes=0;
        for(const name in input){
            if(!Object.hasOwn(input,name))continue;
            const value=String(input[name]);const size=Buffer.byteLength(name)+Buffer.byteLength(value);
            if(result.values.length>=32||bytes+size>this.#limits.maxHeaderBytes){result.truncated=true;continue;}
            result.values.push({name,value});bytes+=size;
        }
        return result;
    }
    #header(headers:NetworkHeaders,name:string):string|null{return headers.values.find(item=>item.name.toLowerCase()===name)?.value??null;}
    #contentLength(headers:NetworkHeaders):number|null{
        const text=this.#header(headers,'content-length');if(text===null||!/^\d{1,15}$/.test(text))return null;
        const value=Number(text);return Number.isSafeInteger(value)?value:null;
    }
    #text(value:string,max:number):string{
        const text=String(value??'');let end=Math.min(text.length,max);
        if(end<text.length&&end>0&&text.charCodeAt(end-1)>=0xd800&&text.charCodeAt(end-1)<=0xdbff)end--;
        return text.slice(0,end);
    }
    #textMedia(contentType:string|null):boolean{
        const type=(contentType??'').split(';')[0].trim().toLowerCase();
        return type.startsWith('text/')||['application/json','application/xml','application/javascript','application/x-www-form-urlencoded'].includes(type)||type.endsWith('+json')||type.endsWith('+xml');
    }
    #body(state:CdpNetworkBody['state'],reason:string|null,source:string):CdpNetworkBody{return {state,reason,source,representation:null,text:null,utf8ByteLength:null,truncated:false};}
    #balance():void{
        this.#retainedBytes=0;for(const record of this.#records.values())this.#retainedBytes+=Buffer.byteLength(JSON.stringify(record));
        while(this.#records.size>this.#limits.maxRecords||this.#retainedBytes>this.#limits.maxRetainedBytes){
            const first=this.#records.values().next().value as NetworkRecord|undefined;if(!first)break;
            this.#records.delete(first.networkRequestId);this.#retainedBytes-=Buffer.byteLength(JSON.stringify(first));
            if(this.#current.get(first.source.nativeRequestId)===first)this.#current.delete(first.source.nativeRequestId);
            this.#evicted.add(first.networkRequestId);this.#evictedCount++;
            while(this.#evicted.size>this.#limits.maxRecords)this.#evicted.delete(this.#evicted.values().next().value!);
        }
    }
    #responseOmission(record:NetworkRecord):string|null{
        if(record.state==='redirected')return 'REDIRECT_BODY_UNAVAILABLE';
        if(!this.#textMedia(record.contentType))return 'UNSUPPORTED_MEDIA_TYPE';
        if(record.decodedBytesReceived>this.#limits.maxResourceBufferBytes||(record.responseContentLength??0)>this.#limits.maxResourceBufferBytes)return 'RESPONSE_BUFFER_LIMIT';
        return null;
    }
    async #responseBody(record:NetworkRecord):Promise<CdpNetworkBody>{
        if(record.responseBody.state==='captured')return record.responseBody;
        const reason=this.#responseOmission(record);if(reason)return this.#body('unavailable',reason,'Network.getResponseBody');
        if(record.state!=='completed')return this.#body('unavailable',record.state==='failed'?'REQUEST_FAILED':'LOADING','Network.getResponseBody');
        if(this.#detached||this.#disposed)return this.#body('unavailable','CDP_DETACHED','Network.getResponseBody');
        if(this.#current.get(record.source.nativeRequestId)!==record)return this.#body('unavailable','HOP_NO_LONGER_CURRENT','Network.getResponseBody');
        const pending=this.#reads.get(record.networkRequestId);if(pending)return pending;
        if(this.#reads.size>=this.#limits.maxConcurrentBodyReads)return this.#body('unavailable','BODY_READ_CAPACITY','Network.getResponseBody');
        const read=this.#readBody(record);this.#reads.set(record.networkRequestId,read);
        try{return await read;}finally{this.#reads.delete(record.networkRequestId);}
    }
    async #readBody(record:NetworkRecord):Promise<CdpNetworkBody>{
        let response:{body:string;base64Encoded:boolean};
        try{response=await this.#session.send('Network.getResponseBody',{requestId:record.source.nativeRequestId},{timeout:this.#limits.bodyReadTimeoutMs});}
        catch{return this.#body('unavailable',this.#detached?'CDP_DETACHED':'BODY_SOURCE_UNAVAILABLE','Network.getResponseBody');}
        if(this.#records.get(record.networkRequestId)!==record)return this.#body('unavailable','CAPTURE_EVICTED_DURING_READ','Network.getResponseBody');
        if(record.state!=='completed'||this.#current.get(record.source.nativeRequestId)!==record)return this.#body('unavailable','HOP_CHANGED_DURING_READ','Network.getResponseBody');
        if(response.base64Encoded)return this.#body('unavailable','BINARY_OR_BASE64_SOURCE','Network.getResponseBody');
        const bytes=Buffer.byteLength(response.body);
        if(bytes>this.#limits.maxResourceBufferBytes)return this.#body('omitted','RESPONSE_BUFFER_LIMIT','Network.getResponseBody');
        record.responseBody={...this.#body('captured',null,'Network.getResponseBody'),representation:'decoded-text',text:response.body,utf8ByteLength:bytes};this.#balance();return record.responseBody;
    }
    #preview(body:CdpNetworkBody,include:boolean,max:number):CdpNetworkBody{
        if(!include)return this.#body('notRequested',null,body.source);
        if(body.state!=='captured'||body.text===null)return {...body};
        const text=this.#text(body.text,max);return {...body,text,truncated:body.truncated||text!==body.text};
    }
    async getExchange(networkRequestId:string,options:CdpNetworkOptions={}):Promise<Readonly<Record<string,unknown>>>{
        if(typeof networkRequestId!=='string'||!networkRequestId.length||networkRequestId.length>128)throw new CdpNetworkError('INVALID_NETWORK_REQUEST_ID','A bounded logical network request ID is required.');
        const normalized=this.#options(options),record=this.#records.get(networkRequestId);
        if(!record)return Object.freeze({state:this.#evicted.has(networkRequestId)?'evicted':'unknown',networkRequestId,pageId:this.#owner.pageId,reason:this.#evicted.has(networkRequestId)?'METADATA_EVICTED':'UNKNOWN_OR_OLDER_THAN_BOUNDED_EVICTION_HISTORY',evictedCount:this.#evictedCount});
        const response=normalized.includeResponseBody?await this.#responseBody(record):record.responseBody;
        const snapshot=JSON.parse(JSON.stringify(record));
        snapshot.requestBody=this.#preview(record.requestBody,normalized.includeRequestBody,normalized.maxBodyChars);
        snapshot.responseBody=this.#preview(response,normalized.includeResponseBody,normalized.maxBodyChars);
        return Object.freeze({...snapshot,retention:{state:this.#records.has(networkRequestId)?'retained':'evictedDuringRead',evictedCount:this.#evictedCount},bodySemantics:'Available browser-observed text only; not wire bytes, not replayed, not proof of application commit.',actionId:null,actionCorrelation:'not captured'});
    }
    #options(options:CdpNetworkOptions):Required<CdpNetworkOptions>{
        if(!options||typeof options!=='object'||Array.isArray(options))throw new CdpNetworkError('INVALID_NETWORK_OPTIONS','Expected network exchange options object.');
        for(const key of Object.keys(options))if(!['includeRequestBody','includeResponseBody','maxBodyChars'].includes(key))throw new CdpNetworkError('INVALID_NETWORK_OPTIONS','Unknown network exchange option.');
        const value={includeRequestBody:false,includeResponseBody:false,maxBodyChars:16000,...options};
        if(typeof value.includeRequestBody!=='boolean'||typeof value.includeResponseBody!=='boolean'||!Number.isInteger(value.maxBodyChars)||value.maxBodyChars<1||value.maxBodyChars>65536)throw new CdpNetworkError('INVALID_NETWORK_OPTIONS','Expected boolean body flags and maxBodyChars in 1..65536.');
        return value;
    }
    describe():Readonly<Record<string,unknown>>{
        return Object.freeze({pageId:this.#owner.pageId,cdpSessionScope:this.#scope,disposed:this.#disposed,detached:this.#detached,captureFailure:this.#captureFailure,retainedRecords:this.#records.size,retainedBytes:this.#retainedBytes,evictedCount:this.#evictedCount,evictionHistorySize:this.#evicted.size,pendingBodyReads:this.#reads.size,ignoredNonMainOrUnknownFrameRequests:this.#ignoredFrames,limits:{...this.#limits},support:{mainFrameOnly:true,logicalFrameMapping:'unknown',documentMapping:'unknown',redirectHopIdentity:true,requestBody:'bounded event postData only',responseBody:'text only from bounded Network buffer',extraInfoHeaders:false,rawWireBytes:false,websocketFrames:false,serviceWorkerTargets:false,artifactPersistence:false},valuePolicy:'Raw user-owned bounded data. No privacy classification gates in this helper.'});
    }
    #closed():void{
        this.#detached=true;
        for(const record of this.#records.values())if(record.state==='requesting'||record.state==='responding'){record.state='detached';record.responseBody=this.#body('unavailable','CDP_DETACHED','Network.getResponseBody');}
        this.#balance();
    }
    async dispose():Promise<Readonly<Record<string,unknown>>>{
        if(!this.#disposed){
            this.#disposed=true;
            for(const {name,listener}of this.#listeners)this.#session.off(name as any,listener);this.#listeners.length=0;
            try{if(!this.#detached)await this.#session.detach();this.#closed();}
            catch{if(this.#owner.page.isClosed())this.#closed();else{this.#captureFailure='NETWORK_DETACH_UNCERTAIN';throw new CdpNetworkError('NETWORK_DETACH_UNCERTAIN','Owned network session detach was not verified.');}}
        }
        return this.describe();
    }
}
