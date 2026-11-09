import {randomUUID} from 'node:crypto';
import {CdpTraceWriter} from './cdp-trace.mts';
import type {CdpCommand,CdpJsonObject} from './cdp-contract.mts';
import {CdpContractError} from './cdp-contract.mts';
import type {CdpStore} from './cdp-store.mts';
import type {CdpArtifacts} from './cdp-artifacts.mts';

// Core-authorized retained data only. No second SQL reader, network replay, browser trace or mutable caller path.
export class CdpTraceExport {
    readonly #store:CdpStore;
    readonly #artifacts:CdpArtifacts;
    constructor(store:CdpStore,artifacts:CdpArtifacts){this.#store=store;this.#artifacts=artifacts;}
    async export(command:CdpCommand):Promise<CdpJsonObject>{
        if(command.context.access!=='owner')throw new CdpContractError('OWNERSHIP_DENIED','This initial ExportTrace adapter creates owner evidence only; exact parents can read existing admitted trace artifacts.');
        const snapshot=this.#store.traceSnapshot(command.sessionId!,command.pageId,command.context,command.args);
        const artifactId=randomUUID(),destination=this.#artifacts.fileDestination('observation',artifactId);
        const writer=new CdpTraceWriter({sessionId:command.sessionId!,pageId:command.pageId},{maxEvents:command.args.maxEvents as number,maxBytes:command.args.maxBytes as number});
        const written=writer.write(snapshot,destination);
        const admitted=await this.#artifacts.admitOwnedFile({artifactId,sessionId:command.sessionId!,pageId:command.pageId,kind:'observation',mime:'application/json',filePath:written.filePath,byteLength:written.artifact.byteLength,sha256:written.artifact.sha256},command.context);
        if(admitted.admitted!==true)throw new CdpContractError('ARTIFACT_ADMISSION_UNVERIFIED','No successful retained trace admission was proved.');
        return {artifact:admitted.artifact as unknown as CdpJsonObject,capturedAtUtc:admitted.capturedAtUtc,expiresAtUtc:admitted.expiresAtUtc,coverage:written.coverage as unknown as CdpJsonObject,format:'benai.cdp.trace.v1',fullHar:false,source:'authorized retained journal/events/artifact references',artifactCreation:'fresh immutable artifact; same in-process CallId recovers the retained result; no invented public creation identity'};
    }
}
