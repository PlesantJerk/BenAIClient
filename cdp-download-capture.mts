import {randomUUID} from 'node:crypto';
import type {Browser,BrowserContext,Page} from 'playwright-core';
import {CdpDownloads} from './cdp-downloads.mts';
import type {CdpDownloadEvent} from './cdp-downloads.mts';
import type {CdpArtifacts} from './cdp-artifacts.mts';
import type {CdpBrowserPage,CdpBrowserSession} from './cdp-browser.mts';
import type {CdpJsonObject} from './cdp-contract.mts';

// One owner-held authoritative native stream. No second download ID/registry or model file path.
export class CdpSessionDownloads {
    readonly #owner:CdpBrowserSession;
    readonly #artifacts:CdpArtifacts;
    readonly browser:Browser;
    readonly context:BrowserContext;
    readonly anchorPage:Page;
    readonly stagingDirectory:string;
    #helper:CdpDownloads|null=null;
    readonly #jobs=new Map<string,Promise<void>>();
    readonly #admissions=new Map<string,CdpJsonObject>();
    #disposal:Promise<CdpJsonObject>|null=null;
    private constructor(owner:CdpBrowserSession,page:CdpBrowserPage,artifacts:CdpArtifacts,stagingDirectory:string){
        this.#owner=owner;this.#artifacts=artifacts;this.browser=owner.browser;this.context=owner.context;this.anchorPage=page.page;this.stagingDirectory=stagingDirectory;
    }
    static async create(owner:CdpBrowserSession,page:CdpBrowserPage,artifacts:CdpArtifacts,stagingDirectory:string):Promise<CdpSessionDownloads>{
        const capture=new CdpSessionDownloads(owner,page,artifacts,stagingDirectory);
        const createdAfterMs=Date.now();capture.#helper=await CdpDownloads.create(capture,{maxFileBytes:owner.maximumDownloadBytes},owner.downloadPolicy);
        owner.initializeFreshDownloadChild(stagingDirectory,capture.#helper.stagingDirectory,createdAfterMs);
        await capture.registerPage(page);return capture;
    }
    async registerPage(page:CdpBrowserPage):Promise<void>{await this.#helper!.registerPage(page.page,page.id);}
    captureDownloadEvent(event:CdpDownloadEvent):void{
        if(this.#owner.downloadPolicy==='deny'){
            this.#publish(event,event.state==='completed'?{state:'artifactUnavailable',artifactId:null,artifactError:'DENY_POLICY_NATIVE_COMPLETION'}:{});return;
        }
        if(event.state==='completed'){
            if(this.#jobs.has(event.data.downloadId)||this.#admissions.has(event.data.downloadId))return;
            const work=this.#adopt(event).catch(error=>this.#publish(event,{state:'artifactUnavailable',artifactId:null,artifactError:this.#error(error)}));
            this.#jobs.set(event.data.downloadId,work);void work.finally(()=>this.#jobs.delete(event.data.downloadId));
        }else this.#publish(event,{});
    }
    async #adopt(event:CdpDownloadEvent):Promise<void>{
        const file=this.#helper!.completedFile(event.data.downloadId),artifactId=randomUUID();let admitted=false;
        try{
            const result=await this.#artifacts.admitOwnedFile({artifactId,sessionId:this.#owner.id,pageId:event.data.pageId,kind:'download',mime:null,filePath:file.filePath,byteLength:file.sizeBytes,sha256:file.sha256},this.#owner.owner);
            admitted=result.admitted===true;
            if(!admitted)throw new Error('Artifact admission was not verified.');
            if(result.sourceRemoved)this.#helper!.acknowledgeMoved(file.downloadId);else this.#helper!.releaseCompletedFile(file.downloadId);
            const retained={artifactId,admitted:true,fileOwnership:result.sourceRemoved?'adopted':'staged',sourceRemoved:result.sourceRemoved,sourceDisposition:result.sourceDisposition,sourceCleanupError:result.sourceCleanupError??null};
            this.#admissions.set(file.downloadId,retained);this.#publish(event,{state:'completed',...retained,retainedByteGuarantee:'hard artifact admission quota; native transfer may transiently overshoot'});
        }catch(error){if(!admitted)this.#helper!.releaseCompletedFile(file.downloadId);throw error;}
    }
    #publish(event:CdpDownloadEvent,extra:CdpJsonObject):void{
        this.#owner.events.captureDownload({...event.data,...extra,downloadPolicy:this.#owner.downloadPolicy,downloadState:extra.state??event.state,logicalLinkage:'native context/page only; frame/document/request unknown'} as unknown as CdpJsonObject,event.data.updatedAtUtc);
    }
    async flushCompleted():Promise<CdpJsonObject>{
        await this.#helper?.flush();while(this.#jobs.size)await Promise.all([...this.#jobs.values()]);
        return {adopted:this.#admissions.size,helper:this.#helper?.status() as unknown as CdpJsonObject??null};
    }
    describe():CdpJsonObject{return {policy:this.#owner.downloadPolicy,applicationCancellationClaimed:false,helper:this.#helper?.status() as unknown as CdpJsonObject??null,admittedArtifacts:this.#admissions.size,pendingAdmissions:this.#jobs.size,sourceMime:'unknown; not inferred from filename'};}
    disposeAfterContextClosed(shutdown:{browserExited:boolean;hostExited:boolean}):Promise<CdpJsonObject>{this.#disposal??=this.#dispose(shutdown);return this.#disposal;}
    async #dispose(shutdown:{browserExited:boolean;hostExited:boolean}):Promise<CdpJsonObject>{
        while(this.#jobs.size)await Promise.all([...this.#jobs.values()]);
        const proof=await this.#helper?.disposeAfterContextClosed({browser:this.browser,context:this.context,...shutdown});
        return {native:proof as unknown as CdpJsonObject??null,admittedArtifacts:this.#admissions.size};
    }
    #error(error:unknown):string{return error&&typeof error==='object'&&'code'in error?String(error.code).slice(0,80):'DOWNLOAD_ARTIFACT_UNAVAILABLE';}
}
