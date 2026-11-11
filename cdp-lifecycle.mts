import type {Page} from 'playwright-core';
import {CdpContractError} from './cdp-contract.mts';
import type {CdpJsonObject} from './cdp-contract.mts';
import type {CdpBrowserPage} from './cdp-browser.mts';

// One explicit owned page. Preparation is read-only; dispatch occurs only behind its journal barrier.
export class CdpPageLifecycle {
    readonly #owner:CdpBrowserPage;
    readonly #page:Page;
    readonly #contextScale:number;
    constructor(owner:CdpBrowserPage,page:Page,contextScale:number){this.#owner=owner;this.#page=page;this.#contextScale=contextScale;}
    async prepare(operation:string,args:any):Promise<void>{
        if(operation==='Reload'&&args.bypassCache&&this.#owner.cacheMode==='fixture-guarded')throw new CdpContractError('CACHE_BYPASS_UNSUPPORTED','Explicit fixture routing disables cache; no differentiated bypass dispatched.');
        if(operation==='SetViewport'&&args.width*args.height*args.deviceScaleFactor*args.deviceScaleFactor>16777216)throw new CdpContractError('SOURCE_PIXEL_LIMIT','Requested viewport exceeds measured native pixel budget.');
    }
    async dispatch(operation:string,args:any):Promise<CdpJsonObject>{
        switch(operation){case 'ClosePage':return this.#close();case 'SetViewport':return this.#resize(args);default:throw new CdpContractError('UNSUPPORTED_OPERATION','No lifecycle adapter exists.');}
    }
    async #close():Promise<CdpJsonObject>{
        const alreadyClosed=this.#page.isClosed();
        if(!alreadyClosed){
            const closed=this.#page.waitForEvent('close',{timeout:10000});void closed.catch(()=>{});
            try{await this.#page.close({runBeforeUnload:true});await closed;}
            catch(error){if(!this.#page.isClosed())throw new CdpContractError('PAGE_CLOSE_UNVERIFIED','Explicit owned page did not reach verified closed state; inspect pending dialog/action. No slot released.');throw error;}
        }
        if(!this.#page.isClosed())throw new CdpContractError('PAGE_CLOSE_UNVERIFIED','Owned page closure is not verified.');
        return {pageId:this.#owner.id,pageClosed:true,closedVerified:true,noOp:alreadyClosed,inputDispatched:!alreadyClosed,inputMethod:'playwright.page.close(runBeforeUnload=true)',applicationTransactionCancelled:false,businessSuccessVerified:false};
    }
    async cleanupClosed():Promise<CdpJsonObject> {
        if(!this.#page.isClosed())throw new CdpContractError('PAGE_CLOSE_UNVERIFIED','Only the exact verified closed page can dispose its observations.');
        const observationCleanup=this.#owner.disposePageObservation();
        const networkCleanup=await this.#owner.disposeNetwork();
        return {observationCleanup,networkCleanup};
    }
    async #resize(args:any):Promise<CdpJsonObject>{return await this.#owner.viewport.resize({pageId:this.#owner.id,...args}) as unknown as CdpJsonObject;}
    async metrics():Promise<CdpJsonObject>{return this.#page.evaluate(()=>({width:innerWidth,height:innerHeight,deviceScaleFactor:devicePixelRatio,scrollX,scrollY}));}
}
