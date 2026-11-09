import type {ElementHandle,Frame} from 'playwright-core';
import type {CdpBrowserPage} from './cdp-browser.mts';
import type {CdpElementIdentity} from './cdp-targets.mts';
import {CdpContractError} from './cdp-contract.mts';
import type {CdpJsonObject} from './cdp-contract.mts';

interface Rect {x:number;y:number;width:number;height:number;}
interface Geometry {rect:Rect;viewport:{width:number;height:number};client:{left:number;top:number;width:number;height:number};}
interface Pinned {identity:CdpElementIdentity;handle:ElementHandle<Element>;frame:Frame;}
interface Sample {rectangle:Rect;documents:{frameId:string;documentId:string}[];observedAtUtc:string;}
// One pinned element. Main-viewport pixels include occluders and iframe borders; this is not isolated element paint.
export class CdpImageTarget {
    readonly #owner:CdpBrowserPage;
    readonly #reference:Pinned;
    readonly #before:Sample;
    private constructor(owner:CdpBrowserPage,reference:Pinned,before:Sample){this.#owner=owner;this.#reference=reference;this.#before=before;}
    static async prepare(owner:CdpBrowserPage,target:unknown):Promise<CdpImageTarget>{
        const reference=await owner.targets.resolve(target),before=await this.#sample(owner,reference);
        return new CdpImageTarget(owner,reference,before);
    }
    get clip():Rect{return {...this.#before.rectangle};}
    get documentId():string{return this.#reference.identity.documentId;}
    async verify():Promise<CdpJsonObject>{
        const after=await CdpImageTarget.#sample(this.#owner,this.#reference);
        if(JSON.stringify(after.documents)!==JSON.stringify(this.#before.documents)||!CdpImageTarget.#same(after.rectangle,this.#before.rectangle))
            throw new CdpContractError('IMAGE_TARGET_CHANGED','Pinned document/ancestor/layout changed during capture; no artifact admitted.');
        return {target:{kind:'element',...this.#reference.identity},coordinateSpace:'main viewport CSS pixels',rectangle:{...after.rectangle},documents:after.documents,observedBeforeUtc:this.#before.observedAtUtc,observedAfterUtc:after.observedAtUtc,layoutToleranceCssPixels:0.25,possibleOcclusion:true,isolatedElementPaint:false,scrollOrInputDispatched:false,paintAtomicityClaimed:false};
    }
    static #same(a:Rect,b:Rect):boolean{return ['x','y','width','height'].every(key=>Math.abs(a[key as keyof Rect]-b[key as keyof Rect])<=0.25);}
    static #inside(rect:Rect,width:number,height:number):boolean{return rect.x>=-0.01&&rect.y>=-0.01&&rect.x+rect.width<=width+0.01&&rect.y+rect.height<=height+0.01;}
    static async #geometry(handle:ElementHandle<Element>):Promise<Geometry>{
        const value=await handle.evaluate(CdpImageTarget.#native);
        if(value.error)throw new CdpContractError(value.error,'Visible single rectangular geometry is unavailable, transformed, clipped or outside its viewport. No scrolling/fallback occurred.');
        return value as Geometry;
    }
    static async #sample(owner:CdpBrowserPage,reference:Pinned):Promise<Sample>{
        await owner.targets.assertReference(reference);
        let frame=reference.frame,geometry=await this.#geometry(reference.handle),rectangle={...geometry.rect};
        const documents:{frameId:string;documentId:string}[]=[];
        for(let depth=0;;depth++){
            if(depth>16)throw new CdpContractError('IMAGE_FRAME_LIMIT','Frame ancestry exceeds bounded geometry coverage.');
            const frameId=owner.frames.idFor(frame);if(!frameId)throw new CdpContractError('FRAME_UNAVAILABLE','No exact owned FrameId.');
            const proof=await owner.targets.documentProof(frame);documents.push({frameId,documentId:proof.documentId});
            const parent=frame.parentFrame();if(!parent)break;
            // Public Frame.frameElement returns its iframe/frame Element; default Node typing loses that guarantee.
            const element=await frame.frameElement() as ElementHandle<Element>;
            try{
                if(await element.ownerFrame()!==parent)throw new CdpContractError('FRAME_UNAVAILABLE','Exact public frame-element owner changed.');
                const parentGeometry=await this.#geometry(element);
                if(Math.abs(parentGeometry.client.width-geometry.viewport.width)>1||Math.abs(parentGeometry.client.height-geometry.viewport.height)>1)
                    throw new CdpContractError('IMAGE_FRAME_SCALE_UNSUPPORTED','Child viewport and frame content box are not unscaled CSS coordinates.');
                rectangle={...rectangle,x:rectangle.x+parentGeometry.rect.x+parentGeometry.client.left,y:rectangle.y+parentGeometry.rect.y+parentGeometry.client.top};
                if(!this.#inside(rectangle,parentGeometry.viewport.width,parentGeometry.viewport.height))throw new CdpContractError('IMAGE_TARGET_OFFSCREEN','Child crop is not wholly visible in ancestor viewport.');
                geometry=parentGeometry;
            }finally{await element.dispose();}
            frame=parent;
        }
        if(frame!==owner.page.mainFrame())throw new CdpContractError('FRAME_UNAVAILABLE','Target does not reach the exact owned main Frame.');
        const publicBox=await reference.handle.boundingBox();
        if(!publicBox||!this.#same(rectangle,publicBox))throw new CdpContractError('IMAGE_GEOMETRY_UNAVAILABLE','Public main-viewport box disagrees with measured frame ancestry.');
        await owner.targets.assertReference(reference);
        return {rectangle:{...publicBox},documents,observedAtUtc:new Date().toISOString()};
    }
    static #native = (element:Element):Geometry&{error?:string} => {
        const rect=element.getBoundingClientRect(),viewport={width:innerWidth,height:innerHeight},client={left:element.clientLeft,top:element.clientTop,width:element.clientWidth,height:element.clientHeight};
        const result={rect:{x:rect.x,y:rect.y,width:rect.width,height:rect.height},viewport,client};
        if(!element.isConnected)return {...result,error:'STALE_ELEMENT'};
        if(element.getClientRects().length!==1||rect.width<=0||rect.height<=0)return {...result,error:'IMAGE_TARGET_EMPTY'};
        if(![rect.x,rect.y,rect.width,rect.height].every(Number.isFinite))return {...result,error:'IMAGE_GEOMETRY_UNAVAILABLE'};
        if(visualViewport&&Math.abs(visualViewport.scale-1)>0.001)return {...result,error:'IMAGE_ZOOM_UNSUPPORTED'};
        for(let node:Element|null=element;node;node=node.parentElement){
            const style=getComputedStyle(node);
            if(style.display==='none'||['hidden','collapse'].includes(style.visibility)||Number(style.opacity)===0)return {...result,error:'IMAGE_TARGET_HIDDEN'};
            const zoom=style.getPropertyValue('zoom');
            if(style.transform!=='none'||style.perspective!=='none'||style.filter!=='none'||style.clipPath!=='none'||!['auto',''].includes(style.clip)||zoom&&zoom!=='1'&&zoom!=='normal')return {...result,error:'IMAGE_GEOMETRY_UNSUPPORTED'};
            if(node!==element){const ancestor=node.getBoundingClientRect(),left=ancestor.left+node.clientLeft,top=ancestor.top+node.clientTop;
                if(['hidden','clip','auto','scroll'].includes(style.overflowX)&&(rect.left<left-0.01||rect.right>left+node.clientWidth+0.01)||['hidden','clip','auto','scroll'].includes(style.overflowY)&&(rect.top<top-0.01||rect.bottom>top+node.clientHeight+0.01))return {...result,error:'IMAGE_TARGET_CLIPPED'};}
        }
        if(rect.x<0||rect.y<0||rect.right>innerWidth||rect.bottom>innerHeight)return {...result,error:'IMAGE_TARGET_OFFSCREEN'};
        return result;
    };
}
