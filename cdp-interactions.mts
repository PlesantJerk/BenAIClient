import type {Page,ElementHandle} from 'playwright-core';
import {CdpContractError} from './cdp-contract.mts';
import type {CdpJsonObject} from './cdp-contract.mts';
import type {CdpTargets,CdpElementIdentity} from './cdp-targets.mts';

export interface CdpPinnedElement {readonly identity:CdpElementIdentity;readonly handle:ElementHandle<Element>;}
export interface CdpPreparedOperation {readonly identity:CdpElementIdentity;readonly destinationIdentity?:CdpElementIdentity;readonly sensitive:boolean;dispatch():Promise<CdpJsonObject>;}

// Native controls and CSS scrolling, never a custom-control/application state shortcut.
export class CdpPreparedNative implements CdpPreparedOperation {
    readonly identity:CdpElementIdentity;
    readonly sensitive=false;
    readonly #owner:CdpTargets;
    readonly #reference:CdpPinnedElement;
    readonly #operation:string;
    readonly #args:any;
    #used=false;
    constructor(owner:CdpTargets,reference:CdpPinnedElement,operation:string,args:any){this.#owner=owner;this.#reference=reference;this.identity=reference.identity;this.#operation=operation;this.#args=args;}
    static async validate(reference:CdpPinnedElement,operation:string,args:any):Promise<void>{
        const state=await reference.handle.evaluate((element,values)=>({tag:element.tagName,type:element.getAttribute('type')?.toLowerCase(),multiple:(element as HTMLSelectElement).multiple,checked:(element as HTMLInputElement).checked,options:element instanceof HTMLSelectElement?[...element.options].filter(option=>values.includes(option.value)).slice(0,129).map(option=>({value:option.value,disabled:option.disabled||option.parentElement instanceof HTMLOptGroupElement&&option.parentElement.disabled})):[]}),args.values??[]);
        if(operation==='SelectOptions'){
            if(state.tag!=='SELECT')throw new CdpContractError('SELECT_TARGET_UNSUPPORTED','Only a native select is supported.');
            if(!state.multiple&&args.values.length>1)throw new CdpContractError('SELECT_VALUES_UNSUPPORTED','A single select cannot receive multiple values.');
            for(const value of args.values){const options=state.options.filter(option=>option.value===value);if(options.length!==1)throw new CdpContractError(options.length?'AMBIGUOUS_OPTION':'OPTION_NOT_FOUND','Each requested native value must identify exactly one option.');if(options[0].disabled)throw new CdpContractError('OPTION_DISABLED','Disabled native options are not selected.');}
        }
        if(operation==='SetChecked'){
            if(state.tag!=='INPUT'||!['checkbox','radio'].includes(state.type??''))throw new CdpContractError('CHECK_TARGET_UNSUPPORTED','Only native checkbox/radio controls are supported.');
            if(state.type==='radio'&&state.checked&&args.checked===false)throw new CdpContractError('RADIO_UNCHECK_UNSUPPORTED','A checked native radio cannot be independently unchecked.');
        }
    }
    async dispatch():Promise<CdpJsonObject>{
        if(this.#used)throw new CdpContractError('DISPATCH_NOT_GRANTED','Prepared input is one-use.');this.#used=true;
        await this.#owner.assertReference(this.#reference);await CdpPreparedNative.validate(this.#reference,this.#operation,this.#args);
        let result:CdpJsonObject;
        switch(this.#operation){case 'Hover':await this.#reference.handle.hover({timeout:this.#args.options.timeoutMs});result={inputDispatched:true,noOp:false,inputMethod:'playwright.elementHandle.hover'};break;case 'SelectOptions':result=await this.#select();break;case 'SetChecked':result=await this.#check();break;case 'Scroll':result=await this.#scroll();break;default:throw new CdpContractError('UNSUPPORTED_OPERATION','No native input adapter exists.');}
        await this.#owner.assertReference(this.#reference);
        return {...result,target:{...this.identity},businessSuccessVerified:false};
    }
    async #select():Promise<CdpJsonObject>{
        const handle=this.#reference.handle,args=this.#args;
        const before=await handle.evaluate(element=>[...(element as HTMLSelectElement).selectedOptions].map(option=>option.value));
        const noOp=before.length===args.values.length&&before.every(value=>args.values.includes(value));
        const selected=noOp?before:await handle.selectOption(args.values,{timeout:args.options.timeoutMs});
        const after=await handle.evaluate(element=>[...(element as HTMLSelectElement).selectedOptions].map(option=>option.value));
        if(after.length!==args.values.length||after.some(value=>!args.values.includes(value)))throw new CdpContractError('SELECT_STATE_UNVERIFIED','Native selection returned without the requested selected values.');
        return {before,after,selected,noOp,inputDispatched:!noOp,inputMethod:'playwright.elementHandle.selectOption',eventProvenance:'public library input/change dispatch, not claimed physical trusted input'};
    }
    async #check():Promise<CdpJsonObject>{
        const before=await this.#reference.handle.isChecked(),noOp=before===this.#args.checked;
        if(!noOp)await this.#reference.handle.setChecked(this.#args.checked,{timeout:this.#args.options.timeoutMs});
        const after=await this.#reference.handle.isChecked();
        if(after!==this.#args.checked)throw new CdpContractError('CHECK_STATE_UNVERIFIED','Native checked state did not match the requested state.');
        return {before,after,noOp,inputDispatched:!noOp,inputMethod:'playwright.elementHandle.setChecked'};
    }
    async #scroll():Promise<CdpJsonObject>{
        return this.#reference.handle.evaluate((element,args)=>{
            const read=()=>{const direction=getComputedStyle(element).direction,maxX=Math.max(0,element.scrollWidth-element.clientWidth),maxY=Math.max(0,element.scrollHeight-element.clientHeight),minLeft=direction==='rtl'?-maxX:0,maxLeft=direction==='rtl'?0:maxX;return {left:element.scrollLeft,top:element.scrollTop,minLeft,maxLeft,minTop:0,maxTop:maxY,direction};};
            const before=read(),noOp=args.deltaX===0&&args.deltaY===0;
            if(!noOp)element.scrollBy({left:args.deltaX,top:args.deltaY,behavior:'instant'});
            const after=read();
            return {before,after,offsetChanged:before.left!==after.left||before.top!==after.top,reachedBounds:{minX:after.left<=after.minLeft,maxX:after.left>=after.maxLeft,minY:after.top<=0,maxY:after.top>=after.maxTop},units:'CSS pixels',noOp,inputDispatched:!noOp,inputMethod:'DOM.Element.scrollBy(instant); not wheel input',applicationReadinessVerified:false};
        },{deltaX:this.#args.deltaX,deltaY:this.#args.deltaY});
    }
}

// Two pinned elements, one page-bound pointer gesture. Never Locator.dragTo re-resolution or synthetic fallback.
export class CdpPreparedDrag implements CdpPreparedOperation {
    readonly identity:CdpElementIdentity;
    readonly destinationIdentity:CdpElementIdentity;
    readonly sensitive=false;
    readonly #owner:CdpTargets;
    readonly #page:Page;
    readonly #source:CdpPinnedElement;
    readonly #destination:CdpPinnedElement;
    readonly #timeout:number;
    #used=false;
    constructor(owner:CdpTargets,page:Page,source:CdpPinnedElement,destination:CdpPinnedElement,timeout:number){this.#owner=owner;this.#page=page;this.#source=source;this.#destination=destination;this.identity=source.identity;this.destinationIdentity=destination.identity;this.#timeout=timeout;}
    async #point(reference:CdpPinnedElement):Promise<{x:number;y:number}>{
        await this.#owner.assertReference(reference);
        const box=await reference.handle.boundingBox();if(!box||box.width<=0||box.height<=0)throw new CdpContractError('DRAG_GEOMETRY_UNAVAILABLE','Pinned drag target has no visible CSS rectangle.');
        const point={x:box.x+box.width/2,y:box.y+box.height/2};
        const hit=await reference.handle.evaluate((element,p)=>{const actual=document.elementFromPoint(p.x,p.y);return actual===element||actual!==null&&element.contains(actual);},point);
        if(!hit)throw new CdpContractError('DRAG_TARGET_OBSCURED','Pinned drag center is outside viewport or obscured. No replacement or synthetic input was selected.');
        return point;
    }
    async dispatch():Promise<CdpJsonObject>{
        if(this.#used)throw new CdpContractError('DISPATCH_NOT_GRANTED','Prepared drag is one-use.');this.#used=true;
        await this.#source.handle.scrollIntoViewIfNeeded({timeout:this.#timeout});await this.#destination.handle.scrollIntoViewIfNeeded({timeout:this.#timeout});
        const source=await this.#point(this.#source),destination=await this.#point(this.#destination);
        let down=false,released=false,failure:unknown=null;
        try{
            await this.#page.mouse.move(source.x,source.y);await this.#owner.assertReference(this.#source);await this.#owner.assertReference(this.#destination);
            down=true;await this.#page.mouse.down({button:'left'});
            await this.#page.mouse.move(source.x+3,source.y+3,{steps:2});
            await this.#page.mouse.move(destination.x,destination.y,{steps:8});await this.#page.mouse.move(destination.x,destination.y,{steps:2});
            await this.#owner.assertReference(this.#source);await this.#owner.assertReference(this.#destination);
        }catch(error){failure=error;}finally{if(down){try{await this.#page.mouse.up({button:'left'});released=true;}catch(error){failure=failure?new AggregateError([failure,error],'Pointer gesture and release failed.'):error;}}}
        if(failure)throw failure;
        return {target:{...this.identity},destinationTarget:{...this.destinationIdentity},sourcePoint:source,destinationPoint:destination,units:'CSS pixels',inputMethod:'playwright.page.mouse pointer gesture',inputDispatched:true,pointerReleased:released,noSyntheticFallback:true,businessSuccessVerified:false};
    }
}
