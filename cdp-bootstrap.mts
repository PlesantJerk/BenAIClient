import * as path from 'node:path';
import {CdpPlatform} from './cdp-platform.mts';
import { createHash } from 'node:crypto';
import { CdpContract, CdpContractError, CdpLimits } from './cdp-contract.mts';
import type { CdpClientIdentity, CdpJsonObject } from './cdp-contract.mts';
import { CdpPrivateDirectoryPolicy } from './cdp-private-directory.mts';
import { CdpStore } from './cdp-store.mts';
import { CdpArtifacts } from './cdp-artifacts.mts';
import { CdpClientManager } from './cdp-client.mts';

export interface CdpConfiguredRoute { readonly clientName:string; readonly email:string; readonly rootDirectory?:string; }
// Embedding-only test options. No command/model field can select these paths, policies or binaries.
export interface CdpBootstrapOptions { readonly storageParent?:string; readonly fixtureOrigin?:string; readonly executablePath?:string; readonly limits?:CdpLimits; }

export class CdpOwnedRuntime {
    readonly manager:CdpClientManager;
    readonly identity:CdpClientIdentity;
    readonly #store:CdpStore;
    #shutdown:Promise<CdpJsonObject>|null=null;
    constructor(store:CdpStore,manager:CdpClientManager) {this.#store=store;this.manager=manager;this.identity=store.clientIdentity;}
    shutdown(timeoutMs=10000):Promise<CdpJsonObject> {
        this.#shutdown ??= this.#close(timeoutMs);return this.#shutdown;
    }
    async #close(timeoutMs:number):Promise<CdpJsonObject> {
        const result=await this.manager.shutdownOwned(timeoutMs);
        if(result.pendingOperations===0)this.#store.close();
        return {...result,journalClosed:result.pendingOperations===0};
    }
}

// Automatic per-existing-route bootstrap. Installation UUID/key come only from the verified private journal.
export class CdpClientBootstrap {
    readonly #options:CdpBootstrapOptions;
    constructor(options:CdpBootstrapOptions={}) {this.#options=Object.freeze({...options});}
    open(route:CdpConfiguredRoute):CdpOwnedRuntime {
        const clientName=CdpContract.clientName(route.clientName),email=route.email?.trim().toLowerCase();
        if(!email||email.length>512)throw new CdpContractError('CLIENT_CONFIGURATION_INVALID','Existing routing email is required; no new credentials were created.');
        const parent=CdpPlatform.storageParent(this.#options.storageParent);
        const digest=createHash('sha256').update(CdpContract.canonical({clientName,email})).digest('hex');
        const root=path.join(parent,'BenAI-CDP-v1-'+digest.slice(0,32));
        // Reserve headroom for Playwright's generated profile and Chromium child paths on Windows.
        if(process.platform==='win32'&&path.join(root,'browser-00000000-0000-4000-8000-000000000000').length>180)throw new CdpContractError('BROWSER_PROFILE_PATH_LIMIT','Private browser path exceeds the conservative Windows startup budget; no browser was launched.');
        const policy=new CdpPrivateDirectoryPolicy(root);
        policy.openInstallation(clientName,digest);
        const journal=policy.openInstallationChild('journal'),images=policy.openInstallationChild('images'),observationDirectory=policy.openInstallationChild('observations'),downloadDirectory=policy.openInstallationChild('downloads');
        const store=new CdpStore({directory:journal,clientName,directoryGuard:policy,limits:this.#options.limits});
        try {
            const artifacts=new CdpArtifacts(images,store,policy,{observationDirectory,downloadDirectory});
            const manager=new CdpClientManager({store,artifacts,browser:{privatePolicy:policy,...(route.rootDirectory?{virtualRoot:path.resolve(route.rootDirectory)}:{}),executablePath:CdpPlatform.installedChrome(this.#options.executablePath),...(this.#options.fixtureOrigin ? {fixtureOrigin:this.#options.fixtureOrigin} : {})}});
            return new CdpOwnedRuntime(store,manager);
        } catch(error) {store.close();throw error;}
    }
}
