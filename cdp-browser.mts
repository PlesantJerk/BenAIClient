import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fork, execFileSync } from 'node:child_process';
import type { ChildProcess, ForkOptions, CommonSpawnOptions } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { chromium } from 'playwright-core';
import type { Browser, BrowserServer, BrowserContext, Page, Frame } from 'playwright-core';
import { CdpContractError, CdpContract } from './cdp-contract.mts';
import type { CdpContext, CdpJsonObject } from './cdp-contract.mts';
import type { CdpPrivateDirectoryPolicy } from './cdp-private-directory.mts';
import { CdpPng } from './cdp-artifacts.mts';
import { CdpTargets } from './cdp-targets.mts';
import {CdpEvents} from './cdp-events.mts';
import {CdpWatches} from './cdp-watches.mts';
import type {CdpStore} from './cdp-store.mts';
import type {CdpPreparedOperation} from './cdp-interactions.mts';
import {CdpPageLifecycle} from './cdp-lifecycle.mts';
import {CdpDialogs} from './cdp-dialogs.mts';
import type {CdpDialogDescription} from './cdp-dialogs.mts';
import {CdpNetworkRecorder} from './cdp-network.mts';
import type {CdpNetworkEvent,CdpNetworkOptions} from './cdp-network.mts';
import type {CdpDialogControlMetadata} from './cdp-store.mts';
import {CdpFiles} from './cdp-files.mts';
import {CdpEvaluator} from './cdp-evaluate.mts';
import type {CdpEvaluateProgress} from './cdp-evaluate.mts';
import {CdpViewport} from './cdp-viewport.mts';
import {CdpReload} from './cdp-reload.mts';
import {CdpImageTarget} from './cdp-image-target.mts';
import {CdpSessionDownloads} from './cdp-download-capture.mts';
import type {CdpArtifacts} from './cdp-artifacts.mts';
import {CdpFrames,CdpFramesError} from './cdp-frames.mts';
import type {CdpFrameSelection} from './cdp-frames.mts';
import {CdpPageObservation} from './cdp-page-observation.mts';

export interface CdpBrowserSettings {
    readonly executablePath: string;
    readonly privatePolicy: CdpPrivateDirectoryPolicy;
    readonly fixtureOrigin?: string;
    readonly virtualRoot?:string;
}
export interface CdpOwnedCleanup { readonly browserExited: boolean; readonly hostExited: boolean; readonly generatedProfileRemoved: boolean; readonly privateTemporaryRootRemoved: boolean; }

