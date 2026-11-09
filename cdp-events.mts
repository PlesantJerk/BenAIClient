import type {Page} from 'playwright-core';
import {CdpContract,CdpContractError} from './cdp-contract.mts';
import type {CdpJsonObject} from './cdp-contract.mts';
import type {CdpStore} from './cdp-store.mts';
import type {CdpBrowserPage,CdpBrowserSession} from './cdp-browser.mts';
import type {CdpWatch} from './cdp-watches.mts';
import type {CdpNetworkEvent} from './cdp-network.mts';

// Session-owned event source. Only public event text and bounded metadata, never argument handles,
// headers, request/response bodies or application objects. Listener callbacks never dispatch input.
export class CdpEvents {
    readonly #owner:CdpBrowserSession;
    readonly #store:CdpStore;
    readonly #subscriptions=new Set<CdpWatch>();
    readonly #pages=new Map<CdpBrowserPage,{page:Page;listeners:{event:string;listener:(...args:any[])=>void}[]}>();
    readonly #pending=new Map<CdpBrowserPage,{kind:string;data:CdpJsonObject;time:string;mapping?:{frameId:string|null;documentId:string|null}}[]>();
    #failure:string|null=null;
    #disposed=false;
    constructor(owner:CdpBrowserSession,store:CdpStore){this.#owner=owner;this.#store=store;}
    get failure():string|null{return this.#failure;}
    latest():string{return this.#store.latestEventId(this.#owner.id,this.#owner.owner);}
    subscribe(watch:CdpWatch):void {if(this.#disposed||this.#failure)throw new CdpContractError('EVENT_CAPTURE_UNAVAILABLE','Event capture is not healthy.');this.#subscriptions.add(watch);}
    unsubscribe(watch:CdpWatch):void {this.#subscriptions.delete(watch);}
    attach(owner:CdpBrowserPage,page:Page):void {
        if(this.#pages.has(owner))return;
        const listeners:{event:string;listener:(...args:any[])=>void}[]=[];
        this.#pages.set(owner,{page,listeners});
        const on=(event:string,listener:(...args:any[])=>void):void=>{listeners.push({event,listener});page.on(event as any,listener);};
        on('console',message=>this.capture(owner,'console',{level:message.type(),text:message.text()}));
        on('pageerror',error=>this.capture(owner,'pageError',{text:error.message}));

        on('close',()=>this.capture(owner,'pageClosed',{closedPageId:owner.id}));
        // PageOpened is emitted after exact resource admission and observed opener inventory.
    }
    commit(page:CdpBrowserPage):void{this.capture(page,'pageOpened',{openerPageId:page.describe().openerPageId??null,url:page.page.url(),automaticallyOpened:page.automaticallyOpened,earlyCoverage:page.automaticallyOpened?'partial after context page event':'before application navigation'});const pending=this.#pending.get(page)??[];this.#pending.delete(page);for(const item of pending)this.capture(page,item.kind,item.data,item.time,item.mapping);}
    captureDownload(data:CdpJsonObject,time:string):void{
        const page=this.#owner.pages().find(page=>page.id===data.pageId);
        if(page){this.capture(page,'download',data,time,{frameId:null,documentId:null});return;}
        if(this.#disposed)return;
        const safe=CdpContract.cloneJson(data,0,new Set<object>()) as CdpJsonObject;
        const payload=Buffer.byteLength(JSON.stringify(safe))>12000?{downloadId:safe.downloadId??null,state:safe.state??null,artifactId:safe.artifactId??null,omitted:true,reason:'EVENT_PAYLOAD_LIMIT'}:safe;
        const retained=this.#store.appendCanonicalEvent(this.#owner.id,this.#owner.owner,{kind:'download',pageId:null,frameId:null,documentId:null,capturedAtUtc:time,data:payload,truncated:payload!==safe});
        for(const watch of [...this.#subscriptions])watch.onEvent(retained,payload);
    }
    captureNetwork(page:CdpBrowserPage,event:CdpNetworkEvent):void{this.capture(page,event.kind,event.data as CdpJsonObject,event.capturedAtUtc,{frameId:event.frameId,documentId:event.documentId});}
    capture(page:CdpBrowserPage,kind:string,data:CdpJsonObject,time=new Date().toISOString(),mapping?:{frameId:string|null;documentId:string|null}):void {
        if(this.#disposed)return;
        try {
            const capturedAtUtc=time;let truncated=false;
            const raw:CdpJsonObject={};
            for(const [key,value]of Object.entries(data)){
                if(typeof value==='string'){raw[key]=value.slice(0,4096);if(value.length>4096)truncated=true;}else raw[key]=value;
            }
            if(!page.eventCommitted){const pending=this.#pending.get(page)??[];if(pending.length>=32)throw new CdpContractError('EARLY_EVENT_CAPACITY','Precommit event buffer exhausted.');pending.push({kind,data:raw,time,mapping});this.#pending.set(page,pending);return;}
            const safe=this.#owner.redact({...raw});
            if(typeof safe.url==='string')safe.url=this.#url(safe.url);
            let event:CdpJsonObject={kind,pageId:page.id,frameId:mapping?mapping.frameId:kind==='navigation'?page.mainFrameId:null,documentId:mapping?mapping.documentId:page.documentId,capturedAtUtc,data:safe,truncated};
            const budget=Math.min(12000,this.#store.limits.values.eventBytesPerSession-512);
            if(Buffer.byteLength(JSON.stringify(event))>budget){event={...event,data:{omitted:true,reason:'EVENT_PAYLOAD_LIMIT'},truncated:true};}
            const stored=this.#store.appendCanonicalEvent(this.#owner.id,this.#owner.owner,event);
            for(const subscription of this.#subscriptions)subscription.onEvent(stored,{...raw},truncated);
        }catch(error){this.#failure=error instanceof CdpContractError?error.code:'EVENT_CAPTURE_FAILED';for(const watch of [...this.#subscriptions])watch.captureFailed(this.#failure);}
    }
    #url(value:string):string {
        try{const url=new URL(value);url.username='';url.password='';if(url.search){for(const key of [...url.searchParams.keys()])url.searchParams.set(key,'[REDACTED]');}url.hash='';return url.href.slice(0,4096);}catch{return '[URL_UNAVAILABLE]';}
    }
    read(pageId:string|null,args:any):CdpJsonObject{return this.#store.readCanonicalEvents(this.#owner.id,pageId,this.#owner.owner,args);}
    disposePage(owner:CdpBrowserPage):CdpJsonObject{
        const entry=this.#pages.get(owner);if(entry){for(const {event,listener}of entry.listeners)entry.page.off(event as any,listener);this.#pages.delete(owner);}this.#pending.delete(owner);
        return {pageListenersDisposed:true,remainingPageSources:this.#pages.size,remainingSubscriptions:this.#subscriptions.size};
    }
    dispose():CdpJsonObject {
        if(!this.#disposed){for(const entry of this.#pages.values())for(const {event,listener}of entry.listeners)entry.page.off(event as any,listener);this.#pages.clear();this.#pending.clear();this.#disposed=true;}
        return {listenersDisposed:true,remainingSubscriptions:this.#subscriptions.size,captureError:this.#failure};
    }
}
