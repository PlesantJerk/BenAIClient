import {randomUUID} from 'node:crypto';
import type {Frame,JSHandle,ElementHandle} from 'playwright-core';
import {CdpContractError} from './cdp-contract.mts';

export interface CdpDocumentsOwner { retireDocument(documentId:string):void; }
export interface CdpDocumentProof {readonly documentId:string;readonly epoch:string;readonly observedAtUtc:string;}
interface DocumentRecord {frame:Frame;id:string;handle:JSHandle;verified:boolean;}

// The only document/element identity authority. Handles are private to this owner, never app globals.
export class CdpDocuments {
    readonly documentKey='__cdp_document_'+randomUUID();
    readonly #owner:CdpDocumentsOwner;
    readonly #records=new Map<Frame,DocumentRecord>();
    readonly #pending=new Map<Frame,Promise<DocumentRecord>>();
    #disposed=false;
    #disposalFailures=0;
    constructor(owner:CdpDocumentsOwner){this.#owner=owner;}
    cached(frame:Frame):string|null {const record=this.#records.get(frame);return record?.verified?record.id:null;}
    get disposalFailures():number{return this.#disposalFailures;}
    noteNavigation(frame:Frame):void {const record=this.#records.get(frame);if(record)record.verified=false;}
    async proof(frame:Frame):Promise<CdpDocumentProof>{
        const record=await this.#current(frame);
        const value=await record.handle.evaluate(state=>({same:state.doc===document,epoch:String(state.mutations)+':'+String(state.stateChanges)}));
        if(!value.same)throw new CdpContractError('DOCUMENT_UNAVAILABLE','Document proof changed during sampling.');
        return Object.freeze({documentId:record.id,epoch:value.epoch,observedAtUtc:new Date().toISOString()});
    }
    async identify(frame:Frame,element:ElementHandle<Element>):Promise<CdpDocumentProof&{elementId:string}>{
        const record=await this.#current(frame),candidate=randomUUID();
        const result=await record.handle.evaluate((state,{element,candidate})=>{
            if(state.doc!==document||element.ownerDocument!==document)throw new Error('DOCUMENT_IDENTITY_MISMATCH');
            let id=state.ids.get(element);if(!id){id=candidate;state.ids.set(element,id);}return {elementId:id,epoch:String(state.mutations)+':'+String(state.stateChanges)};
        },{element,candidate});
        return Object.freeze({documentId:record.id,elementId:result.elementId,epoch:result.epoch,observedAtUtc:new Date().toISOString()});
    }
    async #current(frame:Frame):Promise<DocumentRecord>{
        if(this.#disposed||frame.isDetached()||frame.page().isClosed())throw new CdpContractError('DOCUMENT_UNAVAILABLE','Exact document owner is unavailable.');
        const pending=this.#pending.get(frame);if(pending)return pending;
        const work=this.#sample(frame);this.#pending.set(frame,work);
        try{return await work;}finally{if(this.#pending.get(frame)===work)this.#pending.delete(frame);}
    }
    async #sample(frame:Frame):Promise<DocumentRecord>{
        const old=this.#records.get(frame);
        if(old){
            try{if(await old.handle.evaluate(state=>state.doc===document)){old.verified=true;return old;}}
            catch(error){if(!this.#replacementError(error))throw new CdpContractError('DOCUMENT_UNAVAILABLE','Existing document proof could not be sampled; no replacement was invented.');}
        }
        const id=randomUUID(),handle=await frame.evaluateHandle(CdpDocuments.install,{key:this.documentKey,id});
        const record={frame,id,handle,verified:true};
        if(this.#disposed||frame.isDetached()){await handle.dispose();throw new CdpContractError('DOCUMENT_UNAVAILABLE','Exact frame detached during document registration.');}
        this.#records.set(frame,record);if(old)this.#retire(old);return record;
    }
    #replacementError(error:unknown):boolean {return error instanceof Error&&/Execution context was destroyed|Cannot find context|JSHandle is disposed|Target page, context or browser has been closed|Cannot find object|Could not find object/i.test(error.message);}
    drop(frame:Frame):void {const record=this.#records.get(frame);if(record){this.#records.delete(frame);this.#retire(record);}}
    #retire(record:DocumentRecord):void{
        record.verified=false;this.#owner.retireDocument(record.id);
        void record.handle.evaluate(state=>{state.observer.disconnect();for(const event of ['input','change','focusin','focusout'])state.doc.removeEventListener(event,state.onState,true);}).catch(()=>{}).finally(()=>record.handle.dispose().catch(()=>{this.#disposalFailures++;}));
    }
    dispose():void {this.#disposed=true;for(const record of this.#records.values())this.#retire(record);this.#records.clear();}
    static install({key,id}:{key:string;id:string}):any {
        if(Object.hasOwn(document,key))throw new Error('DOCUMENT_MARKER_COLLISION');
        Object.defineProperty(document,key,{value:id,writable:false,configurable:false,enumerable:false});
        const state={doc:document,ids:new WeakMap<Element,string>(),mutations:0,stateChanges:0,observer:null as MutationObserver|null,onState:()=>{state.stateChanges++;}};
        state.observer=new MutationObserver(records=>{state.mutations+=records.length;});
        state.observer.observe(document,{subtree:true,childList:true,attributes:true,characterData:true});
        for(const event of ['input','change','focusin','focusout'])document.addEventListener(event,state.onState,true);
        return state;
    }
}
