import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {CdpContractError} from './cdp-contract.mts';

// Resolves the existing captured client virtual namespace. No model-supplied root or new allowlist.
export class CdpProjectFiles {
    readonly #root:string|undefined;
    constructor(root:string|undefined){this.#root=root;}
    async resolve(references:readonly {spaceId:string;path:string}[]):Promise<string[]>{
        if(!this.#root||!path.isAbsolute(this.#root))throw new CdpContractError('PROJECT_NAMESPACE_UNAVAILABLE','The existing client virtual root was not captured; no alternate namespace was guessed.');
        const root=await fs.realpath(this.#root),files:string[]=[];
        for(const reference of references){
            if(reference.spaceId!=='virtual')throw new CdpContractError('PROJECT_NAMESPACE_UNSUPPORTED','Only the existing owning-client virtual namespace is supported; server project transfer is not implemented.');
            const supplied=reference.path.replaceAll('\\',path.sep);
            if(path.isAbsolute(supplied)||path.win32.isAbsolute(supplied))throw new CdpContractError('PROJECT_PATH_RELATIVE_REQUIRED','Virtual project references must be relative to the captured existing root.');
            const candidate=path.resolve(root,supplied);this.#contained(root,candidate);
            const actual=await fs.realpath(candidate);this.#contained(root,actual);files.push(actual);
        }
        return files;
    }
    #contained(root:string,file:string):void{
        const delta=path.relative(root,file);
        if(!delta||delta==='..'||delta.startsWith('..'+path.sep)||path.isAbsolute(delta))throw new CdpContractError('PROJECT_PATH_OUTSIDE_ROOT','File reference is not within the captured client virtual namespace.');
    }
}
