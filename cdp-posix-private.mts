import * as fs from 'node:fs';
import {CdpContractError} from './cdp-contract.mts';

// Native macOS policy only. Existing permissions are verified, never repaired.
export class CdpPosixPrivateFiles {
    static currentUid():number {
        if(process.platform!=='darwin'||!process.getuid||!process.geteuid||process.getuid()!==process.geteuid())throw new CdpContractError('PRIVATE_PLATFORM_UNSUPPORTED','macOS storage requires the ordinary current process uid.');
        return process.getuid();
    }
    static assertMetadata(stat:Pick<fs.Stats,'uid'|'mode'|'nlink'>,uid:number,directory:boolean):void {
        const expected=directory?0o700:0o600;
        if(!Number.isSafeInteger(uid)||uid<0||stat.uid!==uid||(stat.mode&0o7777)!==expected||(!directory&&stat.nlink!==1))throw new CdpContractError('PRIVATE_MODE_UNVERIFIED','Private storage requires current uid and exact directory0700/file0600 permissions.');
    }
    static assertPath(filename:string,directory:boolean):void {
        const stat=this.#ordinary(filename,directory);this.assertMetadata(stat,this.currentUid(),directory);
    }
    static initializeFresh(filename:string,directory:boolean):void {
        const stat=this.#ordinary(filename,directory),uid=this.currentUid();
        if(stat.uid!==uid)throw new CdpContractError('PRIVATE_MODE_UNVERIFIED','Fresh storage does not belong to the current uid.');
        // Caller supplies fresh-operation proof. Used for SQLite-generated files and helper-created empty dirs only.
        fs.chmodSync(filename,directory?0o700:0o600);this.assertPath(filename,directory);
    }
    static #ordinary(filename:string,directory:boolean):fs.Stats {
        const stat=fs.lstatSync(filename);
        if(stat.isSymbolicLink()||(directory?!stat.isDirectory():!stat.isFile()||stat.nlink!==1))throw new CdpContractError('UNSAFE_STORAGE_PATH','Private POSIX storage must be ordinary and unaliased.');
        return stat;
    }
}
