import {CdpConditionMatcher} from './cdp-condition-matcher.mts';
import type {Page,Frame,ElementHandle,Locator} from 'playwright-core';
import {CdpContractError} from './cdp-contract.mts';
import type {CdpJsonObject} from './cdp-contract.mts';
import {CdpPreparedNative,CdpPreparedDrag} from './cdp-interactions.mts';
import type {CdpPreparedOperation} from './cdp-interactions.mts';
import {CdpDocuments} from './cdp-documents.mts';
import type {CdpDocumentProof} from './cdp-documents.mts';
import type {CdpFrameSelection} from './cdp-frames.mts';
export interface CdpElementIdentity {readonly elementId:string;readonly documentId:string;readonly frameId:string;}
export interface CdpTargetsOwner {readonly page:Page;readonly pageId:string;resolveFrame(frameId:string|null):Promise<CdpFrameSelection>;}
class CdpElementReference {
    readonly identity:CdpElementIdentity;readonly handle:ElementHandle<Element>;readonly frame:Frame;
    constructor(handle:ElementHandle<Element>,identity:CdpElementIdentity,frame:Frame){this.handle=handle;this.identity=Object.freeze(identity);this.frame=frame;}
}
export class CdpPreparedInput {
    readonly identity:CdpElementIdentity;
    readonly sensitive:boolean;
    readonly #reference:CdpElementReference;
    readonly #owner:CdpTargets;
    readonly #operation:string;
    readonly #args:any;
    #used=false;
    constructor(owner:CdpTargets,reference:CdpElementReference,operation:string,args:any,sensitive:boolean) {
        this.#owner=owner; this.#reference=reference; this.identity=reference.identity;
        this.#operation=operation; this.#args=args; this.sensitive=sensitive;
    }
    async dispatch():Promise<CdpJsonObject> {
        if(this.#used) throw new CdpContractError('DISPATCH_NOT_GRANTED','Prepared input is one-use.');
        this.#used=true; await this.#owner.assertReference(this.#reference);
        const handle=this.#reference.handle, args=this.#args, timeout=args.options.timeoutMs;
        if(this.#operation==='Click') await handle.click({button:args.button,clickCount:args.clickCount,modifiers:args.modifiers,timeout});
        else if(this.#operation==='Fill') await handle.fill(args.value,{timeout});
        else await handle.press(args.key,{timeout});
        const ordinary=this.#operation==='Fill'&&!this.sensitive&&this.#args.sensitive===false&&this.#args.secretRef===null&&await handle.evaluate(element=>!(element.tagName==='INPUT'&&element.getAttribute('type')?.toLowerCase()==='password'));
        return {...(ordinary?{fillDiagnostic:{classification:'ordinary',...this.identity}}:{}),target:this.identity as unknown as CdpJsonObject,actionability:{visible:true,enabled:true,stable:true,editable:this.#operation==='Fill',publicBrowserHitTesting:this.#operation==='Click'},inputMethod:'playwright.elementHandle.'+this.#operation,inputDispatched:true,businessSuccessVerified:false};
    }
}

// One Targets owner supplies both the frozen Frame registry and every element/document proof.
export class CdpTargets {
    readonly #owner:CdpTargetsOwner;
    readonly #page:Page;
    readonly #documents:CdpDocuments;
    readonly #references=new Map<string,CdpElementReference>();
    #disposalFailures=0;
    constructor(owner:CdpTargetsOwner){this.#owner=owner;this.#page=owner.page;this.#documents=new CdpDocuments(this);}
    get documentKey():string{return this.#documents.documentKey;}
    get disposalFailures():number{return this.#disposalFailures+this.#documents.disposalFailures;}
    cachedDocument(frame:Frame):string|null{return this.#documents.cached(frame);}
    documentProof(frame:Frame):Promise<CdpDocumentProof>{return this.#documents.proof(frame);}
    noteNavigation(frame:Frame):void{this.#documents.noteNavigation(frame);}
    dropFrame(frame:Frame):void{this.#documents.drop(frame);}
    retireDocument(documentId:string):void{
        for(const [id,reference]of this.#references)if(reference.identity.documentId===documentId){this.#references.delete(id);void reference.handle.dispose().catch(()=>{this.#disposalFailures++;});}
    }
    invalidate():void{this.#documents.dispose();for(const reference of this.#references.values())void reference.handle.dispose().catch(()=>{this.#disposalFailures++;});this.#references.clear();}
    async #selection(frameId:string|null):Promise<CdpFrameSelection>{
        const selection=await this.#owner.resolveFrame(frameId);if(!selection.describe().documentId)throw new CdpContractError('DOCUMENT_UNAVAILABLE','Exact frame document proof is unavailable.');return selection;
    }
    async assertReference(value:{identity:CdpElementIdentity;handle:ElementHandle<Element>}):Promise<void>{
        const reference=this.#references.get(value.identity.elementId);
        if(!reference||reference.handle!==value.handle||reference.identity.documentId!==value.identity.documentId||reference.identity.frameId!==value.identity.frameId)throw new CdpContractError('STALE_ELEMENT','Element is not retained in this document.');
        const proof=await this.#documents.proof(reference.frame);
        if(proof.documentId!==reference.identity.documentId)throw new CdpContractError('STALE_DOCUMENT','Exact frame document was replaced; no retarget.');
        if(!await reference.handle.evaluate(element=>element.isConnected))throw new CdpContractError('STALE_ELEMENT','Pinned element detached; no replacement selected.');
    }
    async #byIdentity(target:any):Promise<CdpElementReference>{
        const selection=await this.#selection(target.frameId),descriptor=selection.describe();
        if(target.documentId!==descriptor.documentId)throw new CdpContractError('STALE_DOCUMENT','Element belongs to a different exact frame document.');
        const reference=this.#references.get(target.elementId);
        if(!reference||reference.identity.frameId!==descriptor.frameId)throw new CdpContractError('FOREIGN_ELEMENT','Element is not retained by this page/frame.');
        await this.assertReference(reference);return reference;
    }
    async #retain(handle:ElementHandle<Element>,selection:CdpFrameSelection):Promise<CdpElementReference>{
        const descriptor=selection.describe(),identity=await this.#documents.identify(selection.frame(),handle);
        if(identity.documentId!==descriptor.documentId){await handle.dispose();throw new CdpContractError('STALE_DOCUMENT','Document changed before retaining element.');}
        const old=this.#references.get(identity.elementId);
        if(old){await handle.dispose();await this.assertReference(old);return old;}
        if(this.#references.size>=5000){await handle.dispose();throw new CdpContractError('ELEMENT_CAPACITY','Bounded retained element capacity exhausted.');}
        const reference=new CdpElementReference(handle,{elementId:identity.elementId,documentId:identity.documentId,frameId:descriptor.frameId},selection.frame());
        this.#references.set(identity.elementId,reference);
        try{await this.assertReference(reference);return reference;}catch(error){this.#references.delete(identity.elementId);await handle.dispose();throw error;}
    }
    #locator(frame:Frame,target:any):Locator{
        const options={exact:target.exact};switch(target.strategy){
            case 'role':return frame.getByRole(target.value,{...options,...(target.name!==null?{name:target.name}:{})});
            case 'testId':return frame.getByTestId(target.value);
            case 'label':return frame.getByLabel(target.value,options);
            case 'placeholder':return frame.getByPlaceholder(target.value,options);
            case 'text':return frame.getByText(target.value,options);
            default:return frame.locator('css='+target.value);
        }
    }
    async #matches(target:any,selection:CdpFrameSelection):Promise<ElementHandle<Element>[]>{
        if(target.exact!==true&&['testId','css'].includes(target.strategy))throw new CdpContractError('TARGET_OPTION_UNSUPPORTED','Strategy cannot honor exact=false.');
        const descriptor=selection.describe(),within=target.withinElementId===null?null:this.#references.get(target.withinElementId);
        if(target.withinElementId!==null&&!within)throw new CdpContractError('FOREIGN_ELEMENT','Within-element is not retained by this page.');
        if(within){if(within.identity.frameId!==descriptor.frameId||within.identity.documentId!==descriptor.documentId)throw new CdpContractError('FRAME_CONFLICT','Within-element scope differs from the locator.');await this.assertReference(within);}
        const locator=this.#locator(selection.frame(),target);if(await locator.count()>1000)throw new CdpContractError('TARGET_LIMIT','Target match budget exceeded.');
        // Locator resolves DOM Elements; its broad default Node generic loses that guarantee.
        const candidates=await locator.elementHandles() as ElementHandle<Element>[],admitted:ElementHandle<Element>[]=[];
        try{for(const handle of candidates){if(!within||await within.handle.evaluate((parent,child)=>parent.contains(child),handle))admitted.push(handle);else await handle.dispose();}return admitted;}
        catch(error){for(const handle of admitted)await handle.dispose();throw error;}
    }
    async resolve(target:any):Promise<CdpElementReference>{
        if(target.kind==='element')return this.#byIdentity(target);
        const selection=await this.#selection(target.frameId),admitted=await this.#matches(target,selection);
        try{if(admitted.length!==1)throw new CdpContractError(admitted.length?'AMBIGUOUS_TARGET':'TARGET_NOT_FOUND','Target must resolve exactly once in the selected frame.');return await this.#retain(admitted.pop()!,selection);}
        finally{for(const handle of admitted)await handle.dispose();}
    }
    async inspect(target:any,options:any):Promise<CdpJsonObject>{
        const reference=await this.resolve(target),result=await reference.handle.evaluate(CdpTargets.inspectDom,options);await this.assertReference(reference);
        return {matchCount:1,target:{kind:'element',...reference.identity},...result,units:'CSS pixels in selected frame viewport',measurement:'read-only DOM/computed state; no focus, scroll or trial input',stabilityMeasured:false,hitTestingMeasured:false};
    }
    async condition(condition:any):Promise<CdpJsonObject>{
        const target=condition.target,selection=await this.#selection(target.frameId),descriptor=selection.describe();
        let handle:ElementHandle<Element>|null=null,temporary=false;
        if(target.kind==='element'){
            if(target.documentId!==descriptor.documentId)throw new CdpContractError('STALE_DOCUMENT','Element condition is document scoped.');
            const reference=this.#references.get(target.elementId);if(!reference||reference.identity.frameId!==descriptor.frameId)throw new CdpContractError('FOREIGN_ELEMENT','Unknown ElementId is not detachment evidence.');handle=reference.handle;
        }else{
            const admitted=await this.#matches(target,selection);try{if(admitted.length>1)throw new CdpContractError('AMBIGUOUS_TARGET','Readiness target must be unique.');handle=admitted.pop()??null;temporary=handle!==null;}finally{for(const item of admitted)await item.dispose();}
        }
        try{
            const attached=!!handle&&await handle.evaluate(element=>element.isConnected);let satisfied=false;
            if(condition.kind==='text'){const data=attached?await handle!.evaluate(element=>{const text=element.matches('input,textarea')?'':(element as HTMLElement).innerText??element.textContent??'';return {text:text.slice(0,32768),truncated:text.length>32768};}):{text:'',truncated:false};if(data.truncated)throw new CdpContractError('MATCH_INPUT_UNAVAILABLE','Complete element text exceeds bounded matching input.');satisfied=attached&&CdpConditionMatcher.matches(data.text,condition.match);}
            else switch(condition.state){case 'attached':satisfied=attached;break;case 'detached':satisfied=!attached;break;case 'visible':satisfied=attached&&await handle!.isVisible();break;case 'hidden':satisfied=!attached||!await handle!.isVisible();break;case 'enabled':satisfied=attached&&await handle!.isEnabled();break;case 'disabled':satisfied=attached&&!await handle!.isEnabled();break;case 'checked':case 'unchecked':satisfied=attached&&(await handle!.isChecked())===(condition.state==='checked');break;}
            await selection.assertCurrent();return {satisfied,kind:condition.kind,state:condition.state??null,documentId:descriptor.documentId,frameId:descriptor.frameId,matchCount:attached?1:0,observedAtUtc:new Date().toISOString()};
        }finally{if(temporary)await handle?.dispose();}
    }
    static inspectDom(element:Element,options:any):any {
        let remaining=options.maxChars,truncated=false;
        const bounded=(value:string|null):string|null=>{if(value===null)return null;const result=value.slice(0,remaining);remaining-=result.length;if(result.length<value.length)truncated=true;return result;};
        const password=element.tagName==='INPUT'&&element.getAttribute('type')?.toLowerCase()==='password';
        const attributes:Record<string,string|null>={},styles:Record<string,string>={};
        for(const name of options.attributes)attributes[name]=password&&name.toLowerCase()==='value'?'[OMITTED_PASSWORD_VALUE]':bounded(element.getAttribute(name));
        const style=getComputedStyle(element,options.pseudo?'::'+options.pseudo:null);
        for(const name of options.styleProperties)styles[name]=bounded(style.getPropertyValue(name))??'';
        const rect=(r:DOMRect)=>({x:r.x,y:r.y,width:r.width,height:r.height,top:r.top,right:r.right,bottom:r.bottom,left:r.left});
        const bounds=element.getBoundingClientRect(),visible=!!(bounds.width&&bounds.height)&&style.display!=='none'&&!['hidden','collapse'].includes(style.visibility);
        const native=(prototype:object,name:string)=>Object.getOwnPropertyDescriptor(prototype,name)?.get?.call(element);
        const value=password?null:element instanceof HTMLInputElement?native(HTMLInputElement.prototype,'value'):element instanceof HTMLTextAreaElement?native(HTMLTextAreaElement.prototype,'value'):element instanceof HTMLSelectElement?native(HTMLSelectElement.prototype,'value'):null;
        return {value:typeof value==='string'?bounded(value):null,focused:element===document.activeElement,checked:element instanceof HTMLInputElement&&['checkbox','radio'].includes(element.type)?native(HTMLInputElement.prototype,'checked'):null,attributes,styles,pseudo:options.pseudo,text:options.includeText?bounded(element.matches('input,textarea')?'':((element as HTMLElement).innerText??element.textContent??'')):null,passwordValueOmitted:password,boundingRect:options.includeRect?rect(bounds):null,clientRects:options.includeRect?[...element.getClientRects()].slice(0,32).map(rect):[],clientRectsTruncated:element.getClientRects().length>32,scroll:{left:element.scrollLeft,top:element.scrollTop,width:element.scrollWidth,height:element.scrollHeight,clientWidth:element.clientWidth,clientHeight:element.clientHeight},state:{attached:element.isConnected,visible,disabled:element.matches(':disabled'),ariaDisabled:element.getAttribute('aria-disabled')==='true',editable:!password&&((element instanceof HTMLInputElement||element instanceof HTMLTextAreaElement)?!element.readOnly&&!element.disabled:(element as HTMLElement).isContentEditable===true),password},truncated};
    }

    async prepare(operation:string,args:any):Promise<CdpPreparedOperation>{
        if(operation==='DragAndDrop')return this.#prepareDrag(args);
        if(operation==='Fill'&&args.secretRef!==null)throw new CdpContractError('SECRET_REF_UNSUPPORTED','No secret resolver exists.');
        const reference=args.target===null?await this.#defaultElement(operation==='Scroll'):await this.resolve(args.target);
        if(args.options.expectedDocumentId!==null&&args.options.expectedDocumentId!==reference.identity.documentId)throw new CdpContractError('STALE_DOCUMENT','Expected document differs from selected frame document.');
        const timeout=args.options.timeoutMs;await reference.handle.waitForElementState('visible',{timeout});
        if(operation!=='Hover')await reference.handle.waitForElementState('enabled',{timeout});await reference.handle.waitForElementState('stable',{timeout});
        if(operation==='Fill')await reference.handle.waitForElementState('editable',{timeout});
        const state=await reference.handle.evaluate(element=>({tag:element.tagName.toLowerCase(),type:element.getAttribute('type')?.toLowerCase()??'text',editable:element instanceof HTMLElement&&element.isContentEditable}));
        if(operation==='Fill'&&!(state.tag==='textarea'||state.editable||state.tag==='input'&&['text','search','email','url','tel','password'].includes(state.type)))throw new CdpContractError('FILL_TARGET_UNSUPPORTED','Unsupported editable target.');
        await this.assertReference(reference);
        if(['Hover','SelectOptions','SetChecked','Scroll'].includes(operation)){await CdpPreparedNative.validate(reference,operation,args);return new CdpPreparedNative(this,reference,operation,args);}
        return new CdpPreparedInput(this,reference,operation,args,operation==='Fill'&&(args.sensitive||state.type==='password'));
    }
    async #defaultElement(scroll:boolean):Promise<CdpElementReference>{
        const selection=await this.#selection(null),handle=await selection.frame().evaluateHandle(scroll?()=>document.scrollingElement??document.documentElement:()=>document.activeElement),element=handle.asElement() as ElementHandle<Element>|null;
        if(!element){await handle.dispose();throw new CdpContractError('TARGET_NOT_FOUND','No default main-frame element.');}
        if(!scroll&&await element.evaluate(value=>value.matches('iframe,frame'))){await element.dispose();throw new CdpContractError('FRAME_SELECTION_REQUIRED','An explicit target is required for keyboard input in a child frame.');}
        return this.#retain(element,selection);
    }
    async #prepareDrag(args:any):Promise<CdpPreparedDrag>{
        if(args.inputMethod!=='pointer')throw new CdpContractError('DRAG_METHOD_UNSUPPORTED','Only pointer gesture supported; no fallback.');
        const source=await this.resolve(args.source),destination=await this.resolve(args.destination),main=await this.#selection(null);
        if(source.identity.frameId!==main.describe().frameId||destination.identity.frameId!==source.identity.frameId||destination.identity.documentId!==source.identity.documentId)throw new CdpContractError('FRAME_UNSUPPORTED','Pointer drag remains main-frame only until frame coordinate hit-testing is proven.');
        if(args.options.expectedDocumentId!==null&&args.options.expectedDocumentId!==source.identity.documentId)throw new CdpContractError('STALE_DOCUMENT','Expected drag document changed.');
        for(const reference of [source,destination]){await reference.handle.waitForElementState('visible',{timeout:args.options.timeoutMs});await reference.handle.waitForElementState('enabled',{timeout:args.options.timeoutMs});await reference.handle.waitForElementState('stable',{timeout:args.options.timeoutMs});await this.assertReference(reference);}
        return new CdpPreparedDrag(this,this.#page,source,destination,args.options.timeoutMs);
    }
    async capture(options:any,target:any):Promise<{content:CdpJsonObject;proof:CdpDocumentProof;frameId:string}>{
        const selection=await this.#selection(options.frameId),descriptor=selection.describe(),proof=await this.#documents.proof(selection.frame());
        if(target?.frameId!==null&&target?.frameId!==undefined&&target.frameId!==descriptor.frameId)throw new CdpContractError('FRAME_CONFLICT','Observe target and options select different frames.');
        const effectiveTarget=target===null?null:{...target,frameId:descriptor.frameId};
        const reference=effectiveTarget===null?null:await this.resolve(effectiveTarget);
        const body=reference?null:await selection.frame().locator('html').elementHandle();if(!reference&&!body)throw new CdpContractError('TARGET_NOT_FOUND','No document root.');
        let actual;try{const root=(reference?.handle??body!) as ElementHandle<Element>;actual=await root.evaluateHandle(CdpTargets.snapshot,options);}finally{await body?.dispose();}
        try{
            const data=await actual.getProperty('data');let content:any;try{content=await data.jsonValue();}finally{await data.dispose();}
            const elements=await actual.getProperty('elements');try{for(const [index,handle]of await elements.getProperties()){const element=handle.asElement() as ElementHandle<Element>|null;if(!element){await handle.dispose();continue;}const retained=await this.#retain(element,selection);content.nodes[Number(index)].target={kind:'element',...retained.identity};}}finally{await elements.dispose();}
            const after=await this.#documents.proof(selection.frame());if(after.documentId!==proof.documentId||after.epoch!==proof.epoch)throw new CdpContractError('OBSERVATION_CHANGED_DURING_CAPTURE','Document/observed epoch changed; no mixed snapshot retained.');
            return {content,proof:after,frameId:descriptor.frameId};
        }finally{await actual.dispose();}
    }
    static snapshot(root:Element,options:any):any{
        const nodes:any[]=[],elements:Record<string,Element>={};let characters=0,visited=0,truncated=false;
        const active=document.activeElement,focus={hasFocus:document.hasFocus(),activeTag:active?.tagName.toLowerCase()??null,activeWithinCapture:!!active&&root.contains(active)};
        const text=(value:string,limit:number)=>{const result=value.slice(0,Math.min(limit,options.maxChars-characters));characters+=result.length;if(result.length<value.length)truncated=true;return result;};
        const getter=(prototype:object,name:string,element:Element)=>Object.getOwnPropertyDescriptor(prototype,name)?.get?.call(element);
        const walker=document.createTreeWalker(root,NodeFilter.SHOW_ELEMENT|NodeFilter.SHOW_TEXT);let node:Node|null=root;
        do{
            if(++visited>5000||nodes.length>=options.maxNodes||characters>=options.maxChars){truncated=true;break;}
            const element=node.nodeType===Node.ELEMENT_NODE?node as Element:node.parentElement;if(!element||element.closest('script,style,noscript,[hidden]'))continue;
            const rect=element.getBoundingClientRect(),style=getComputedStyle(element);if(!rect.width||!rect.height||['hidden','collapse'].includes(style.visibility)||style.display==='none')continue;
            let item:any=null;
            if(node.nodeType===Node.TEXT_NODE&&options.includeText&&!element.closest('textarea,select')){const value=(node.nodeValue??'').replace(/\s+/g,' ').trim();if(value)item={kind:'text',text:text(value,4096)};}
            else if(node.nodeType===Node.ELEMENT_NODE&&options.includeControls&&element.matches('input,textarea,button,select,a,[role],[contenteditable]')){
                const input=element instanceof HTMLInputElement,area=element instanceof HTMLTextAreaElement,select=element instanceof HTMLSelectElement,password=input&&element.type==='password';
                const value=password?null:input?getter(HTMLInputElement.prototype,'value',element):area?getter(HTMLTextAreaElement.prototype,'value',element):select?getter(HTMLSelectElement.prototype,'value',element):null;
                item={kind:'control',tag:element.tagName.toLowerCase(),role:text(element.getAttribute('role')??'',80),label:text(element.getAttribute('aria-label')??'',256),name:text(element.getAttribute('name')??'',256),type:input?element.type:null,password,passwordValueOmitted:password,value:typeof value==='string'?text(value,512):null,focused:element===active,state:{disabled:element.matches(':disabled'),ariaDisabled:element.getAttribute('aria-disabled')==='true',readOnly:element.hasAttribute('readonly'),checked:input&&['checkbox','radio'].includes(element.type)?getter(HTMLInputElement.prototype,'checked',element):null,selected:select?[...element.selectedOptions].slice(0,32).map(option=>text(option.value,256)):null,editable:!password&&(input||area? !element.matches(':disabled')&&!element.hasAttribute('readonly'):(element as HTMLElement).isContentEditable)}};
            }
            if(item){if(options.includeRects)item.rect={x:rect.x,y:rect.y,width:rect.width,height:rect.height};elements[String(nodes.length)]=element;nodes.push(item);}
        }while((node=walker.nextNode()));
        return {data:{nodes,characters,visited,truncated,focus,valuePolicy:'bounded native nonpassword control values; password values omitted'},elements};
    }
}
