import * as fs from 'node:fs';
import * as path from 'node:path';
import * as http from 'node:http';
import * as os from 'node:os';
import * as assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import type {CdpOwnedRuntime} from '../cdp-bootstrap.mts';
import type {CdpContext,CdpOperation,CdpWireCommand} from '../cdp-contract.mts';
import type {CdpClientResponse} from '../cdp-client.mts';

// Embedding smoke only. No main/poller, production route/config, downloads or provider delivery.
class CdpMacosSmoke {
    static readonly #runtimeCheckpoint='657ab5622548ddbff3e9bae79dedbcc92ce26be2';
    static readonly #initial=['GetCapabilities','CreateSession','GetSessions','CreatePage','GetPages','CloseSession','GetCall','GetAction','Navigate','Observe','Screenshot','ReadArtifact'];
    static readonly #frozen:Readonly<Record<string,string>>=Object.freeze({
        'cdp-platform.mts':'869c12c7d16e06ac006d0ed36355ed7d3d6c2cc5b954c412b9a845af5ba6504d',
        'cdp-posix-private.mts':'2bce46f8c33f48e6eeedaaa9ef022cc4960ad54888d33f330aca36d09b24b57a',
        'cdp-bootstrap.mts':'34e2037669ec0478a114c306d97b36cb1f4de04e0c51f175bdd67ede8e1a6e8a',
        'cdp-private-directory.mts':'4a470a2e818621c147f9db960709f023e1741b325d49982969262295468d2bc6',
        'cdp-browser.mts':'a16d5fe7faf0dd6beca7487c9680be57195bff0f541388d18241aa6c0eb37342',
        'cdp-client.mts':'0e29d3428fbc8eb9d6b1e716cbd01994b37d455cc2516687fdcb1daeeaf9c5ff'
    });
    readonly #root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
    readonly #scratch:string;
    readonly #expectedCommit:string;
    readonly #runId=randomUUID();
    readonly #route={clientName:'mac-smoke-'+this.#runId,email:'cdp-macos-smoke@invalid.example'};
    readonly #report:Record<string,any>={status:'PREPARING',startedAtUtc:new Date().toISOString(),steps:[],providerImageDelivery:'NOT TESTED',full32Port:'NOT TESTED'};
    #bootstrap!:typeof import('../cdp-bootstrap.mts');
    #contract!:typeof import('../cdp-contract.mts');
    #platform!:typeof import('../cdp-platform.mts');
    #policy!:typeof import('../cdp-private-directory.mts');
    #images!:typeof import('../cdp-artifacts.mts');
    #jpeg!:typeof import('../cdp-image-codec.mts');
    #sqlite!:typeof import('node:sqlite');
    #runtime:CdpOwnedRuntime|null=null;
    #context!:CdpContext;
    #server:http.Server|null=null;
    #installation='';
    #origin='';
    #sessionId:string|null=null;
    #pageId:string|null=null;
    #owned:any=null;
    #active:CdpWireCommand|null=null;
    #uncertain=false;
    #cleanupVerified=false;
    #closeAttempted=false;
    #receiptCount=0;
    #navigationRequests=0;
    #parentEnvironment:Record<string,string|null>={};
    #parentUmask=0;

    constructor(scratch:string,expectedCommit:string){this.#scratch=scratch;this.#expectedCommit=expectedCommit;this.#parentEnvironment=this.#environment();this.#parentUmask=process.umask();}
    static async main():Promise<void>{
        // Before construction, filesystem access, runtime imports, or any browser/HTTP activity.
        if(process.platform!=='darwin'){console.error('NATIVE_MACOS_REQUIRED: this fixture cannot run on Windows or a spoofed platform.');process.exitCode=2;return;}
        if(Number(process.versions.node.split('.')[0])<24){console.error('NODE_24_REQUIRED: use the approved native executable; no install/fallback.');process.exitCode=2;return;}
        const a=process.argv.slice(2);
        if(a.length!==5||a[0]!=='--scratch'||a[2]!=='--expected-checkout-commit'||a[4]!=='--approve-fresh-scratch'){
            console.error('Usage: node tools/cdp-macos-smoke.mts --scratch <fresh absolute AIWork leaf> --expected-checkout-commit <reviewed 40-hex SHA> --approve-fresh-scratch');process.exitCode=2;return;
        }
        try{await new CdpMacosSmoke(a[1],a[3]).#run();}catch{console.error('Fixture preflight or final evidence write failed. Inspect the explicit scratch path if created; do not rerun or assume cleanup.');process.exitCode=1;}
    }
    async #run():Promise<void>{
        this.#prepareScratch();
        try{await this.#load();this.#metadata();await this.#storageNegatives();await this.#start();await this.#vertical();}
        catch(error){this.#report.failure={code:this.#errorCode(error),message:String(error instanceof Error?error.message:error).slice(0,2000)};process.exitCode=this.#uncertain?2:1;}
        finally{await this.#finish();}
    }
    #prepareScratch():void{
        assert.ok(/^[a-f0-9]{40}$/.test(this.#expectedCommit),'Require the exact reviewed checkout commit.');
        assert.ok(path.isAbsolute(this.#scratch)&&path.normalize(this.#scratch)===this.#scratch,'Scratch must be an explicit canonical absolute path.');
        assert.ok(this.#scratch.split(path.sep).includes('AIWork'),'Scratch must be a fresh leaf under a caller-approved AIWork directory.');
        assert.ok(!this.#within(this.#root,this.#scratch)&&!this.#within(this.#scratch,this.#root),'Scratch and checkout cannot contain one another.');
        try{fs.lstatSync(this.#scratch);throw new Error('Scratch already exists, even if empty. Nothing will be reused.');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
        const parent=path.dirname(this.#scratch);this.#ordinaryAncestors(parent);assert.equal(fs.realpathSync(parent),parent,'Use the actual canonical approved parent path.');assert.equal(fs.lstatSync(parent).uid,process.getuid!(),'Approved scratch parent must belong to current uid.');
        this.#verifyCheckout();fs.mkdirSync(this.#scratch,{mode:0o700});this.#assertMode(this.#scratch,true);
        for(const name of ['receipts','storage']){fs.mkdirSync(path.join(this.#scratch,name),{mode:0o700});this.#assertMode(path.join(this.#scratch,name),true);}
        this.#writeJson('report.json',this.#report);this.#report.scratch=this.#scratch;this.#report.runId=this.#runId;
    }
    #verifyCheckout():void{
        const head=this.#git(['rev-parse','HEAD']).trim();assert.equal(head,this.#expectedCommit,'Checkout is not the explicitly reviewed commit.');
        assert.equal(this.#git(['status','--porcelain=v1','--untracked-files=normal']).trim(),'','Require a clean isolated checkout, not an existing live-client checkout.');
        this.#report.checkout={root:this.#root,commit:head,runtimeSourceCheckpoint:CdpMacosSmoke.#runtimeCheckpoint};
        this.#report.sourceHashesBefore=this.#sourceHashes();
    }
    async #load():Promise<void>{
        this.#bootstrap=await import('../cdp-bootstrap.mts');this.#contract=await import('../cdp-contract.mts');
        this.#platform=await import('../cdp-platform.mts');this.#policy=await import('../cdp-private-directory.mts');
        this.#images=await import('../cdp-artifacts.mts');this.#jpeg=await import('../cdp-image-codec.mts');this.#sqlite=await import('node:sqlite');
        const browser=await import('../cdp-browser.mts');assert.equal(browser.CdpBrowserSession.libraryVersion(),'1.65.0','No alternate Playwright/download fallback.');
        this.#report.libraryVersion=browser.CdpBrowserSession.libraryVersion();
    }
    #metadata():void{
        this.#report.native={platform:process.platform,arch:process.arch,node:process.version,execPath:process.execPath,fixturePid:process.pid,uid:process.getuid!(),hostname:os.hostname(),osRelease:os.release()};
        const executable=this.#platform.CdpPlatform.installedChrome(),jpeg=this.#jpeg.CdpJpeg.availability();
        this.#report.dependencies={installedChrome:executable,jpeg:{available:jpeg.available,requiredVersion:jpeg.requiredVersion,actualVersion:jpeg.actualVersion,reason:jpeg.reason}};
        this.#report.parentEnvironmentBefore=this.#parentEnvironment;this.#report.parentUmaskBefore=this.#parentUmask;
        this.#report.fixtureFileHashes={script:this.#hash(fs.readFileSync(fileURLToPath(import.meta.url))),runbook:this.#hash(fs.readFileSync(path.join(this.#root,'docs/CDP-macos.md')))};
        this.#step('native metadata and installed dependencies',this.#report.native);
    }
    async #storageNegatives():Promise<void>{
        // Adapted from mac-private-files.mts. Every mutation below is inside this run's fresh root.
        const root=path.join(this.#scratch,'negative-fixture'),policy=new this.#policy.CdpPrivateDirectoryPolicy(root);policy.createFresh();
        const file=path.join(root,'ordinary');fs.writeFileSync(file,'synthetic fixture',{flag:'wx',mode:0o600});policy.assertPrivateFile(file,false);
        const hard=path.join(root,'hardlink');fs.linkSync(file,hard);assert.throws(()=>policy.assertPrivateFile(file,false),{code:'UNSAFE_STORAGE_PATH'});fs.unlinkSync(hard);
        const symbolic=path.join(root,'symbolic');fs.symlinkSync(file,symbolic);assert.throws(()=>policy.assertPrivateFile(symbolic,false),{code:'UNSAFE_STORAGE_PATH'});
        const directory=policy.createChild('badmode');fs.chmodSync(directory,0o750);assert.throws(()=>policy.assertPrivateDirectory(directory),{code:'PRIVATE_MODE_UNVERIFIED'});assert.equal(fs.statSync(directory).mode&0o7777,0o750);
        fs.chmodSync(file,0o644);assert.throws(()=>policy.assertPrivateFile(file,false),{code:'PRIVATE_MODE_UNVERIFIED'});assert.equal(fs.statSync(file).mode&0o7777,0o644);
        this.#step('fresh-only negative storage checks',{wrongModesRejectedUnchanged:true,hardlinkRejected:true,symlinkRejected:true,foreignOwnerFilesystemTest:'NOT ATTEMPTED',preservedUnder:root});
    }
    async #start():Promise<void>{
        this.#server=http.createServer((request,response)=>this.#serve(request,response));
        await new Promise<void>((resolve,reject)=>{this.#server!.once('error',reject);this.#server!.listen(0,'127.0.0.1',resolve);});
        this.#origin='http://127.0.0.1:'+(this.#server.address() as import('node:net').AddressInfo).port;
        const digest=createHash('sha256').update(this.#contract.CdpContract.canonical(this.#route)).digest('hex');
        this.#installation=path.join(this.#scratch,'storage','BenAI-CDP-v1-'+digest.slice(0,32));
        this.#report.route=this.#route;this.#report.origin=this.#origin;this.#report.installation=this.#installation;this.#persist();
        this.#runtime=new this.#bootstrap.CdpClientBootstrap({storageParent:path.join(this.#scratch,'storage'),fixtureOrigin:this.#origin}).open(this.#route);
        const identity=this.#runtime.identity;
        this.#context={accountUserId:'9007199254740993',actorConversationId:'9007199254740995',parentConversationId:null,clientName:identity.clientName,clientInstallId:identity.clientInstallId,clientIncarnationId:identity.clientIncarnationId,access:'owner'};
        this.#report.identity=identity;this.#verifyStorage('bootstrap, journal open');
    }
    #serve(request:http.IncomingMessage,response:http.ServerResponse):void{
        const fixture=request.url==='/fixture';if(fixture)this.#navigationRequests++;
        response.writeHead(fixture?200:404,{'Content-Type':'text/html; charset=utf-8','Connection':'close','Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'"});
        response.end(fixture?'<!doctype html><title>Owned Mac smoke</title><body style="background:#eef;color:#123"><h1>Owned Mac smoke '+this.#runId+'</h1><label>Name <input value="synthetic value"></label><button>Fixture only</button></body>':'fixture path only');
    }
    async #vertical():Promise<void>{
        const caps=await this.#send('GetCapabilities',{});assert.equal(caps.cdp.result!.platform,'darwin');
        assert.deepEqual([...(caps.cdp.result!.supported as string[])].sort(),[...CdpMacosSmoke.#initial].sort());this.#step('GetCapabilities',caps.cdp.result);
        const creation=this.#wire('CreateSession',{options:{headless:true,startupTimeoutMs:60000,downloadPolicy:'deny',maxDownloadMiB:1,viewport:{width:640,height:480,deviceScaleFactor:1}}});
        const created=await this.#perform(creation),result=created.cdp.result as any;
        this.#sessionId=result.evidence.sessionId;this.#pageId=result.evidence.pageId;assert.equal(result.output.initialUrl,'about:blank');
        this.#captureOwned();if(!this.#owned){this.#uncertain=true;throw new Error('Public owned-process receipt was not captured; no destructive cleanup fallback.');}
        assert.equal(this.#owned.temporaryRoot,path.join(this.#installation,'browser-'+this.#sessionId));
        this.#step('CreateSession / initial blank page',{sessionId:this.#sessionId,pageId:this.#pageId,browserVersion:result.output.browserVersion});
        await this.#inventoryAndDedup(creation);await this.#pageAndNavigation();await this.#scopeNegatives(creation);
        await this.#image('png');if(this.#jpeg.CdpJpeg.availability().available)await this.#image('jpeg');else this.#step('JPEG SKIPPED',{reason:'Exact installed jpeg-js0.4.4 unavailable; no install/substitute.'});
        this.#verifyStorage('before owned close');await this.#closeOwned();
    }
    async #inventoryAndDedup(creation:CdpWireCommand):Promise<void>{
        // Deliberate duplicate of a definitive completed creation only, never an uncertain replay.
        const duplicate=await this.#sendWire({...creation,id:randomUUID()});
        assert.equal((duplicate.cdp.result as any).evidence.sessionId,this.#sessionId);assert.equal((duplicate.cdp.result as any).mechanicsSettled,true);
        const sessions=await this.#send('GetSessions',{});assert.equal((sessions.cdp.result as any).sessions.length,1);
        const lookup=await this.#send('GetAction',{idKind:'creation',id:creation.cdp.requestId});assert.equal((lookup.cdp.result as any).evidence.sessionId,this.#sessionId);
        this.#step('completed creation dedup / GetSessions / GetAction',{sessionId:this.#sessionId,originalCallId:creation.cdp.callId,sameRequestId:creation.cdp.requestId});
    }
    async #pageAndNavigation():Promise<void>{
        const extra=await this.#perform(this.#wire('CreatePage',{},this.#sessionId));assert.ok((extra.cdp.result as any).evidence.pageId);
        const pages=await this.#send('GetPages',{},this.#sessionId);assert.equal((pages.cdp.result as any).pages.length,2);
        const navigation=this.#wire('Navigate',{url:this.#origin+'/fixture',waitUntil:'load',timeoutMs:30000},this.#sessionId,this.#pageId);
        await this.#perform(navigation);const action=await this.#send('GetAction',{idKind:'action',id:navigation.cdp.actionId},this.#sessionId);assert.equal((action.cdp.result as any).operationState,'completed');
        const observed=await this.#perform(this.#wire('Observe',{options:{maxChars:12000,maxNodes:100}},this.#sessionId,this.#pageId));
        assert.ok(JSON.stringify(observed.cdp.result!.output).includes(this.#runId),'Observe must contain this unique local marker.');assert.equal(this.#navigationRequests,1);
        this.#step('CreatePage / GetPages / Navigate / Observe',{pageCount:2,fixtureNavigations:this.#navigationRequests,documentId:(observed.cdp.result!.output as any).documentId});
    }
    async #scopeNegatives(creation:CdpWireCommand):Promise<void>{
        const foreign=this.#wire('GetCall',{callId:creation.cdp.callId});
        const denied=await this.#sendWire({...foreign,cdp:{...foreign.cdp,context:{...this.#context,actorConversationId:'9007199254740997'}}});
        assert.equal(denied.success,false);assert.equal(denied.cdp.error?.code,'OWNERSHIP_DENIED');
        const wrong=await this.#send('Observe',{},this.#sessionId,randomUUID());assert.equal(wrong.success,false);assert.equal(wrong.cdp.error?.code,'PAGE_UNAVAILABLE');
        this.#step('wrong actor scope / wrong page rejected',{actorCode:denied.cdp.error?.code,pageCode:wrong.cdp.error?.code});
    }
    async #image(format:'png'|'jpeg'):Promise<void>{
        const response=await this.#perform(this.#wire('Screenshot',{options:{format,maxDimension:640,attachImage:true}},this.#sessionId,this.#pageId));
        const transfer=response.transfer;assert.ok(transfer?.dataBase64,'No actual internal image bytes.');const bytes=Buffer.from(transfer.dataBase64,'base64');
        assert.equal(bytes.length,transfer.byteLength);assert.equal(this.#hash(bytes),transfer.sha256);
        const raster=format==='png'?this.#images.CdpPng.read(bytes):this.#jpeg.CdpJpeg.read(bytes);assert.equal(raster.width,640);assert.equal(raster.height,480);
        const name='capture.'+(format==='png'?'png':'jpg');fs.writeFileSync(path.join(this.#scratch,name),bytes,{flag:'wx',mode:0o600});this.#assertMode(path.join(this.#scratch,name),false);
        const retained=await this.#send('ReadArtifact',{artifactId:transfer.artifactId,attachImage:true,maxImageDimension:640},this.#sessionId);assert.equal(retained.transfer?.sha256,transfer.sha256);
        const stored=path.join(this.#installation,'images',transfer.artifactId+(format==='png'?'.png':'.jpg'));this.#assertMode(stored,false);
        this.#step('actual '+format+' decode / retained artifact',{artifactId:transfer.artifactId,byteLength:bytes.length,width:raster.width,height:raster.height,sha256:transfer.sha256,file:name,providerDelivery:false});
    }
    async #perform(wire:CdpWireCommand):Promise<CdpClientResponse>{
        assert.equal(this.#uncertain,false,'No new dispatch after uncertainty.');this.#active=wire;let response:CdpClientResponse;
        try{response=await this.#sendWire(wire);const deadline=Date.now()+180000;
            while((response.cdp.result as any)?.mechanicsSettled!==true){
                if(wire.cdp.op==='CreateSession')this.#captureOwned();
                if(!response.success)this.#operationFailure(response);
                if(Date.now()>=deadline){this.#uncertain=true;throw new Error('Named operation deadline; retain original call '+wire.cdp.callId+', no replay.');}
                await new Promise(resolve=>setTimeout(resolve,250));response=await this.#send('GetCall',{callId:wire.cdp.callId},wire.cdp.sessionId);
            }
            if(!response.success)this.#operationFailure(response);assert.equal((response.cdp.result as any).operationState,'completed');this.#active=null;return response;
        }catch(error){if(this.#active)this.#uncertain=true;this.#persist();throw error;}
    }
    #operationFailure(response:CdpClientResponse):never{
        const state=(response.cdp.result as any)?.operationState;
        if(state==='failedBeforeDispatch'||state==='cancelledBeforeDispatch'||state==='failed')this.#active=null;
        else this.#uncertain=true;
        throw new Error('Named operation failed: '+(response.cdp.error?.code??state??'UNKNOWN')+'; inspect retained original receipts.');
    }
    async #send(op:CdpOperation,args:any,sessionId:string|null=null,pageId:string|null=null):Promise<CdpClientResponse>{return this.#sendWire(this.#wire(op,args,sessionId,pageId));}
    async #sendWire(wire:CdpWireCommand):Promise<CdpClientResponse>{
        assert.ok(this.#runtime,'Owned runtime missing.');assert.ok(++this.#receiptCount<=1200,'Fixture receipt bound exceeded.');
        this.#writeJson('receipts/'+wire.id+'.request.json',wire);
        const response=await this.#runtime.manager.execute(wire),transfer=response.transfer;
        const projected={...response,...(transfer?{transfer:{artifactId:transfer.artifactId,mimeType:transfer.mimeType,byteLength:transfer.byteLength,sha256:transfer.sha256,width:transfer.width,height:transfer.height,dataBase64:'omitted; real image saved separately'}}:{})};
        this.#writeJson('receipts/'+wire.id+'.response.json',{atUtc:new Date().toISOString(),response:projected});return response;
    }
    #wire(op:CdpOperation,args:any,sessionId:string|null=null,pageId:string|null=null):CdpWireCommand{
        const contract=this.#contract.CdpContract,mutation=contract.isMutation(op),creation=contract.isCreation(op);
        return {id:randomUUID(),command:'cdp',cdp:{protocolVersion:1,callId:randomUUID(),op,context:this.#context,sessionId,pageId,requestId:mutation&&creation?randomUUID():null,actionId:mutation&&!creation?randomUUID():null,
            fingerprint:mutation?'h1:'+this.#hash(Buffer.from(contract.canonical({fixture:true,op,args}))):null,args}};
    }
    #captureOwned():void{
        try{this.#captureOwnedOnce();}catch(error){this.#uncertain=true;this.#persist();throw error;}
    }
    #captureOwnedOnce():void{
        if(this.#owned||!this.#installation||!fs.existsSync(this.#installation))return;
        // Bounded listing of this brand-new synthetic installation only, never OS/profile discovery.
        const entries=fs.readdirSync(this.#installation,{withFileTypes:true});assert.ok(entries.length<=20,'Unexpected fresh installation contents.');
        const candidates=entries.filter(entry=>/^browser-[a-f0-9-]{36}$/.test(entry.name));assert.ok(candidates.length<=1,'Ambiguous owned temporary root.');if(!candidates.length)return;
        const temporaryRoot=path.join(this.#installation,candidates[0].name),proofFile=path.join(temporaryRoot,'owned-process.json');if(!fs.existsSync(proofFile)||fs.lstatSync(proofFile).size===0)return;
        const proof=this.#boundedJson(proofFile);assert.ok(Number.isSafeInteger(proof.hostPid)&&proof.hostPid>0&&Number.isSafeInteger(proof.browserPid)&&proof.browserPid>0);
        assert.ok(typeof proof.profileLeaf==='string'&&/^[a-zA-Z0-9._-]{1,200}$/.test(proof.profileLeaf)&&!['.','..'].includes(proof.profileLeaf));
        const profile=path.join(temporaryRoot,proof.profileLeaf);this.#assertMode(temporaryRoot,true);this.#assertMode(profile,true);
        this.#owned={capturedAtUtc:new Date().toISOString(),temporaryRoot,profile,proofFile,proof,source:'Existing owned host receipt from public BrowserServer.process() and spawnargs; not a model-supplied PID.'};
        this.#writeJson('owned-process-copy.json',this.#owned);this.#persist();this.#probeOwned();
    }
    #probeOwned():void{
        const host=this.#processIdentity(this.#owned.proof.hostPid),browser=this.#processIdentity(this.#owned.proof.browserPid);
        assert.equal(host.uid,process.getuid!());assert.equal(host.ppid,process.pid);assert.equal(browser.uid,process.getuid!());assert.equal(browser.ppid,host.pid);
        let environment:string;try{environment=execFileSync('/bin/ps',['eww','-p',String(host.pid),'-o','command='],{encoding:'utf8',timeout:5000,maxBuffer:262144,stdio:['ignore','pipe','pipe']});}
        catch{throw new Error('Own host TMPDIR environment probe unavailable; raw process environment is never logged.');}
        const expected='TMPDIR='+this.#owned.temporaryRoot;assert.ok(environment.split('\n').some(line=>line.includes(' '+expected+' ')||line.trimEnd().endsWith(' '+expected)),'Actual owned host TMPDIR did not match private temporary root.');
        this.#owned.nativeProcesses={host,browser};this.#owned.tmpdir={actualOwnHostEnvironmentMatched:true,expected:this.#owned.temporaryRoot,otherEnvironmentValuesRecorded:false};
        this.#writeJson('owned-process-native-proof.json',this.#owned);this.#step('public owned process/profile and actual child TMPDIR',this.#owned);
    }
    #processIdentity(pid:number):{pid:number;ppid:number;uid:number;executable:string}{
        let text:string;try{text=execFileSync('/bin/ps',['-p',String(pid),'-o','pid=','-o','ppid=','-o','uid=','-o','comm='],{encoding:'utf8',timeout:5000,maxBuffer:4096,stdio:['ignore','pipe','pipe']});}
        catch{throw new Error('Exact owned process identity probe unavailable; no process scan/kill fallback.');}
        const match=text.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/);assert.ok(match,'Own process metadata was not one exact bounded row.');assert.equal(Number(match[1]),pid);
        return {pid:Number(match[1]),ppid:Number(match[2]),uid:Number(match[3]),executable:match[4]};
    }
    #verifyStorage(phase:string):void{
        const checked:any[]=[];for(const child of ['','journal','images','observations','downloads'])checked.push(this.#assertMode(path.join(this.#installation,child),true));
        for(const child of ['.cdp-installation-v1.json','journal/journal.sqlite','journal/journal.sqlite-wal','journal/journal.sqlite-shm'])checked.push(this.#assertMode(path.join(this.#installation,child),false));
        const db=new this.#sqlite.DatabaseSync(path.join(this.#installation,'journal','journal.sqlite'),{readOnly:true});
        try{const row=db.prepare('SELECT length(hmac_key) AS keyBytes, install_id AS installId FROM installation WHERE singleton=1').get() as {keyBytes:number;installId:string};
            assert.equal(row.keyBytes,32);assert.equal(row.installId,this.#runtime!.identity.clientInstallId);
            this.#step('native private SQLite/WAL/SHM/key protection',{phase,checked,keyBytes:row.keyBytes,keyStorage:'inside protected SQLite installation row; key value not selected/logged',journalMode:db.prepare('PRAGMA journal_mode').get()});
        }finally{db.close();}
    }
    async #closeOwned():Promise<void>{
        assert.equal(this.#closeAttempted,false,'Never replay an owned-close attempt.');this.#closeAttempted=true;
        try{const close=await this.#perform(this.#wire('CloseSession',{timeoutMs:60000},this.#sessionId));const cleanup=(close.cdp.result as any).output.cleanup;this.#report.cleanup=cleanup;
            for(const key of ['browserExited','hostExited','generatedProfileRemoved','privateTemporaryRootRemoved'])assert.equal(cleanup[key],true,'Missing exact owned cleanup proof '+key);
            assert.ok(!fs.existsSync(this.#owned.profile)&&!fs.existsSync(this.#owned.temporaryRoot));this.#cleanupVerified=true;this.#step('CloseSession all four proofs',cleanup);
        }catch(error){this.#uncertain=true;throw error;}
    }
    async #finish():Promise<void>{
        try{if(!this.#uncertain&&this.#runtime){if(this.#sessionId&&!this.#cleanupVerified)await this.#closeOwned();
            const shutdown=await this.#runtime.shutdown(60000);this.#report.shutdown=shutdown;assert.equal(shutdown.pendingOperations,0);assert.equal(shutdown.journalClosed,true);this.#runtime=null;}}
        catch(error){this.#uncertain=true;this.#report.cleanupFailure={code:this.#errorCode(error),message:'Owned cleanup not fully verified. No additional cleanup/replay/delete fallback.'};process.exitCode=2;}
        if(!this.#uncertain&&this.#server)await new Promise<void>(resolve=>this.#server!.close(()=>resolve()));
        try{this.#report.parentEnvironmentAfter=this.#environment();this.#report.parentUmaskAfter=process.umask();assert.deepEqual(this.#environment(),this.#parentEnvironment);assert.equal(process.umask(),this.#parentUmask);
            this.#report.sourceHashesAfter=this.#sourceHashes();assert.deepEqual(this.#report.sourceHashesAfter,this.#report.sourceHashesBefore);
        }catch(error){this.#report.failure??={code:this.#errorCode(error),message:'Parent environment/umask or frozen source preservation check failed.'};process.exitCode=this.#uncertain?2:1;}
        this.#report.status=this.#uncertain?'UNCERTAIN':this.#report.failure?'FAIL':this.#jpeg.CdpJpeg.availability().available?'NATIVE_SMOKE_PASS':'NATIVE_SMOKE_PASS_WITH_JPEG_SKIPPED';
        this.#report.activeOriginalCall=this.#active?.cdp??null;this.#report.receiptCount=this.#receiptCount;this.#report.finishedAtUtc=new Date().toISOString();this.#report.evidencePreserved=true;
        this.#report.uncertaintyPolicy=this.#uncertain?'No further dispatch/shutdown/HTTP close. Owned IPC/server may keep fixture alive; retain this process and report for coordinator-directed exact-owner cleanup. Do not rerun or broad-kill.':'Scratch/evidence retained. Only existing runtime verified-owned cleanup removed browser resources.';
        this.#persist();console.log(JSON.stringify({status:this.#report.status,report:path.join(this.#scratch,'report.json'),cleanup:this.#report.cleanup??null,providerImageDelivery:'NOT TESTED'}));
    }
    #ordinaryAncestors(directory:string):void{
        for(let current=directory;;current=path.dirname(current)){const stat=fs.lstatSync(current);assert.ok(stat.isDirectory()&&!stat.isSymbolicLink(),'Approved path contains a symlink/non-directory.');if(path.dirname(current)===current)break;}
    }
    #assertMode(filename:string,directory:boolean):any{
        this.#ordinaryAncestors(directory?filename:path.dirname(filename));const stat=fs.lstatSync(filename);
        assert.ok(!stat.isSymbolicLink()&&(directory?stat.isDirectory():stat.isFile()&&stat.nlink===1),'Unexpected private path type/link.');assert.equal(stat.uid,process.getuid!());assert.equal(stat.mode&0o7777,directory?0o700:0o600);
        return {path:filename,uid:stat.uid,mode:(stat.mode&0o7777).toString(8),nlink:stat.nlink,byteLength:directory?null:stat.size};
    }
    #boundedJson(filename:string):any{this.#assertMode(filename,false);const stat=fs.lstatSync(filename);assert.ok(stat.size>0&&stat.size<=4096,'Owned proof exceeds bounded size.');return JSON.parse(fs.readFileSync(filename,'utf8'));}
    #sourceHashes():Record<string,string>{const result:Record<string,string>={};for(const name of Object.keys(CdpMacosSmoke.#frozen)){result[name]=this.#hash(fs.readFileSync(path.join(this.#root,name)));assert.equal(result[name],CdpMacosSmoke.#frozen[name],'Runtime source is not the reviewed initial checkpoint: '+name);}return result;}
    #git(args:string[]):string{return execFileSync('git',['--no-pager','-C',this.#root,...args],{encoding:'utf8',timeout:10000,maxBuffer:65536,stdio:['ignore','pipe','pipe']});}
    #within(root:string,candidate:string):boolean{const relative=path.relative(root,candidate);return relative===''||relative!=='..'&&!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative);}
    #hash(bytes:Buffer):string{return createHash('sha256').update(bytes).digest('hex');}
    #environment():Record<string,string|null>{return {TEMP:process.env.TEMP??null,TMP:process.env.TMP??null,TMPDIR:process.env.TMPDIR??null};}
    #errorCode(error:unknown):string{return error&&typeof error==='object'&&'code'in error?String(error.code):'SMOKE_ASSERTION_FAILED';}
    #step(name:string,result:unknown):void{this.#report.steps.push({name,atUtc:new Date().toISOString(),result});this.#persist();}
    #writeJson(relative:string,value:unknown):void{const filename=path.join(this.#scratch,relative),fd=fs.openSync(filename,'wx',0o600);try{fs.writeFileSync(fd,JSON.stringify(value,null,2));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
    #persist():void{if(!this.#report.scratch)return;fs.writeFileSync(path.join(this.#scratch,'report.json'),JSON.stringify({...this.#report,uncertain:this.#uncertain,activeOriginalCall:this.#active?.cdp??null},null,2),{mode:0o600});}
}

await CdpMacosSmoke.main();
