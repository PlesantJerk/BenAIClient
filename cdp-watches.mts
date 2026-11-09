import {randomUUID} from 'node:crypto';
import {CdpContractError} from './cdp-contract.mts';
import type {CdpCommand,CdpContext,CdpJsonObject} from './cdp-contract.mts';
import type {CdpStore,CdpEvidence} from './cdp-store.mts';
import type {CdpBrowserSession,CdpBrowserPage} from './cdp-browser.mts';
import {CdpConditionMatcher} from './cdp-condition-matcher.mts';

// A child holds its owning registry. Condition arguments never enter the journal as plaintext.
export class CdpWatch {
    readonly id=randomUUID();readonly page:CdpBrowserPage;readonly documentId:string;readonly frameId:string;
    readonly afterEventId:string;readonly expiresAtUtc:string;readonly #owner:CdpWatches;
    #condition:any;#recorded=false;#journalError:CdpContractError|null=null;#disposed=false;#installing=true;
    #pending:{state:'satisfied'|'expired';result:CdpJsonObject|null;code:string|null}|null=null;
    #pollTimer:NodeJS.Timeout|null=null;#expiryTimer:NodeJS.Timeout|null=null;#checking:Promise<void>|null=null;
    readonly #events:{event:CdpJsonObject;actual:CdpJsonObject;sourceTruncated?:boolean}[]=[];#processing=false;
    readonly #waiters=new Set<{resolve:(value:CdpJsonObject)=>void;reject:(reason:Error)=>void;timer:NodeJS.Timeout}>();
    constructor(owner:CdpWatches,page:CdpBrowserPage,args:any,scope:{frameId:string;documentId:string}){this.#owner=owner;this.page=page;this.documentId=scope.documentId;this.frameId=scope.frameId;this.afterEventId=args.afterEventId??owner.session.events.latest();this.expiresAtUtc=new Date(Date.now()+args.expireAfterMs).toISOString();this.#condition=args.condition;}
    #eventCondition():boolean{return this.#condition?.kind==='event'||this.#condition?.kind==='response';}
    async install():Promise<void>{
        this.#owner.session.events.subscribe(this); // Subscribe before retained scan/state check; no user predicate before durable arm.
        try{if(this.#eventCondition())await this.#replay();else if(this.#condition.kind!=='predicate')await this.#check();this.#installing=false;void this.#drain();}
        catch(error){this.dispose();throw error;}
    }
    get journalError():CdpContractError|null{return this.#journalError;}
    evidence():CdpEvidence{return {watch:{watchId:this.id,documentId:this.documentId,afterEventId:this.afterEventId,expiresAtUtc:this.expiresAtUtc}};}
    recorded():void{
        this.#recorded=true;if(this.#pending){const p=this.#pending;this.#pending=null;this.#finish(p.state,p.result,p.code);return;}
        this.#expiryTimer=setTimeout(()=>this.#finish('expired',this.#stopEvidence(),null),Math.max(1,Date.parse(this.expiresAtUtc)-Date.now()));this.#schedule(this.#condition.kind==='predicate'?0:50);
    }
    #schedule(delay=50):void{if(!this.#disposed&&!this.#eventCondition())this.#pollTimer=setTimeout(()=>{const work=this.#check();this.#checking=work;void work.then(()=>this.#schedule(),error=>{if(error instanceof CdpContractError&&error.code==='CONDITION_EVALUATOR_BUSY')this.#schedule();else this.captureFailed(this.#code(error));}).finally(()=>{if(this.#checking===work)this.#checking=null;});},delay);}
    #code(error:unknown):string{return error&&typeof error==='object'&&'code'in error&&typeof error.code==='string'?error.code:'WATCH_INSPECTION_FAILED';}
    async #check():Promise<void>{
        if(this.#disposed||this.#pending)return;const condition=this.#condition;
        if(this.page.closed){this.#finish('expired',null,'PAGE_CLOSED');return;}
        if(['element','text','predicate'].includes(condition.kind)){const scope=await this.page.resolveFrame(this.frameId);if(scope.describe().documentId!==this.documentId){this.#finish('expired',null,'STALE_DOCUMENT');return;}}
        if(this.#disposed)return;const result=await this.page.checkCondition(condition,this.documentId,this.id);
        if(!this.#disposed&&result.satisfied===true)this.#finish('satisfied',result,null);
    }
    async #replay():Promise<void>{
        let cursor=this.afterEventId;
        for(let batch=0;batch<100;batch++){
            const read=this.#owner.session.events.read(null,{afterEventId:cursor,kinds:[CdpConditionMatcher.eventType(this.#condition)],maxItems:50,maxChars:32000});
            if(read.gap)throw new CdpContractError('EVENT_GAP','Requested event coverage was dropped; absence is not established.');
            for(const event of read.events as CdpJsonObject[])await this.#replayEvent(event);
            if(!read.truncated||this.#pending)return;
            if(read.nextCursor===cursor)throw new CdpContractError('EVENT_GAP','Retained event cursor made no progress.');cursor=read.nextCursor as string;
        }
        throw new CdpContractError('EVENT_SCAN_LIMIT','Retained match scan budget exhausted.');
    }
    #relevant(event:CdpJsonObject,actual:CdpJsonObject):boolean{
        if(event.kind!==CdpConditionMatcher.eventType(this.#condition)||BigInt(event.eventId as string)<=BigInt(this.afterEventId))return false;
        if(event.kind==='pageOpened'){if(Object.hasOwn(actual,'openerPageId')&&actual.openerPageId!==this.page.id)return false;}
        else if(Object.hasOwn(event,'pageId')&&event.pageId!==this.page.id)return false;
        return !this.#owner.matcher.knownIrrelevant(this.#condition,event,actual);
    }
    async #replayEvent(event:CdpJsonObject):Promise<void>{
        const actual=(event.data??{}) as CdpJsonObject;if(!this.#relevant(event,actual))return;
        // Preserve247: BOTH captured payload and whole-event read-budget omission fail unavailable AFTER known exclusions.
        if(event.omitted||actual.omitted)throw new CdpContractError('EVENT_MATCH_UNAVAILABLE','An oversized retained event cannot be matched.');
        await this.#matchEvent(event,actual,true);
    }
    onEvent(event:CdpJsonObject,actual:CdpJsonObject,sourceTruncated?:boolean):void{
        if(this.#disposed||this.#pending||!this.#eventCondition()||!this.#relevant(event,actual))return;
        if(this.#events.length>=16){this.captureFailed('EVENT_MATCH_BACKLOG_UNAVAILABLE');return;}
        this.#events.push({event,actual,sourceTruncated});if(!this.#installing)void this.#drain();
    }
    async #drain():Promise<void>{
        if(this.#processing||this.#installing||this.#disposed)return;this.#processing=true;
        try{while(this.#events.length&&!this.#disposed&&!this.#pending){const item=this.#events.shift()!;await this.#matchEvent(item.event,item.actual,false,item.sourceTruncated);}}
        catch(error){this.captureFailed(this.#code(error));}finally{this.#processing=false;}
    }
    async #matchEvent(event:CdpJsonObject,actual:CdpJsonObject,retained:boolean,sourceTruncated?:boolean):Promise<void>{
        if(this.#disposed||this.#pending)return;const result=await this.#owner.matcher.event(this,event,actual,this.#condition,retained,sourceTruncated);if(result&&!this.#disposed)this.#finish('satisfied',result,null);
    }
    captureFailed(code:string):void{this.#finish('expired',this.#stopEvidence(),code);}
    #stopEvidence():CdpJsonObject{return {observationStopped:true,predicateExecution:this.page.predicateState(this.id),applicationCancellationClaimed:false};}
    #finish(state:'satisfied'|'expired',result:CdpJsonObject|null,code:string|null):void{
        if(this.#disposed||this.#pending)return;this.#pending={state,result,code};if(!this.#recorded)return;
        try{const retained=this.#owner.store.finishWatch(this.#owner.session.id,this.id,this.#owner.session.owner,state,result,code);this.dispose();this.#resolve(retained);}
        catch{this.#journalError=new CdpContractError('WATCH_JOURNAL_UNAVAILABLE','Watch outcome could not be persisted; no satisfaction or rearm is claimed.');this.dispose();for(const waiter of this.#waiters){clearTimeout(waiter.timer);waiter.reject(this.#journalError);}this.#waiters.clear();}
    }
    cancel(code:string|null=null):CdpJsonObject{const retained=this.#owner.store.finishWatch(this.#owner.session.id,this.id,this.#owner.session.owner,'cancelled',this.#stopEvidence(),code);this.dispose();this.#resolve(retained);return retained;}
    wait(timeoutMs:number):Promise<CdpJsonObject>{
        if(this.#journalError)throw this.#journalError;const retained=this.#owner.store.getWatch(this.#owner.session.id,this.id,this.#owner.session.owner);if(retained.state!=='armed')return Promise.resolve(retained);
        if(this.#waiters.size>=32)throw new CdpContractError('WAITER_CAPACITY','Watch waiter capacity exhausted.');
        return new Promise((resolve,reject)=>{const waiter={resolve,reject,timer:setTimeout(()=>{this.#waiters.delete(waiter);try{resolve({...this.#owner.store.getWatch(this.#owner.session.id,this.id,this.#owner.session.owner),state:'timedOut'});}catch(error){reject(error);}},timeoutMs)};this.#waiters.add(waiter);});
    }
    #resolve(result:CdpJsonObject):void{for(const waiter of this.#waiters){clearTimeout(waiter.timer);waiter.resolve(result);}this.#waiters.clear();}
    dispose():void{if(this.#disposed)return;this.#disposed=true;this.#owner.session.events.unsubscribe(this);this.#owner.retire(this);this.#condition=null;this.#events.length=0;if(this.#pollTimer)clearTimeout(this.#pollTimer);if(this.#expiryTimer)clearTimeout(this.#expiryTimer);}
}

export class CdpWatches {
    readonly session:CdpBrowserSession;readonly store:CdpStore;readonly matcher:CdpConditionMatcher;readonly #watches=new Map<string,CdpWatch>();
    constructor(session:CdpBrowserSession,store:CdpStore){this.session=session;this.store=store;this.matcher=new CdpConditionMatcher(this);}
    static matches(value:string,match:any):boolean{return CdpConditionMatcher.matches(value,match);}
    retire(watch:CdpWatch):void{this.#watches.delete(watch.id);}
    isLive(watchId:string):boolean{return this.#watches.has(watchId); }
    async install(command:CdpCommand):Promise<CdpWatch>{
        const page=this.session.page(command.pageId!),condition=command.args.condition as any,frameId=condition.target?.frameId??condition.frameId??null,scope=(await page.resolveFrame(frameId)).describe();
        if(!scope.documentId)throw new CdpContractError('DOCUMENT_UNAVAILABLE','Watch exact-frame document is unavailable.');
        const watch=new CdpWatch(this,page,command.args,{frameId:scope.frameId,documentId:scope.documentId});this.#watches.set(watch.id,watch);try{await watch.install();return watch;}catch(error){this.#watches.delete(watch.id);throw error;}
    }
    async wait(watchId:string,caller:CdpContext,timeoutMs:number):Promise<CdpJsonObject>{const retained=this.store.getWatch(this.session.id,watchId,caller);if(caller.access==='parentInspect')return {...retained,state:retained.state==='armed'?'timedOut':retained.state,retainedInspectionOnly:true};if(retained.state!=='armed')return retained;const watch=this.#watches.get(watchId);if(!watch)throw new CdpContractError('WATCH_UNAVAILABLE','Watch is not armed in this incarnation; no rearm attempted.');return watch.wait(timeoutMs);}
    cancel(watchId:string,caller:CdpContext):CdpJsonObject{this.store.getWatch(this.session.id,watchId,caller);if(caller.access!=='owner')throw new CdpContractError('OWNERSHIP_DENIED','Only owner cancellation is permitted.');const watch=this.#watches.get(watchId);return watch?watch.cancel():this.store.finishWatch(this.session.id,watchId,caller,'cancelled');}
    closePage(pageId:string):CdpJsonObject{let cancelled=0;for(const watch of [...this.#watches.values()])if(watch.page.id===pageId){const retained=this.store.getWatch(this.session.id,watch.id,this.session.owner);if(retained.state==='armed'){watch.cancel('PAGE_CLOSED');cancelled++;}else watch.dispose();}return {subscriptionsDisposed:true,pageId,cancelled,inputCancellationClaimed:false};}
    close():CdpJsonObject{let disposed=0;for(const watch of [...this.#watches.values()]){const retained=this.store.getWatch(this.session.id,watch.id,this.session.owner);if(retained.state==='armed'){watch.cancel('SESSION_CLOSED');disposed++;}else watch.dispose();}return {subscriptionsDisposed:true,cancelled:disposed,inputCancellationClaimed:false};}
}
