import {createHash,randomUUID} from 'node:crypto';
import {CdpContract,CdpContractError} from './cdp-contract.mts';
import type {CdpJsonObject} from './cdp-contract.mts';
import {CdpObservationPager} from './cdp-observation.mts';
import type {CdpObservationProof} from './cdp-observation.mts';
import type {CdpBrowserPage} from './cdp-browser.mts';

export class CdpPageObservation {
    readonly #owner:CdpBrowserPage;
    readonly #pager:CdpObservationPager;
    constructor(owner:CdpBrowserPage,sessionId:string){this.#owner=owner;this.#pager=new CdpObservationPager({sessionId,pageId:owner.id});}
    async read(args:any,access:'owner'|'parentInspect'):Promise<CdpJsonObject>{
        const frameId=args.options.frameId??this.#owner.mainFrameId,signature=this.#signature(args);
        let cursor=args.options.cursor,ticket:{snapshotId:string;cursor:string}|null=null;
        if(cursor===null){
            if(access!=='owner')throw new CdpContractError('OWNERSHIP_DENIED','A parent may read an existing cursor, never capture a new snapshot.');
            ticket=await this.#capture(args,signature);cursor=ticket.cursor;
        }
        try{
            const proof=await this.#proof(frameId,access);
            return this.#pager.read({pageId:this.#owner.id,frameId,captureSignature:signature,cursor,maxNodes:args.options.maxNodes,maxChars:args.options.maxChars,expectedDocumentId:args.target?.kind==='element'?args.target.documentId:null},proof,access) as CdpJsonObject;
        }catch(error){if(ticket)this.#pager.discard(ticket.snapshotId,'owner');throw error;}
    }
    #signature(args:any):string{
        const options=args.options;
        return createHash('sha256').update(CdpContract.canonical({target:args.target,frameId:options.frameId,includeText:options.includeText,includeControls:options.includeControls,includeFrames:options.includeFrames,includeRects:options.includeRects})).digest('hex');
    }
    async #capture(args:any,signature:string):Promise<{snapshotId:string;cursor:string}>{
        const captured=await this.#owner.targets.capture({...args.options,maxNodes:800,maxChars:100000},args.target);
        const inventory=args.options.includeFrames?await this.#owner.frames.inventory({pageId:this.#owner.id,maxFrames:32,includeDetached:true}):null;
        const frame=this.#owner.frames.internalFrame(captured.frameId),after=await this.#owner.targets.documentProof(frame);
        if(after.documentId!==captured.proof.documentId||after.epoch!==captured.proof.epoch)throw new CdpContractError('OBSERVATION_CHANGED_DURING_CAPTURE','Observed document/epoch changed before snapshot admission.');
        const observation:any=this.#owner.redactObservation({pageId:this.#owner.id,frameId:captured.frameId,documentId:after.documentId,observationId:randomUUID(),...captured.content,frames:inventory?.frames??[],framesTruncated:inventory?.framesTruncated??false,frameInventoryChangedDuringRead:inventory?.changedDuringRead??false,captureAtomic:false,epochCoverage:'DOM mutations and input/change/focus events; not all programmatic property writes',url:frame.url().slice(0,2048)});
        let omitted=0;while(Buffer.byteLength(JSON.stringify(observation))>400000&&observation.nodes.length){observation.nodes.pop();omitted++;}
        if(omitted){observation.truncated=true;observation.retainedByteTrimmedNodes=omitted;}
        return this.#pager.retain({frameId:captured.frameId,documentId:after.documentId,epoch:after.epoch,captureSignature:signature,capturedAtUtc:new Date().toISOString(),observation},'owner');
    }
    async #proof(frameId:string,access:'owner'|'parentInspect'):Promise<CdpObservationProof>{
        const unavailable=(reason:string):CdpObservationProof=>({pageId:this.#owner.id,frameId,status:'unavailable',documentId:null,epoch:null,observedAtUtc:new Date().toISOString(),reason});
        if(access==='parentInspect')return unavailable('Parent retained inspection does not refresh DOM proof.');
        try{const selection=await this.#owner.resolveFrame(frameId),proof=await this.#owner.targets.documentProof(selection.frame());return {pageId:this.#owner.id,frameId,status:'available',...proof,reason:'Exact frame document handle and observed DOM/state epoch; no live-DOM equivalence claim.'};}
        catch(error){return unavailable(error instanceof CdpContractError?error.code:'EXACT_FRAME_PROOF_UNAVAILABLE');}
    }
    dispose():void{this.#pager.dispose('owner');}
}