// Separate owned Node host gives Playwright a private TEMP/TMP without mutating global environment.
// Public BrowserServer.process() and its public spawnargs prove only resources created by this host.
class CdpBrowserHost {
    #server: BrowserServer | null = null;
    #launch: Promise<BrowserServer> | null = null;
    #closing = false;
    #launchAttempted=false;
    #temporaryRoot:string|null=null;
    static run(): void {
        const host = new CdpBrowserHost();
        process.on('message', message => { void host.#message(message).catch(error => host.#failure(error)); });
        process.on('disconnect', () => { void host.#close().catch(() => { process.exitCode = 1; }); });
    }
    async #message(value: any): Promise<void> {
        if (value?.kind === 'launch' && !this.#launch && !this.#closing) {
            this.#launchAttempted=true;this.#temporaryRoot=value.temporaryRoot;
            this.#launch = chromium.launchServer({ executablePath:value.executablePath, host:'127.0.0.1',port:0,headless:true,timeout:value.timeoutMs });
            this.#server = await this.#launch;
            const child = this.#server.process();
            if (!child?.pid) throw new Error('No owned process');
            const profile = child.spawnargs.find(argument => argument.startsWith('--user-data-dir='))?.slice('--user-data-dir='.length);
            if (!profile || !CdpBrowserSession.isWithin(value.temporaryRoot,profile)) throw new Error('No private owned profile');
            const proof = {hostPid:process.pid,browserPid:child.pid,profileLeaf:path.basename(profile),observedAtUtc:new Date().toISOString()};
            const descriptor = fs.openSync(path.join(value.temporaryRoot,'owned-process.json'),'wx',0o600);
            try { fs.writeFileSync(descriptor,JSON.stringify(proof)); fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
            if (this.#closing) { await this.#close(); return; }
            this.#send({kind:'ready',endpoint:this.#server.wsEndpoint(),browserPid:child.pid,profile});
        } else if (value?.kind === 'close') await this.#close();
    }
    async #close(): Promise<void> {
        if (this.#closing && !this.#launch) return;
        this.#closing = true;
        if (this.#launch) this.#server = await this.#launch.catch(() => null);
        const child = this.#server?.process();
        await this.#server?.close();
        this.#launch = null;
        this.#send({kind:'closed',browserExited:child ? child.exitCode !== null || child.signalCode !== null : !this.#launchAttempted});
        if (process.connected) process.disconnect();
    }
    #failure(error:unknown):void {
        const message=error instanceof Error?error.message:'';
        const code=/ENAMETOOLONG|filename.*too long|path.*too long/i.test(message)?'BROWSER_STARTUP_PATH_LIMIT':/EACCES|EPERM|Access.*denied/i.test(message)?'BROWSER_STARTUP_ACCESS_DENIED':'BROWSER_HOST_FAILURE';
        if(this.#temporaryRoot) {
            try {
                const file=fs.openSync(path.join(this.#temporaryRoot,'owned-startup-failure.json'),'wx',0o600);
                try {fs.writeFileSync(file,JSON.stringify({hostPid:process.pid,errorCode:code,launchAttempted:this.#launchAttempted,publicBrowserProofAvailable:!!this.#server,observedAtUtc:new Date().toISOString()}));fs.fsyncSync(file);}finally{fs.closeSync(file);}
            } catch { /* Diagnostic failure never changes dispatch/cleanup proof or exposes provider text. */ }
        }
        this.#send({kind:'failure',code});
    }
    #send(value: object): void { if (process.connected) process.send?.(value); }
}

export class CdpBrowserPage {
    readonly id = randomUUID();
    readonly #page: Page;
    readonly #owner:CdpBrowserSession|null;
    #eventCommitted=false;
    readonly frames:CdpFrames;
    readonly #observation:CdpPageObservation;
    #mainId:string;
    #inventory:CdpJsonObject={url:null,title:null,openerPageId:null,metadataState:'not-read'};
    #metadataWork:Promise<void>|null=null;
    #initialized=false;
    #initializationError:string|null=null;
    readonly automaticallyOpened:boolean;
    readonly #targets:CdpTargets;
    #inputReservation:string|null=null;
    readonly lifecycle:CdpPageLifecycle;
    readonly #listeners:{event:string;listener:(...args:any[])=>void}[]=[];
    #pageObservationCleanup:CdpJsonObject|null=null;
    readonly dialogs:CdpDialogs;
    readonly files:CdpFiles;
    #evaluator:CdpEvaluator|null=null;
    #predicateWork:Promise<CdpJsonObject>|null=null;
    #predicateWatchId:string|null=null;
    #predicateStartedAtUtc:string|null=null;
    #predicatePollStarts=0;
    #viewport:CdpViewport|null=null;
    #reload:CdpReload|null=null;
    #network:CdpNetworkRecorder|null=null;
    #mechanicalOrigin:{callId:string;actionId:string;documentId:string|null;frameId:string|null}|null=null;
    #dialogReservation:string|null=null;
    #networkCleanup:CdpJsonObject|null=null;
    #networkDisposal:Promise<CdpJsonObject>|null=null;
    constructor(page: Page,owner:CdpBrowserSession,automaticallyOpened=false) {
        this.#page = page;this.#owner=owner;this.dialogs=new CdpDialogs(this);this.files=new CdpFiles(this);this.lifecycle=new CdpPageLifecycle(this,page,owner?.contextDeviceScaleFactor??1);
        this.automaticallyOpened=automaticallyOpened;this.#targets=new CdpTargets(this);this.frames=new CdpFrames(this);this.#observation=new CdpPageObservation(this,owner.id);
        this.#listen('frameattached',frame=>{this.frames.captureAttached(frame);});
        this.#listen('framedetached',frame=>{this.frames.captureDetached(frame);this.#targets.dropFrame(frame);});
        this.#listen('framenavigated',frame=>{this.#targets.noteNavigation(frame);const event=this.frames.captureNavigated(frame);if(frame===page.mainFrame()){this.#mainId=event.frameId??this.#mainId;this.#owner?.events.capture(this,'navigation',{url:frame.url()});}void this.refreshInventory().catch(()=>{});});
        this.#listen('close',()=>this.frames.capturePageClosed());
        this.frames.seed();this.#mainId=this.frames.mainFrameId();
        // Sole listener: frozen helper owns exact handle identity; never default-dismiss.
        this.#listen('dialog',dialog => {const origin=this.#mechanicalOrigin;const captured=this.dialogs.capture(dialog,{originState:origin?'inFlight':this.#predicateWork?'unknown':'idle',originCallId:origin?.callId??null,originActionId:origin?.actionId??null,documentId:origin?.documentId??null,frameId:origin?.frameId??null});if(captured.isNew)this.#owner?.events.capture(this,'dialog',{...captured.dialog,dialogType:captured.dialog.type,causation:'observed mechanical overlap only; cause not verified'} as unknown as CdpJsonObject,captured.dialog.capturedAtUtc,{frameId:captured.dialog.frameId,documentId:captured.dialog.documentId});});
        this.#listen('filechooser',chooser=>{const origin=this.#mechanicalOrigin;const captured=this.files.captureChooser(chooser,{originState:origin?'inFlight':this.#predicateWork?'unknown':'idle',originCallId:origin?.callId??null,originActionId:origin?.actionId??null,documentId:origin?.documentId??null,frameId:origin?.frameId??null});if(captured.isNew)this.#owner?.events.capture(this,'fileChooser',{...captured.chooser,fileChooserId:captured.chooser.chooserId} as unknown as CdpJsonObject,captured.chooser.capturedAtUtc,{frameId:captured.chooser.frameId??null,documentId:captured.chooser.documentId??null});});
        this.#owner?.events.attach(this,page);
    }
    get page():Page{return this.#page;}
    get pageId():string{return this.id;}
    async initializeNetwork():Promise<void>{
        if(this.#network)throw new CdpContractError('INVALID_TRANSITION','Network recorder is already initialized.');
        this.#network=await CdpNetworkRecorder.create(this);this.#viewport=await CdpViewport.create(this,{maxPngBytes:8388608,maxJpegBytes:8388608});
        this.#evaluator=await CdpEvaluator.create(this);await this.resolveFrame(null);
        this.#reload=await CdpReload.create(this,this.#owner.cacheMode);
        // Explicit initial configuration behind the resource-creation barrier, not screenshot drift repair.
        await this.#viewport.resize({pageId:this.id,...this.#owner.initialViewport});
        await this.refreshInventory();this.#initialized=true;
    }
    get reload():CdpReload{if(!this.#reload)throw new CdpContractError('PAGE_INITIALIZING','Owned reload helper is unavailable.');return this.#reload;}
    get cacheMode():'general'|'fixture-guarded'{return this.#owner.cacheMode;}
    get targets():CdpTargets{return this.#targets;}
    get documentKey():string{return this.#targets.documentKey;}
    getDocumentId():string|null;
    getDocumentId(frame:Frame):Promise<string|null>;
    getDocumentId(frame?:Frame):string|null|Promise<string|null>{return frame?this.#targets.documentProof(frame).then(proof=>proof.documentId):this.#targets.cachedDocument(this.#page.mainFrame());}
    async resolveFrame(frameId:string|null):Promise<CdpFrameSelection>{return this.frames.resolve({pageId:this.id,frameId});}
    redactObservation(value:any):any{return this.#owner?.redact(value)??value;}
    setInitializationError(code:string):void{this.#initializationError=code;}
    async refreshInventory():Promise<CdpJsonObject>{
        if(!this.#metadataWork){this.#metadataWork=this.#refreshInventoryOnce().finally(()=>{this.#metadataWork=null;});}
        let timer:NodeJS.Timeout|undefined;try{await Promise.race([this.#metadataWork,new Promise<void>(resolve=>{timer=setTimeout(resolve,75);})]);}finally{if(timer)clearTimeout(timer);}return this.describe();
    }
    async #refreshInventoryOnce():Promise<void>{
        const opener=await this.#page.opener();let title=this.#inventory.title??null,metadataState='retained-closed';
        if(!this.closed&&!this.dialogs.describeActive()){try{title=(await this.#page.title()).slice(0,2048);metadataState='observed';}catch{metadataState='title-unavailable';}}
        else if(!this.closed)metadataState='retained-dialog-blocked';
        this.#inventory={url:this.#page.url().slice(0,2048),title,openerPageId:opener?this.#owner?.pages().find(page=>page.owns(opener))?.id??null:null,metadataState,metadataObservedAtUtc:new Date().toISOString()};
    }
    get viewport():CdpViewport{if(!this.#viewport)throw new CdpContractError('VIEWPORT_UNAVAILABLE','No owning viewport helper exists.');return this.#viewport;}
    async prepareEvaluation(frameId:string|null):Promise<{selection:CdpFrameSelection;documentKey:string}>{this.#assertLive();this.#assertNoPredicate();const selection=await this.resolveFrame(frameId);this.#assertNoPredicate();return {selection,documentKey:this.documentKey};}
    #assertNoPredicate():void{if(this.#predicateWork)throw new CdpContractError('PAGE_PREDICATE_PENDING','A real observational predicate promise is still pending; no caller-deadline cancellation is implied.');}
    evaluate(args:any,target:{selection:CdpFrameSelection;documentKey:string},progress?:CdpEvaluateProgress):Promise<any>{this.#assertLive();if(!this.#evaluator)throw new CdpContractError('EVALUATE_UNAVAILABLE','No owning evaluator exists.');return this.#evaluator.evaluate({pageId:this.id,script:args.script,arguments:args.arguments,frameId:args.frameId,maxResultChars:args.maxResultChars},target,progress);}
    async prepareFiles(args:any,paths:string[]):Promise<{selection:any;target:any|null;documentId:string;frameId:string}> {
        this.#assertLive();if(args.options.timeoutMs!==this.files.limits.timeoutMs)throw new CdpContractError('FILE_TIMEOUT_UNSUPPORTED','This native file helper supports its declared 10000ms timeout only; no supplied timeout is silently ignored.');
        const frameSelection=await this.resolveFrame(null),documentId=frameSelection.describe().documentId!,frameId=frameSelection.describe().frameId;
        if(args.target?.frameId&&args.target.frameId!==frameId)throw new CdpContractError('FILE_FRAME_UNSUPPORTED','File helper remains exact main-frame only; no fallback.');
        if(args.options.expectedDocumentId!==null&&args.options.expectedDocumentId!==documentId)throw new CdpContractError('STALE_DOCUMENT','File target belongs to another document.');
        const reference=args.target===null?null:await this.#targets.resolve(args.target);let selection:any=null;
        try{
            selection=reference?await this.files.prepareElement(reference.handle,paths):await this.files.prepareChooser(args.fileChooserId,paths);
            if(reference)await this.#targets.assertReference(reference);
            await frameSelection.assertCurrent();
            return {selection,target:reference?.identity??null,documentId,frameId};
        }catch(error){if(selection)this.files.discardPrepared(selection.selectionId);throw error;}
    }
    captureNetworkEvent(event:CdpNetworkEvent):void{this.#owner?.events.captureNetwork(this,event);}
    getNetworkExchange(id:string,options:CdpNetworkOptions):Promise<Readonly<Record<string,unknown>>>{if(!this.#network)throw new CdpContractError('NETWORK_CAPTURE_UNAVAILABLE','No retained native recorder exists; none was created or replayed.');return this.#network.getExchange(id,options);}
    disposeNetwork():Promise<CdpJsonObject>{if(!this.#networkDisposal)this.#networkDisposal=this.#disposeNetworkOnce();return this.#networkDisposal;}
    async #disposeNetworkOnce():Promise<CdpJsonObject>{if(!this.#network)return this.#networkCleanup={noRecorder:true};const proof=await this.#network.dispose() as CdpJsonObject;if(proof.detached!==true)throw new CdpContractError('NETWORK_DETACH_UNCERTAIN','Owned recorder detachment is not verified.');if(this.#predicateWork)await this.#predicateWork.catch(()=>{});await this.#evaluator?.dispose();const pendingReload=this.#reload?.pendingCompletion();if(pendingReload)await pendingReload.catch(()=>{});const reload=await this.#reload?.dispose();const viewport=await this.#viewport?.dispose();return this.#networkCleanup={...proof,evaluatorDisposed:true,reload:reload as unknown as CdpJsonObject??null,viewport:viewport as unknown as CdpJsonObject??null};}
    beginMechanicalInput(callId:string,actionId:string,documentId:string|null,frameId:string|null):()=>void{const origin={callId,actionId,documentId,frameId};this.#mechanicalOrigin=origin;return()=>{if(this.#mechanicalOrigin===origin)this.#mechanicalOrigin=null;};}
    assertDialogControl(sessionId:string,pageId:string,dialogId:string):CdpDialogControlMetadata{
        const current=this.dialogs.describeActive();if(this.closed||this.#owner?.id!==sessionId||this.id!==pageId||!current||current.dialogId!==dialogId||current.state!=='pending')throw new CdpContractError('DIALOG_NOT_CURRENT','Only the exact current pending native dialog on the owned page may cross an input fence.');
        return {dialogId:current.dialogId,pageId:this.id,originCallId:current.originCallId,originActionId:current.originActionId};
    }
    reserveDialog(dialogId:string,accept:boolean,promptText:string|null):()=>void{
        this.assertDialogControl(this.#owner!.id,this.id,dialogId);const current=this.dialogs.describeActive()!;
        if(promptText!==null&&(!accept||current.type!=='prompt'))throw new CdpContractError('DIALOG_PROMPT_UNSUPPORTED','PromptText is valid only when accepting a prompt.');
        if(this.#dialogReservation)throw new CdpContractError('DIALOG_BUSY','Exact dialog resolution is already in preparation.');const token=randomUUID();this.#dialogReservation=token;return()=>{if(this.#dialogReservation===token)this.#dialogReservation=null;};
    }
    resolveDialog(id:string,accept:boolean,promptText:string|null):Promise<CdpDialogDescription>{return this.dialogs.resolve(id,accept,promptText);}
    #listen(event:string,listener:(...args:any[])=>void):void{this.#listeners.push({event,listener});this.#page.on(event as any,listener);}
    invalidateDocument():void{this.#targets.noteNavigation(this.#page.mainFrame());}
    disposePageObservation():CdpJsonObject{
        if(!this.#pageObservationCleanup){if(this.closed){this.dialogs.disposeAfterPageClosed();this.files.disposeAfterPageClosed();}const watches=this.#owner?.watches.closePage(this.id)??{};const events=this.#owner?.events.disposePage(this)??{};for(const {event,listener}of this.#listeners)this.#page.off(event as any,listener);this.#listeners.length=0;this.#observation.dispose();this.frames.dispose();this.#targets.invalidate();this.#pageObservationCleanup={watches,events,pageListenersDisposed:true,inputCancellationClaimed:false};}return this.#pageObservationCleanup;
    }
    get mainFrameId():string{return this.#mainId;}
    get eventCommitted():boolean{return this.#eventCommitted;}
    commitEvents():void{this.#eventCommitted=true;this.#owner?.events.commit(this);}
    inspect(args:any):Promise<CdpJsonObject>{this.#assertLive();return this.#targets.inspect(args.target,args.options);}
    async checkCondition(condition:any,expectedDocumentId?:string,watchId?:string):Promise<CdpJsonObject>{
        this.#assertLive();
        if(condition.kind==='element'||condition.kind==='text'){const result=await this.#targets.condition(condition);if(expectedDocumentId&&result.documentId!==expectedDocumentId)throw new CdpContractError('STALE_DOCUMENT','Readiness document changed after the watch scope check.');return result;}
        if(condition.kind==='predicate')return this.#pollPredicate(condition,expectedDocumentId!,watchId!);
        const documentId=(await this.#targets.documentProof(this.#page.mainFrame())).documentId;
        if(condition.kind==='url')return {satisfied:CdpWatches.matches(this.#page.url(),condition.match),kind:'url',documentId,frameId:this.mainFrameId,observedAtUtc:new Date().toISOString()};
        const state=await this.#page.evaluate(()=>document.readyState);
        if(documentId!==(await this.#targets.documentProof(this.#page.mainFrame())).documentId)throw new CdpContractError('STALE_DOCUMENT','Document changed while reading readiness.');
        return {satisfied:condition.state==='load'?state==='complete':state==='interactive'||state==='complete',kind:'load',state:condition.state,documentId,frameId:this.mainFrameId,observedAtUtc:new Date().toISOString()};
    }
    predicateState(watchId?:string):CdpJsonObject{return {pending:!!this.#predicateWork,watchId:this.#predicateWatchId,requestedWatchOwnsPending:watchId?this.#predicateWatchId===watchId:null,startedAtUtc:this.#predicateStartedAtUtc,pollStarts:this.#predicatePollStarts,observedAtUtc:new Date().toISOString(),applicationCancellationClaimed:false,purityClaimed:false};}
    async #pollPredicate(condition:any,expectedDocumentId:string,watchId:string):Promise<CdpJsonObject>{
        if(!this.#owner?.watches.isLive(watchId))return {satisfied:false,observationStopped:true};
        this.#assertPredicateAvailable();const selection=await this.resolveFrame(condition.frameId);
        if(selection.describe().documentId!==expectedDocumentId)throw new CdpContractError('STALE_DOCUMENT','Predicate is pinned to its exact armed document.');
        await selection.assertCurrent();
        if(!this.#owner.watches.isLive(watchId))return {satisfied:false,observationStopped:true};
        this.#assertPredicateAvailable();
        const pending=this.#evaluator!.evaluate({pageId:this.id,script:condition.expression,arguments:condition.arguments,frameId:condition.frameId,maxResultChars:2048},{selection,documentKey:this.documentKey});
        this.#predicateWatchId=watchId;this.#predicateStartedAtUtc=new Date().toISOString();this.#predicatePollStarts++;
        const work=this.#predicateResult(pending,selection,expectedDocumentId);this.#predicateWork=work;
        try{return await work;}finally{if(this.#predicateWork===work){this.#predicateWork=null;this.#predicateWatchId=null;this.#predicateStartedAtUtc=null;}}
    }
    #assertPredicateAvailable():void{
        if(!this.#evaluator)throw new CdpContractError('PREDICATE_EVALUATOR_UNAVAILABLE','No owning evaluator exists.');
        const state=this.#evaluator.describe() as {pending:number};
        if(this.#predicateWork||state.pending||this.#inputReservation)throw new CdpContractError('CONDITION_EVALUATOR_BUSY','An existing evaluation/input owns this page; no predicate invocation occurred.');
    }
    async #predicateResult(pending:ReturnType<CdpEvaluator['evaluate']>,selection:CdpFrameSelection,documentId:string):Promise<CdpJsonObject>{
        const evaluated=await pending;
        if(evaluated.outcome!=='returned')throw new CdpContractError('PREDICATE_EVALUATION_FAILED','Browser predicate did not produce a successful boolean result; effects may have occurred.');
        if(evaluated.result?.state!=='projected'||evaluated.result.serialization.truncated||typeof evaluated.result.value!=='boolean')throw new CdpContractError('PREDICATE_RESULT_INVALID','Predicate must return one nontruncated boolean, not a truthy substitute.');
        await selection.assertCurrent();
        return {satisfied:evaluated.result.value,kind:'predicate',documentId,frameId:selection.describe().frameId,observedAtUtc:new Date().toISOString(),observationalPolling:true,purityClaimed:false,mayHaveSideEffects:true,applicationCancellationClaimed:false};
    }
    get documentId(): string|null { return this.getDocumentId(); }
    owns(page:Page):boolean{return page===this.#page;}
    get closed(): boolean { return this.#page.isClosed(); }
    describe():CdpJsonObject{const dialog=this.dialogs.describeActive();return {pageId:this.id,documentId:this.documentId,documentProof:'last cached Targets proof; null when unavailable',...this.#inventory,available:!this.closed&&this.#initialized,initializationError:this.#initializationError,automaticallyOpened:this.automaticallyOpened,earlyNetworkCoverage:this.automaticallyOpened?'partial; capture began after public context page event':'registered before application navigation',pendingDialog:dialog?{...dialog}:null,predicateExecution:this.predicateState(),network:this.#network?.describe() as CdpJsonObject??null,mainFrameId:this.mainFrameId,elementHandleDisposalFailures:this.#targets.disposalFailures};}
    async navigate(args:any):Promise<CdpJsonObject> {
        this.#assertLive();
        // Native failure remains uncertain. Never replay navigation to recover a later observation.
        await this.#page.goto(args.url,{waitUntil:args.waitUntil,timeout:args.timeoutMs});
        const outcome:CdpJsonObject={navigationFinished:true,inputMechanicsOnly:true,businessSuccessVerified:false,documentId:null};
        return outcome;
    }
    async observeAfterNavigation():Promise<CdpJsonObject> {
        const outcome:CdpJsonObject={documentId:null};let stage='document';
        try {
            const descriptor=(await this.resolveFrame(null)).describe();stage='inventory';
            const inventory=await this.refreshInventory();outcome.documentId=descriptor.documentId;
            outcome.postNavigationObservation={state:descriptor.documentId===null?'unavailable':'available',errorCode:descriptor.documentError,inventoryState:inventory.metadataState??null};
        } catch(error) {
            const errorCode=error instanceof CdpFramesError||error instanceof CdpContractError?error.code:'POST_NAVIGATION_OBSERVATION_FAILED';
            outcome.postNavigationObservation={state:'unavailable',failedStage:stage,errorCode};
        }
        return outcome;
    }
    observe(args:any,access:'owner'|'parentInspect'='owner'):Promise<CdpJsonObject>{if(args.options.cursor===null)this.#assertLive();return this.#observation.read(args,access);}
    async screenshot(args:any):Promise<{bytes:Buffer;metadata:any}> {
        this.#assertLive();const options=args.options;
        const target=options.target===null?null:await CdpImageTarget.prepare(this,options.target);
        const captured=await this.viewport.capture({pageId:this.id,format:options.format,jpegQuality:options.jpegQuality,fullPage:options.fullPage,clip:target?.clip??options.clip,maxDimension:options.maxDimension,target:null,frameId:null});
        const targetProof=target?await target.verify():null;
        return {bytes:captured.bytes,metadata:{...captured.metadata,target:targetProof,selectedDocumentId:target?.documentId??this.documentId}};
    }
    reserveInput(allowClosed=false):()=>void {
        if(!allowClosed||!this.closed)this.#assertLive();
        if(this.dialogs.describeActive()&&!this.closed)throw new CdpContractError('DIALOG_PENDING','A native dialog blocks unrelated input. Resolve the exact DialogId with a new journaled HandleDialog action.');
        if(this.#inputReservation)throw new CdpContractError('PAGE_BUSY','Input preparation or dispatch already owns this page.');
        const reservation=randomUUID();this.#inputReservation=reservation;
        return ()=>{if(this.#inputReservation===reservation)this.#inputReservation=null;};
    }
    prepareInput(operation:string,args:any):Promise<CdpPreparedOperation> {this.#assertLive();return this.#targets.prepare(operation,args);}
    #assertLive(): void { if (this.closed) throw new CdpContractError('PAGE_UNAVAILABLE', 'Owned page is no longer available.');if(!this.#initialized)throw new CdpContractError('PAGE_INITIALIZING','Owned page has not completed helper initialization.'); }

}

export class CdpBrowserSession {
    readonly id = randomUUID();
    readonly owner: CdpContext;
    readonly #settings: CdpBrowserSettings;
    readonly #options: any;
    readonly #pages = new Map<string,CdpBrowserPage>();
    #events:CdpEvents|null=null;
    #artifacts:CdpArtifacts|null=null;
    #downloads:CdpSessionDownloads|null=null;
    #watches:CdpWatches|null=null;
    #observationCleanup:CdpJsonObject|null=null;
    #host: ChildProcess | null = null;
    #browser: Browser | null = null;
    #context: BrowserContext | null = null;
    #temporaryRoot: string | null = null;
    #profile: string | null = null;
    #browserPid: number | null = null;
    #closed = false;
    #closedPopups = 0;
    #store:CdpStore|null=null;
    readonly #explicitNative=new WeakSet<Page>();
    readonly #nativePages=new WeakMap<Page,CdpBrowserPage>();
    readonly #pendingNative=new Set<Page>();
    #explicitCreating=false;
    #creationChain:Promise<void>=Promise.resolve();
    #observedWork:Promise<void>|null=null;
    readonly #sensitiveValues=new Set<string>();
    #sensitiveInput=false;
    #popupCleanupFailures = 0;
    #cleanup: CdpOwnedCleanup | null = null;
    #waiters = new Map<string,{resolve:(value:any)=>void;reject:(reason:Error)=>void;timer:NodeJS.Timeout}>();
    constructor(owner: CdpContext, options: any, settings: CdpBrowserSettings) {
        this.owner = CdpContract.context(owner); this.#options = options; this.#settings = settings;
    }
    initializeObservation(store:CdpStore,artifacts:CdpArtifacts):void{this.#store=store;this.#artifacts=artifacts;if(this.#events)throw new CdpContractError('INVALID_TRANSITION','Observation source is already initialized.');this.#events=new CdpEvents(this,store);this.#watches=new CdpWatches(this,store);}
    get events():CdpEvents{if(!this.#events)throw new CdpContractError('EVENT_CAPTURE_UNAVAILABLE','Durable owned session is not initialized.');return this.#events;}
    get watches():CdpWatches{if(!this.#watches)throw new CdpContractError('WATCH_UNAVAILABLE','Durable owned session is not initialized.');return this.#watches;}
    beginCleanupObservations():void{this.#watches?.close();}
    disposeObservation():CdpJsonObject{if(!this.#observationCleanup){const watches=this.#watches?.close()??{subscriptionsDisposed:true};const events=this.#events?.dispose()??{listenersDisposed:true};this.#observationCleanup={watches,events,inputCancellationClaimed:false};}return this.#observationCleanup;}
    get version(): string | null { return this.#browser?.version() ?? null; }
    get cleanupEvidence(): CdpOwnedCleanup | null { return this.#cleanup; }
    static libraryVersion(): string { return createRequire(import.meta.url)('playwright-core/package.json').version; }
    static executableVersion(executable: string): string | null {
        if (process.platform !== 'win32') return null;
        const script = `[Console]::Write((Get-Item -LiteralPath '${executable.replaceAll("'","''")}').VersionInfo.FileVersion)`;
        try { return execFileSync('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{encoding:'utf8',timeout:10000,windowsHide:true,maxBuffer:4096,stdio:['ignore','pipe','pipe']}).trim(); }
        catch { return null; }
    }
    async launch(): Promise<void> {
        if (this.#options.headless !== true) throw new CdpContractError('HEADFUL_UNSUPPORTED', 'Only explicitly isolated headless sessions are supported.');
        if (process.platform !== 'win32') throw new CdpContractError('BROWSER_PLATFORM_UNVERIFIED', 'This slice has not been validated on this platform.');
        this.#temporaryRoot = this.#settings.privatePolicy.createChild('browser-' + this.id);
        // Installed Node24 fork forwards these public spawn options unchanged (owned compatibility probe).
        const options:ForkOptions & Pick<CommonSpawnOptions,'windowsHide'>={execArgv:[],env:{...process.env,TEMP:this.#temporaryRoot,TMP:this.#temporaryRoot,PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD:'1'},stdio:['ignore','ignore','ignore','ipc'],windowsHide:true};
        this.#host = fork(fileURLToPath(import.meta.url),['--cdp-owned-host'],options);
        this.#host.on('message',message => this.#receive(message));
        this.#host.on('error',() => this.#rejectWaiters('BROWSER_HOST_UNAVAILABLE'));
        this.#host.on('exit',() => this.#rejectWaiters('BROWSER_HOST_EXITED'));
        const waiting = this.#wait('ready',this.#options.startupTimeoutMs + 5000);
        this.#host.send({kind:'launch',executablePath:this.#settings.executablePath,temporaryRoot:this.#temporaryRoot,timeoutMs:this.#options.startupTimeoutMs});
        const ready = await waiting;
        this.#profile = ready.profile; this.#browserPid = ready.browserPid;
        this.#browser = await chromium.connect(ready.endpoint,{timeout:this.#options.startupTimeoutMs});
        this.#context = await this.#browser.newContext({ viewport:{width:this.#options.viewport.width,height:this.#options.viewport.height},deviceScaleFactor:this.#options.viewport.deviceScaleFactor,
            locale:this.#options.locale ?? undefined,timezoneId:this.#options.timezoneId ?? undefined,acceptDownloads:this.downloadPolicy==='capture',serviceWorkers:'block' });
        if(this.#settings.fixtureOrigin)await this.#context.route('**/*',async route => {
            if (this.permitsUrl(route.request().url())) await route.continue(); else await route.abort('blockedbyclient');
        });
        this.#context.on('page',page=>{if(this.#explicitNative.has(page)||this.#nativePages.has(page))return;this.#pendingNative.add(page);if(!this.#explicitCreating)this.#scheduleObserved();});
    }
    get browser():Browser{if(!this.#browser)throw new CdpContractError('SESSION_UNAVAILABLE','Owned browser is unavailable.');return this.#browser;}
    get context():BrowserContext{if(!this.#context)throw new CdpContractError('SESSION_UNAVAILABLE','Owned context is unavailable.');return this.#context;}
    initializeFreshDownloadChild(parent:string,child:string,createdAfterMs:number):void {
        if(path.basename(parent)!=='transfers-'+this.id)throw new CdpContractError('UNSAFE_STORAGE_PATH','Download staging parent is not the exact owned session.');
        this.#settings.privatePolicy.initializeFreshDownloadChild(parent,child,createdAfterMs);
    }
    get downloadPolicy():'capture'|'deny'{return this.#options.downloadPolicy;}
    get maximumDownloadBytes():number{return this.#options.maxDownloadMiB*1048576;}
    get contextDeviceScaleFactor():number{return this.#options.viewport.deviceScaleFactor;}
    get initialViewport():{width:number;height:number;deviceScaleFactor:number}{return {...this.#options.viewport};}
    get cacheMode():'general'|'fixture-guarded'{return this.#settings.fixtureOrigin?'fixture-guarded':'general';}
    noteSensitive(value:string):void {
        this.#sensitiveInput=true;
        if(value.length&&this.#sensitiveValues.size<100)this.#sensitiveValues.add(value);
        // Best-effort bounded text redaction is not an input or screenshot prerequisite.
    }
    redact(value:any):any {
        // Functionality-first: opaque identities/state must never be rewritten by typed literals.
        // Password DOM values are omitted at capture; diagnostic ON/OFF policy is separate.
        return value;
    }
    permitsUrl(url: string): boolean {
        try {
            if (url === 'about:blank') return true;
            const parsed = new URL(url);
            if (!['http:','https:'].includes(parsed.protocol) || parsed.username || parsed.password) return false;
            return this.#settings.fixtureOrigin === undefined || parsed.origin === this.#settings.fixtureOrigin;
        } catch { return false; }
    }
    createPage():Promise<CdpBrowserPage>{
        const work=this.#creationChain.then(()=>this.#createExplicit());this.#creationChain=work.then(()=>{},()=>{});return work;
    }
    async #createExplicit():Promise<CdpBrowserPage>{
        if(!this.#context||this.#closed)throw new CdpContractError('SESSION_UNAVAILABLE','Owned context unavailable.');this.#explicitCreating=true;
        try{const native=await this.#context.newPage();this.#explicitNative.add(native);this.#pendingNative.delete(native);const page=new CdpBrowserPage(native,this);this.#nativePages.set(native,page);this.#pages.set(page.id,page);await this.#initializePage(page);return page;}
        finally{this.#explicitCreating=false;this.#scheduleObserved();}
    }
    async #initializePage(page:CdpBrowserPage):Promise<void>{
        await page.initializeNetwork();if(!this.#downloads){if(!this.#artifacts)throw new CdpContractError('ARTIFACT_OWNER_UNAVAILABLE','Download owner unavailable.');this.#downloads=await CdpSessionDownloads.create(this,page,this.#artifacts,this.#settings.privatePolicy.createChild('transfers-'+this.id));}
        else await this.#downloads.registerPage(page);
    }
    #scheduleObserved():void{
        if(this.#observedWork||this.#explicitCreating||!this.#pendingNative.size)return;
        this.#observedWork=this.#drainObserved().finally(()=>{this.#observedWork=null;if(this.#pendingNative.size)this.#scheduleObserved();});
    }
    async #drainObserved():Promise<void>{
        while(this.#pendingNative.size){const native=this.#pendingNative.values().next().value!;this.#pendingNative.delete(native);if(this.#explicitNative.has(native)||this.#nativePages.has(native))continue;
            if(native.context()!==this.#context){this.#popupCleanupFailures++;continue;}
            if(native.isClosed()){this.#closedPopups++;continue;}let page:CdpBrowserPage|null=null;
            try{page=new CdpBrowserPage(native,this,true);this.#nativePages.set(native,page);this.#pages.set(page.id,page);if(this.#closed||!this.#store)throw new CdpContractError('SESSION_UNAVAILABLE','Session is closing or unavailable.');this.#store.admitObservedPage(this.id,page.id,this.owner);await this.#initializePage(page);await page.refreshInventory();page.commitEvents();}
            catch(error){page?.setInitializationError(error instanceof CdpContractError?error.code:'POPUP_INITIALIZATION_FAILED');try{await native.close();if(native.isClosed()){this.#closedPopups++;page?.disposePageObservation();}}catch{this.#popupCleanupFailures++;}}
        }
    }
    async refreshInventory():Promise<void>{for(const page of this.#pages.values())await page.refreshInventory();}
    page(id: string): CdpBrowserPage { const page = this.#pages.get(id); if (!page) throw new CdpContractError('PAGE_UNAVAILABLE', 'Page is not in the owned browser session.'); return page; }
    pages(): readonly CdpBrowserPage[] { return [...this.#pages.values()]; }
    describe(): CdpJsonObject { return {sessionId:this.id,available:!this.#closed && !!this.#context,browserVersion:this.version,headless:true,restartReattach:false,effectiveOptions:this.#options as CdpJsonObject,artifactLocation:{spaceId:'virtual',access:'ReadArtifact by retained ArtifactId',privateDurableStorage:true},redactLogs:this.#options.redactLogs !== false,downloadPolicy:this.downloadPolicy,downloads:this.#downloads?.describe()??null,closedPopups:this.#closedPopups,popupCleanupFailures:this.#popupCleanupFailures}; }
    async close(): Promise<CdpOwnedCleanup> {
        if (this.#cleanup) { this.#assertCleanupVerified(this.#cleanup); return this.#cleanup; }
        let downloadAdmission:CdpJsonObject|null=null;
        try{downloadAdmission=await this.#downloads?.flushCompleted()??null;}catch(error){downloadAdmission={complete:false,errorCode:error&&typeof error==='object'&&'code'in error?String(error.code).slice(0,80):'DOWNLOAD_FLUSH_UNAVAILABLE',mitigation:'close exact owned browser; do not replay or claim admission'};}
        this.#closed = true;
        // Ask the owning host to close its public BrowserServer first. A client context/disconnect is not process proof.
        let browserExited = this.#host === null;
        if (this.#host && this.#host.exitCode === null && this.#host.signalCode === null) {
            const waiting = this.#wait('closed',120000); this.#host.send({kind:'close'}); browserExited = (await waiting).browserExited === true;
            await this.#waitHostExit();
        }
        const hostExited = !this.#host || this.#host.exitCode !== null || this.#host.signalCode !== null;
        const generatedProfileRemoved = this.#profile ? !fs.existsSync(this.#profile) : this.#host === null;
        let privateTemporaryRootRemoved = !this.#temporaryRoot;
        if (browserExited && hostExited && generatedProfileRemoved && this.#temporaryRoot) {
            this.#settings.privatePolicy.assertPrivateDirectory(this.#temporaryRoot);
            fs.rmSync(this.#temporaryRoot,{recursive:true}); privateTemporaryRootRemoved = !fs.existsSync(this.#temporaryRoot);
        }
        // Completed downloads admitted before TEMP cleanup; native disposal only after owning browser closure.
        await this.#observedWork;const downloadCleanup=await this.#downloads?.disposeAfterContextClosed({browserExited,hostExited});this.disposeObservation();
        this.#observationCleanup={...this.#observationCleanup,downloadAdmission:downloadAdmission??null,downloadCleanup:downloadCleanup??null};
        this.#cleanup = Object.freeze({browserExited,hostExited,generatedProfileRemoved,privateTemporaryRootRemoved});
        this.#assertCleanupVerified(this.#cleanup);
        // Owning browser/host exits first. Native detach can be blocked by an unresolved modal.
        const network:CdpJsonObject[]=[];for(const page of this.#pages.values()){try{network.push({pageId:page.id,...await page.disposeNetwork()});}catch{network.push({pageId:page.id,detachVerified:false,errorCode:'NETWORK_DETACH_UNCERTAIN'});}}
        this.#observationCleanup={...this.#observationCleanup,network};
        for(const page of this.#pages.values())if(page.closed)page.disposePageObservation();
        return this.#cleanup;
    }
    #assertCleanupVerified(cleanup: CdpOwnedCleanup): void {
        if (cleanup.browserExited !== true || cleanup.hostExited !== true || cleanup.generatedProfileRemoved !== true || cleanup.privateTemporaryRootRemoved !== true)
            throw new CdpContractError('OWNED_CLEANUP_UNCERTAIN', 'Owned browser cleanup could not be fully verified; no unrelated process was touched.');
    }
    async #waitHostExit(): Promise<void> {
        const host = this.#host;
        if (!host || host.exitCode !== null || host.signalCode !== null) return;
        await new Promise<void>((resolve,reject) => {
            const timer = setTimeout(() => reject(new CdpContractError('OWNED_CLEANUP_UNCERTAIN','Owned host did not exit in time.')),5000);
            host.once('exit',() => { clearTimeout(timer); resolve(); });
        });
    }
    #wait(kind: string, timeoutMs: number): Promise<any> {
        return new Promise((resolve,reject) => {
            const timer = setTimeout(() => { this.#waiters.delete(kind); reject(new CdpContractError('BROWSER_HOST_TIMEOUT','Owned browser host deadline elapsed.')); },timeoutMs);
            this.#waiters.set(kind,{resolve,reject,timer});
        });
    }
    #receive(value: any): void {
        if (value?.kind === 'failure') { this.#rejectWaiters(['BROWSER_STARTUP_PATH_LIMIT','BROWSER_STARTUP_ACCESS_DENIED'].includes(value.code) ? value.code : 'BROWSER_HOST_FAILURE'); return; }
        const pending = this.#waiters.get(value?.kind);
        if (pending) { clearTimeout(pending.timer); this.#waiters.delete(value.kind); pending.resolve(value); }
    }
    #rejectWaiters(code: string): void { for (const waiter of this.#waiters.values()) { clearTimeout(waiter.timer); waiter.reject(new CdpContractError(code,'Owned browser host became unavailable.')); } this.#waiters.clear(); }
    static isWithin(root: string, candidate: string): boolean { const relative = path.relative(root,candidate); return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv[2] === '--cdp-owned-host') CdpBrowserHost.run();
