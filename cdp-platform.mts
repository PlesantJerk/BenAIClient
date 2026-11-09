import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {CdpContractError} from './cdp-contract.mts';
import type {CdpOperation,CdpJsonObject} from './cdp-contract.mts';
import {CdpJpeg} from './cdp-image-codec.mts';

// CDP feature boundary only. No downloads, user profile attachment or global environment changes.
export class CdpPlatform {
    static assertSupported():void {
        if(process.platform!=='win32'&&process.platform!=='darwin')throw new CdpContractError('PRIVATE_PLATFORM_UNSUPPORTED','Owned CDP storage supports Windows and the initial macOS port only.');
    }
    static defaultStorageParent(platform:string,home:string,localAppData:string|undefined):string|undefined {
        if(platform==='win32')return localAppData;
        if(platform==='darwin'&&path.posix.isAbsolute(home))return path.posix.join(home,'Library','Application Support');
        return undefined;
    }
    static storageParent(override?:string):string {
        this.assertSupported();
        const parent=override??this.defaultStorageParent(process.platform,os.userInfo().homedir,process.env.LOCALAPPDATA);
        if(!parent||!path.isAbsolute(parent))throw new CdpContractError('PRIVATE_DIRECTORY_REQUIRED','An absolute existing application data parent is required.');
        return parent;
    }
    static chromeCandidates(platform:string,home:string):readonly string[] {
        if(platform==='win32')return ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'];
        if(platform==='darwin')return ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',path.posix.join(home,'Applications','Google Chrome.app','Contents','MacOS','Google Chrome')];
        return [];
    }
    static installedChrome(override?:string):string {
        this.assertSupported();
        for(const candidate of override?[override]:this.chromeCandidates(process.platform,os.userInfo().homedir)) {
            if(!path.isAbsolute(candidate))throw new CdpContractError('BROWSER_UNAVAILABLE','Installed Chrome requires an absolute executable path.');
            try {if(!fs.statSync(candidate).isFile())continue;fs.accessSync(candidate,fs.constants.X_OK);return candidate;}
            catch(error){if(!['ENOENT','ENOTDIR','EACCES'].includes((error as NodeJS.ErrnoException).code??''))throw error;}
        }
        throw new CdpContractError('BROWSER_UNAVAILABLE','No executable installed Google Chrome was found in the selected standard location; nothing was downloaded.');
    }
    static childEnvironment(platform:string,environment:NodeJS.ProcessEnv,temporaryRoot:string):NodeJS.ProcessEnv {
        return {...environment,TEMP:temporaryRoot,TMP:temporaryRoot,...(platform==='darwin'?{TMPDIR:temporaryRoot}:{}),PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD:'1'};
    }
    static supportsOperation(platform:string,operation:CdpOperation):boolean {
        if(platform==='win32')return true;
        if(platform!=='darwin')return false;
        switch(operation) {
            case 'GetCapabilities':case 'CreateSession':case 'GetSessions':case 'CreatePage':case 'GetPages':case 'CloseSession':
            case 'GetCall':case 'GetAction':case 'Navigate':case 'Observe':case 'Screenshot':case 'ReadArtifact':return true;
            default:return false;
        }
    }
    static assertOperation(operation:CdpOperation):void {
        if(!this.supportsOperation(process.platform,operation))throw new CdpContractError('PLATFORM_OPERATION_UNSUPPORTED','Operation is outside this initial platform slice; no dispatch occurred.');
    }
    static capabilities(base:CdpJsonObject,platform:string=process.platform):CdpJsonObject {
        if(platform!=='darwin')return base;
        const jpeg=CdpJpeg.availability();
        const supported=['GetCapabilities','CreateSession','GetSessions','CreatePage','GetPages','CloseSession','GetCall','GetAction','Navigate','Observe','Screenshot','ReadArtifact'];
        return {...base,operationCapabilities:{Click:false,Fill:false,PressKey:false,InspectElement:false,CreateWatch:false,WaitFor:false,CancelWatch:false,ReadEvents:false,ClosePage:false,Reload:false,SetViewport:false,Hover:false,SelectOptions:false,SetChecked:false,Scroll:false,DragAndDrop:false,HandleDialog:false,GetNetworkExchange:false,SetInputFiles:false,Evaluate:false,ExportTrace:false},
            frameCapabilities:{exactPublicFrameGraph:true,childOperations:['Observe'],singleDocumentAuthority:'CdpTargets document handles'},
            imageCapabilities:{...(base.imageCapabilities as CdpJsonObject),jpeg:jpeg.available,jpegQuality:jpeg.available},
            artifactCapabilities:{...(base.artifactCapabilities as CdpJsonObject),jpegAttachment:jpeg.available},
            jpegCodec:{available:jpeg.available,requiredVersion:jpeg.requiredVersion,actualVersion:jpeg.actualVersion,reason:jpeg.reason},
            traceCapabilities:{available:false},fileCapabilities:{available:false},evaluationCapabilities:{available:false},dialogCapabilities:{available:false},
            networkCapabilities:{available:false},lifecycleCapabilities:{available:false},interactionCapabilities:{available:false},watchCapabilities:{available:false},watchPolicy:{available:false},
            supported,unsupported:[...((base.unsupported as string[])??[]).filter(value=>value!=='macOS runtime'),'advanced operations outside initial macOS vertical slice'],
            platformValidation:{stage:'initial-source-port',nativeAcceptance:'pending external macOS fixture; no native pass asserted by capabilities'}};
    }
}
