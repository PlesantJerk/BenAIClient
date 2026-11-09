import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import { types } from 'node:util';
import { CdpJpeg } from './cdp-image-codec.mts';
import type { CdpJpegLimits } from './cdp-image-codec.mts';
import { CdpArtifactReader, CdpArtifactReadError } from './cdp-artifact-reader.mts';
import type { CdpArtifactReadDescriptor } from './cdp-artifact-reader.mts';
import { CdpContractError } from './cdp-contract.mts';
import type { CdpContext, CdpLimits, CdpJsonObject } from './cdp-contract.mts';
import type { CdpDirectoryGuard, CdpStore, CdpArtifactMetadata } from './cdp-store.mts';

export type CdpImageMime='image/png'|'image/jpeg';
export interface CdpImageOptions {readonly mime:CdpImageMime;readonly maximumDimension:number;}
export interface CdpImageResult {
    readonly artifact:Readonly<CdpArtifactMetadata>;
    readonly source:{readonly mimeType:CdpImageMime;readonly width:number;readonly height:number;readonly byteLength:number;readonly sha256:string;};
    readonly final:{readonly mimeType:CdpImageMime;readonly width:number;readonly height:number;readonly byteLength:number;readonly sha256:string;readonly reencoded:boolean;readonly jpegQuality:number|null;};
    readonly scaling:{readonly applied:boolean;readonly method:'none'|'nearest-neighbor';readonly maximumDimension:number;};
}
export interface CdpImageTransfer {readonly artifactId:string;readonly encoding:'base64';readonly mimeType:CdpImageMime;readonly byteLength:number;readonly sha256:string;readonly width:number;readonly height:number;readonly dataBase64:string;}
interface CdpImageVersion {bytes:Buffer;sourceWidth:number;sourceHeight:number;width:number;height:number;scaled:boolean;reencoded:boolean;jpegQuality:number|null;}

// Deliberately narrow PNG codec for Chrome's noninterlaced 8-bit RGB/RGBA output.
// No claim to decode arbitrary images. Critical chunks, CRCs and inflate size are validated before use.
export class CdpPng {
    static readonly maximumPixels = 16777216;
    static readonly #signature = Buffer.from([137,80,78,71,13,10,26,10]);
    static read(bytes: Buffer): { width: number; height: number; channels: number; pixels: Buffer; } {
        if (!bytes.subarray(0, 8).equals(this.#signature)) this.#fail();
        let offset = 8, width = 0, height = 0, channels = 0, ended = false;
        const data: Buffer[] = [];
        while (offset < bytes.length) {
            if (offset + 12 > bytes.length) this.#fail();
            const length = bytes.readUInt32BE(offset), type = bytes.toString('ascii', offset + 4, offset + 8);
            if (length > bytes.length - offset - 12) this.#fail();
            const chunk = bytes.subarray(offset + 8, offset + 8 + length);
            if (this.#crc(bytes.subarray(offset + 4, offset + 8 + length)) !== bytes.readUInt32BE(offset + 8 + length)) this.#fail();
            if (type === 'IHDR') {
                if (offset !== 8 || length !== 13 || width) this.#fail();
                width = chunk.readUInt32BE(0); height = chunk.readUInt32BE(4); channels = chunk[9] === 2 ? 3 : chunk[9] === 6 ? 4 : 0;
                if (!width || !height || width * height > this.maximumPixels || chunk[8] !== 8 || !channels || chunk[10] || chunk[11] || chunk[12]) this.#fail();
            } else if (type === 'IDAT') { if (!width || ended) this.#fail(); data.push(chunk); }
            else if (type === 'IEND') { if (length || !data.length) this.#fail(); ended = true; offset += 12; break; }
            else if (!/^[a-z]/.test(type)) this.#fail();
            offset += length + 12;
        }
        if (!ended || offset !== bytes.length) this.#fail();
        const stride = width * channels, expected = (stride + 1) * height;
        const raw = inflateSync(Buffer.concat(data), { maxOutputLength: expected });
        if (raw.length !== expected) this.#fail();
        const pixels = Buffer.allocUnsafe(stride * height);
        for (let y = 0; y < height; y++) {
            const filter = raw[y * (stride + 1)]; if (filter > 4) this.#fail();
            for (let x = 0; x < stride; x++) {
                const index = y * stride + x, a = x >= channels ? pixels[index - channels] : 0, b = y ? pixels[index - stride] : 0, c = y && x >= channels ? pixels[index - stride - channels] : 0;
                const prediction = filter === 0 ? 0 : filter === 1 ? a : filter === 2 ? b : filter === 3 ? Math.floor((a + b) / 2) : this.#paeth(a,b,c);
                pixels[index] = (raw[y * (stride + 1) + 1 + x] + prediction) & 255;
            }
        }
        return { width, height, channels, pixels };
    }
    static resize(bytes: Buffer, maximum: number): { bytes: Buffer; sourceWidth: number; sourceHeight: number; width: number; height: number; scaled: boolean; } {
        const source = this.read(bytes), ratio = Math.min(1, maximum / Math.max(source.width, source.height));
        const width = Math.max(1, Math.floor(source.width * ratio)), height = Math.max(1, Math.floor(source.height * ratio));
        if (ratio === 1) return { bytes, sourceWidth: source.width, sourceHeight: source.height, width, height, scaled: false };
        const pixels = Buffer.allocUnsafe(width * height * source.channels);
        for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
            const from = (Math.min(source.height - 1, Math.floor(y / ratio)) * source.width + Math.min(source.width - 1, Math.floor(x / ratio))) * source.channels;
            source.pixels.copy(pixels, (y * width + x) * source.channels, from, from + source.channels);
        }
        return { bytes: this.#encode(width,height,source.channels,pixels), sourceWidth: source.width, sourceHeight: source.height, width, height, scaled: true };
    }
    static #encode(width: number, height: number, channels: number, pixels: Buffer): Buffer {
        const header = Buffer.alloc(13); header.writeUInt32BE(width,0); header.writeUInt32BE(height,4); header[8] = 8; header[9] = channels === 3 ? 2 : 6;
        const stride = width * channels, rows = Buffer.alloc((stride + 1) * height);
        for (let y = 0; y < height; y++) pixels.copy(rows, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
        return Buffer.concat([this.#signature, this.#chunk('IHDR', header), this.#chunk('IDAT', deflateSync(rows)), this.#chunk('IEND', Buffer.alloc(0))]);
    }
    static #chunk(type: string, data: Buffer): Buffer {
        const result = Buffer.alloc(data.length + 12); result.writeUInt32BE(data.length,0); result.write(type,4,4,'ascii'); data.copy(result,8);
        result.writeUInt32BE(this.#crc(result.subarray(4,result.length - 4)), result.length - 4); return result;
    }
    static #crc(data: Buffer): number {
        let crc = 0xffffffff;
        for (const byte of data) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
        return (crc ^ 0xffffffff) >>> 0;
    }
    static #paeth(a: number,b: number,c: number): number { const p = a+b-c, pa = Math.abs(p-a), pb = Math.abs(p-b), pc = Math.abs(p-c); return pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
    static #fail(): never { throw new CdpContractError('UNSUPPORTED_IMAGE', 'PNG is invalid or outside the admitted Chrome PNG subset.'); }
}

export interface CdpArtifactDirectories {readonly observationDirectory:string;readonly downloadDirectory:string;}
export interface CdpOwnedArtifactFile {
    readonly artifactId:string;readonly sessionId:string;readonly pageId:string|null;
    readonly kind:'observation'|'download';readonly mime:string|null;readonly filePath:string;readonly byteLength:number;readonly sha256:string;
}
export interface CdpOwnedArtifactAdmission {
    readonly artifact:Readonly<CdpArtifactMetadata>;readonly capturedAtUtc:string;readonly createdAtUtc:string;readonly expiresAtUtc:string;
    readonly filePath:string;readonly sourceRemoved:boolean;readonly sourceDisposition:'already-retained'|'removed'|'retained-cleanup-required';
    readonly sourceCleanupError:string|null;readonly admitted:true;readonly wholeFileHashVerifiedAtAdmission:true;
}
interface CdpArtifactStaging {created:boolean;sourceIdentity:string|null;}

export class CdpArtifacts {
    readonly #directory: string;
    readonly #store: CdpStore;
    readonly #guard: CdpDirectoryGuard;
    readonly #limits: CdpLimits;
    readonly #generic: Readonly<CdpArtifactDirectories>|null;
    constructor(directory: string, store: CdpStore, guard: CdpDirectoryGuard, generic?:CdpArtifactDirectories) {
        this.#directory = path.resolve(directory); this.#store = store; this.#guard = guard; this.#limits = store.limits;
        guard.assertPrivateDirectory(this.#directory);
        this.#generic=this.#configureDirectories(generic);
        this.#reconcile();
    }
    savePng(source:Buffer,maximumDimension:number,sessionId:string,pageId:string,caller:CdpContext):CdpImageResult {
        return this.saveImage(source,{mime:'image/png',maximumDimension},sessionId,pageId,caller);
    }
    /** Full pixel decode precedes admission. Initial resize becomes immutable retained bytes, as in savePng. */
    saveImage(source:Buffer,options:CdpImageOptions,sessionId:string,pageId:string,caller:CdpContext):CdpImageResult {
        const normalized=this.#imageOptions(options),mime=normalized.mime,maximum=normalized.maximumDimension;
        if(!Buffer.isBuffer(source)||!source.length||source.length>this.#limits.values.sourceImageBytes)throw new CdpContractError('IMAGE_LIMIT','Source image is empty or exceeds its encoded byte bound.');
        const original=Buffer.from(source),version=this.#resizeImage(original,mime,maximum),bytes=version.bytes;
        if(!bytes.length||bytes.length>this.#limits.values.finalImageBytes)throw new CdpContractError('IMAGE_LIMIT','Admitted image exceeds its encoded byte bound.');
        const id=randomUUID(),sha256=this.#hash(bytes);
        const metadata:CdpArtifactMetadata={artifactId:id,sessionId,pageId,kind:'image',mime,byteLength:bytes.length,sha256,width:version.width,height:version.height};
        this.#store.assertArtifactAdmission(caller,metadata);
        this.#writeImage(metadata,bytes,caller);
        return Object.freeze({artifact:Object.freeze(metadata),...this.#versionMetadata(original,mime,version,maximum)});
    }
    #writeImage(metadata:CdpArtifactMetadata,bytes:Buffer,caller:CdpContext):void {
        this.#guard.assertPrivateDirectory(this.#directory);
        const filename=this.#filename(metadata.artifactId,this.#imageMime(metadata.mime)),fd=fs.openSync(filename,'wx',0o600);
        try {
            try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
            this.#guard.assertPrivateFile?.(filename,true);this.#store.recordArtifact(caller,metadata);
        }catch(error){
            try{fs.unlinkSync(filename);}catch(cleanupError){throw new AggregateError([error,cleanupError],'Private image admission and its own destination cleanup failed.');}throw error;
        }
    }
    readImage(id:string,caller:CdpContext):CdpImageTransfer {
        const metadata=this.#store.getArtifact(id,caller),mime=this.#imageMetadata(metadata),bytes=this.#readImageBytes(metadata,mime);
        const decoded=mime==='image/png'?CdpPng.read(bytes):CdpJpeg.read(bytes,this.#jpegLimits());
        this.#assertImageDimensions(metadata,decoded.width,decoded.height);
        return this.#imageTransfer(metadata.artifactId,mime,bytes,decoded.width,decoded.height);
    }
    #imageMetadata(metadata:Readonly<CdpArtifactMetadata>):CdpImageMime {
        if(metadata.kind!=='image')throw new CdpContractError('UNSUPPORTED_IMAGE','Retained artifact is not an admitted image.');
        return this.#imageMime(metadata.mime);
    }
    #imageMime(value:unknown):CdpImageMime {
        if(value!=='image/png'&&value!=='image/jpeg')throw new CdpContractError('UNSUPPORTED_IMAGE','Only fully decoded PNG/JPEG image MIME types are supported.');return value;
    }
    #imageOptions(value:CdpImageOptions):CdpImageOptions {
        if(!value||typeof value!=='object'||types.isProxy(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))throw new CdpContractError('INVALID_EVIDENCE','Image options require plain data.');
        const keys=Reflect.ownKeys(value),mime=Object.getOwnPropertyDescriptor(value,'mime'),maximum=Object.getOwnPropertyDescriptor(value,'maximumDimension');
        if(keys.length!==2||!mime||!('value'in mime)||!maximum||!('value'in maximum))throw new CdpContractError('INVALID_EVIDENCE','Image options are exactly MIME and maximumDimension; native quality belongs to capture, delivery resize uses fixed85.');
        return {mime:this.#imageMime(mime.value),maximumDimension:this.#imageDimension(maximum.value)};
    }
    #imageDimension(value:unknown):number {
        if(typeof value!=='number'||!Number.isSafeInteger(value)||value<1||value>32768)throw new CdpContractError('IMAGE_LIMIT','Image dimension must be an integer from1 to32768.');return value;
    }
    #jpegLimits():Partial<CdpJpegLimits> {
        return {maxSourceBytes:Math.max(this.#limits.values.sourceImageBytes,this.#limits.values.finalImageBytes),maxOutputBytes:this.#limits.values.finalImageBytes,maxPixels:CdpPng.maximumPixels};
    }
    #resizeImage(bytes:Buffer,mime:CdpImageMime,maximum:number):CdpImageVersion {
        if(mime==='image/png'){const resized=CdpPng.resize(bytes,maximum);return {...resized,reencoded:resized.scaled,jpegQuality:null};}
        const resized=CdpJpeg.resize(bytes,maximum,this.#jpegLimits());
        return {...resized,jpegQuality:resized.quality};
    }
    #versionMetadata(source:Buffer,mime:CdpImageMime,version:CdpImageVersion,maximum:number):Pick<CdpImageResult,'source'|'final'|'scaling'> {
        return {source:Object.freeze({mimeType:mime,width:version.sourceWidth,height:version.sourceHeight,byteLength:source.length,sha256:this.#hash(source)}),
            final:Object.freeze({mimeType:mime,width:version.width,height:version.height,byteLength:version.bytes.length,sha256:this.#hash(version.bytes),reencoded:version.reencoded,jpegQuality:version.jpegQuality}),
            scaling:Object.freeze({applied:version.scaled,method:version.scaled?'nearest-neighbor':'none',maximumDimension:maximum})};
    }
    #assertImageDimensions(metadata:Readonly<CdpArtifactMetadata>,width:number,height:number):void {
        if(width!==metadata.width||height!==metadata.height)throw new CdpContractError('ARTIFACT_INTEGRITY','Retained image dimensions disagree with admitted metadata.');
    }
    #readImageBytes(metadata:Readonly<CdpArtifactMetadata>,mime:CdpImageMime):Buffer {
        this.#guard.assertPrivateDirectory(this.#directory);
        const filename=this.#filename(metadata.artifactId,mime),named=fs.lstatSync(filename);this.#regularImage(named,metadata);
        this.#guard.assertPrivateFile?.(filename,false);const fd=fs.openSync(filename,'r');
        try {
            const before=fs.fstatSync(fd);this.#sameImageFile(named,before);const bytes=Buffer.alloc(metadata.byteLength);let offset=0;
            while(offset<bytes.length){const count=fs.readSync(fd,bytes,offset,bytes.length-offset,offset);if(!count)throw new CdpContractError('ARTIFACT_INTEGRITY','Retained image reached unexpected EOF.');offset+=count;}
            this.#sameImageFile(before,fs.fstatSync(fd));this.#sameImageFile(before,fs.lstatSync(filename));
            if(this.#hash(bytes)!==metadata.sha256)throw new CdpContractError('ARTIFACT_INTEGRITY','Retained image SHA256 verification failed.');return bytes;
        }finally{fs.closeSync(fd);}
    }
    #regularImage(stat:fs.Stats,metadata:Readonly<CdpArtifactMetadata>):void {
        if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size!==metadata.byteLength||stat.size<1||stat.size>this.#limits.values.finalImageBytes)throw new CdpContractError('ARTIFACT_INTEGRITY','Retained image must be a bounded unaliased regular file matching admission.');
    }
    #sameImageFile(before:fs.Stats,after:fs.Stats):void {
        if(!after.isFile()||after.isSymbolicLink()||after.nlink!==1||before.dev!==after.dev||before.ino!==after.ino||before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs)throw new CdpContractError('ARTIFACT_INTEGRITY','Retained image changed during bounded read.');
    }
    #imageTransfer(id:string,mime:CdpImageMime,bytes:Buffer,width:number,height:number):CdpImageTransfer {
        const transfer:CdpImageTransfer=Object.freeze({artifactId:id,encoding:'base64',mimeType:mime,byteLength:bytes.length,sha256:this.#hash(bytes),width,height,dataBase64:bytes.toString('base64')});
        if(Buffer.byteLength(JSON.stringify(transfer))>this.#limits.values.encodedReplyBytes)throw new CdpContractError('REPLY_LIMIT','Encoded image transfer exceeds admission limit; no truncation or quality reduction.');return transfer;
    }
    readArtifact(sessionId:string,args:any,caller:CdpContext):{result:CdpJsonObject;transfer?:CdpImageTransfer} {
        const retained=this.#store.describeArtifact(args.artifactId,caller),metadata=retained.metadata;
        if(metadata.sessionId!==sessionId)throw new CdpContractError('OWNERSHIP_DENIED','Artifact is not in the requested captured session.');
        if(metadata.kind!=='image')throw new CdpContractError('ARTIFACT_KIND_UNSUPPORTED','Image reads require an admitted PNG/JPEG artifact.');
        const mime=this.#imageMetadata(metadata);
        if(args.offset!==0)throw new CdpContractError('ARTIFACT_PAGINATION_UNSUPPORTED','Images have no byte/text pagination. MaxBytes never truncates an image.');
        const bytes=this.#readImageBytes(metadata,mime);
        const result:CdpJsonObject={artifact:metadata as unknown as CdpJsonObject,capturedAtUtc:retained.capturedAtUtc,expiresAtUtc:retained.expiresAtUtc,payloadKind:'image',paginationSupported:false,nextOffset:null,transfer:null};
        if(!args.attachImage){const decoded=mime==='image/png'?CdpPng.read(bytes):CdpJpeg.read(bytes,this.#jpegLimits());this.#assertImageDimensions(metadata,decoded.width,decoded.height);return {result};}
        const maximum=this.#imageDimension(args.maxImageDimension),version=this.#resizeImage(bytes,mime,maximum);this.#assertImageDimensions(metadata,version.sourceWidth,version.sourceHeight);
        if(typeof args.maxImageMiB!=='number'||!Number.isFinite(args.maxImageMiB)||args.maxImageMiB<=0||version.bytes.length>args.maxImageMiB*1048576)throw new CdpContractError('IMAGE_LIMIT','Requested attachment byte budget cannot be met; no quality reduction or partial image.');
        const transfer=this.#imageTransfer(metadata.artifactId,mime,version.bytes,version.width,version.height);
        result.transfer=this.#versionMetadata(bytes,mime,version,maximum) as unknown as CdpJsonObject;return {result,transfer};
    }
    /** Only core-approved roots. Does not create a directory, file, registry entry or grant. */
    fileDestination(kind: 'observation' | 'download', artifactId: string): Readonly<{artifactId:string;filePath:string;}> {
        if (kind !== 'observation' && kind !== 'download') throw new CdpContractError('ARTIFACT_KIND_UNSUPPORTED','Only observation/download files use generic destinations.');
        return Object.freeze({artifactId,filePath:this.#retainedFilename(kind,artifactId)});
    }
    /** Caller supplies an already-owned completed file, never an untrusted model path. */
    async admitOwnedFile(value: CdpOwnedArtifactFile, caller: CdpContext): Promise<CdpOwnedArtifactAdmission> {
        const input = this.#ownedInput(value);
        const metadata = this.#store.assertArtifactAdmission(caller,{artifactId:input.artifactId,sessionId:input.sessionId,pageId:input.pageId,
            kind:input.kind,mime:input.mime,byteLength:input.byteLength,sha256:input.sha256,width:null,height:null});
        const destination = this.fileDestination(input.kind,input.artifactId).filePath;
        const staged: CdpArtifactStaging = {created:false,sourceIdentity:null}; let committed = false;
        try {
            await this.#stageFile(input,destination,staged);
            this.#guard.assertPrivateFile?.(destination,true);
            this.#store.recordArtifact(caller,metadata); committed = true;
        } catch (error) {
            if (!committed && staged.created) {
                try { await fs.promises.unlink(destination); }
                catch (cleanup) { throw new AggregateError([error,cleanup],'Artifact admission failed; only its own newly created destination cleanup also failed. Source is preserved.'); }
            }
            throw error;
        }
        const retained = this.#store.describeArtifact(input.artifactId,caller);
        const cleanup = await this.#removeAdmittedSource(input.filePath,destination,staged.sourceIdentity!);
        return Object.freeze({artifact:retained.metadata,capturedAtUtc:retained.capturedAtUtc,createdAtUtc:retained.capturedAtUtc,
            expiresAtUtc:retained.expiresAtUtc,filePath:destination,sourceRemoved:cleanup.sourceRemoved,
            sourceDisposition:cleanup.disposition,sourceCleanupError:cleanup.error,admitted:true,wholeFileHashVerifiedAtAdmission:true});
    }
    resolveFileDescriptor(sessionId:string,artifactId:string,caller:CdpContext): Readonly<CdpArtifactReadDescriptor> {
        const retained=this.#store.describeArtifact(artifactId,caller), metadata=retained.metadata;
        if(metadata.sessionId!==sessionId) throw new CdpContractError('OWNERSHIP_DENIED','Artifact is not in the requested retained session.');
        const filePath=this.#retainedFilename(metadata.kind,artifactId,metadata.mime);
        this.#guard.assertPrivateDirectory(path.dirname(filePath));
        try {this.#guard.assertPrivateFile?.(filePath,false);}
        catch(error){if((error as NodeJS.ErrnoException)?.code==='ENOENT')throw new CdpArtifactReadError('ARTIFACT_MISSING','Approved retained artifact is missing.');throw error;}
        return Object.freeze({...metadata,filePath,capturedAtUtc:retained.capturedAtUtc,expiresAtUtc:retained.expiresAtUtc,retentionState:'retained'});
    }
    /** Await this additive path for generic text/metadata. Existing image transfer stays unchanged. */
    async readRetainedArtifact(sessionId:string,args:any,caller:CdpContext):Promise<{result:CdpJsonObject;transfer?:CdpImageTransfer}> {
        const descriptor=this.resolveFileDescriptor(sessionId,args.artifactId,caller);
        if(descriptor.kind==='image') return this.readArtifact(sessionId,args,caller);
        if(args.attachImage) throw new CdpContractError('ARTIFACT_IMAGE_ATTACHMENT_UNSUPPORTED','Non-image artifacts have no image attachment/decoder.');
        const reader=new CdpArtifactReader(descriptor);
        try {
            const page=await reader.readText({offset:args.offset,maxBytes:args.maxBytes});
            return this.#boundedResult({...page,artifact:page.metadata.artifact,capturedAtUtc:page.metadata.capturedAtUtc,createdAtUtc:page.metadata.capturedAtUtc,
                expiresAtUtc:page.metadata.expiresAtUtc,transfer:null} as unknown as CdpJsonObject);
        } catch(error) {
            if(!(error instanceof CdpArtifactReadError)||!['ARTIFACT_BINARY_TEXT_UNSUPPORTED','ARTIFACT_TEXT_ENCODING_UNSUPPORTED'].includes(error.code))throw error;
            const metadata=await reader.metadata();
            if(args.offset!==0)throw new CdpContractError('ARTIFACT_PAGINATION_UNSUPPORTED','Unsupported binary/encoding metadata reads require Offset=0. No byte payload is exposed.');
            return this.#boundedResult({artifact:metadata.artifact as unknown as CdpJsonObject,capturedAtUtc:metadata.capturedAtUtc,createdAtUtc:metadata.capturedAtUtc,
                expiresAtUtc:metadata.expiresAtUtc,metadata:metadata as unknown as CdpJsonObject,payloadKind:'binary',paginationSupported:false,
                nextOffset:null,transfer:null,textAvailable:false,textErrorCode:error.code});
        }
    }
    #boundedResult(result:CdpJsonObject):{result:CdpJsonObject} {
        if(Buffer.byteLength(JSON.stringify(result),'utf8')>this.#limits.values.nonImageReplyBytes)throw new CdpContractError('REPLY_LIMIT','Artifact page envelope exceeds configured non-image reply budget; request a smaller MaxBytes.');
        return {result};
    }
    #ownedInput(value:CdpOwnedArtifactFile):CdpOwnedArtifactFile {
        if(!value||typeof value!=='object'||types.isProxy(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))throw new CdpContractError('INVALID_EVIDENCE','Owned file input must be plain data.');
        const allowed=['artifactId','sessionId','pageId','kind','mime','filePath','byteLength','sha256'], data:Record<string,unknown>=Object.create(null);
        const keys=Reflect.ownKeys(value);
        if(keys.length!==allowed.length)throw new CdpContractError('INVALID_EVIDENCE','Owned file descriptor requires exactly its documented fields.');
        for(const key of keys){const d=Object.getOwnPropertyDescriptor(value,key)!;
            if(typeof key!=='string'||!allowed.includes(key)||!('value'in d))throw new CdpContractError('INVALID_EVIDENCE','Owned file descriptor accessors/extra fields are not invoked.');data[key]=d.value;}
        if(data.kind!=='observation'&&data.kind!=='download')throw new CdpContractError('ARTIFACT_KIND_UNSUPPORTED','Generic admission cannot replace image capture.');
        if(typeof data.filePath!=='string'||data.filePath.length>32768||!path.isAbsolute(data.filePath)||data.filePath.includes('\0'))throw new CdpContractError('INVALID_EVIDENCE','Owned source requires an actual absolute local file path.');
        return Object.freeze({...data,filePath:path.resolve(data.filePath)}) as unknown as CdpOwnedArtifactFile;
    }
    async #stageFile(input:CdpOwnedArtifactFile,destination:string,state:CdpArtifactStaging):Promise<void> {
        if(!this.#samePath(input.filePath,destination)) {
            const retainedRoots=[this.#directory,this.#generic?.observationDirectory,this.#generic?.downloadDirectory].filter(Boolean) as string[];
            if(retainedRoots.some(root=>this.#contains(root,input.filePath)))throw new CdpContractError('ARTIFACT_SOURCE_SCOPE','A registered-root source cannot be reparented into another artifact identity.');
            if(this.#contains(path.dirname(input.filePath),destination))throw new CdpContractError('ARTIFACT_SOURCE_SCOPE','Retained destination must be outside the completed source staging directory.');
        }
        this.#guard.assertPrivateDirectory(path.dirname(input.filePath));
        this.#guard.assertPrivateDirectory(path.dirname(destination));
        const named=await fs.promises.lstat(input.filePath,{bigint:true});this.#regularSource(named,input.byteLength);
        const source=await fs.promises.open(input.filePath,'r');let output:fs.promises.FileHandle|null=null;
        try {
            const before=await source.stat({bigint:true});this.#sameFile(named,before);state.sourceIdentity=this.#fileIdentity(before);
            if(!this.#samePath(input.filePath,destination)){output=await fs.promises.open(destination,'wx',0o600);state.created=true;}
            await this.#copyAndHash(source,output,input);
            this.#sameFile(before,await source.stat({bigint:true}));
            this.#sameFile(before,await fs.promises.lstat(input.filePath,{bigint:true}));
            if(output){await output.sync();this.#regularSource(await output.stat({bigint:true}),input.byteLength);}
        } finally {
            try {if(output)await output.close();} finally {await source.close();}
        }
    }
    async #copyAndHash(source:fs.promises.FileHandle,output:fs.promises.FileHandle|null,input:CdpOwnedArtifactFile):Promise<void> {
        const hash=createHash('sha256'),buffer=Buffer.alloc(Math.min(65536,Math.max(1,input.byteLength)));let position=0;
        while(position<input.byteLength){
            const {bytesRead}=await source.read(buffer,0,Math.min(buffer.length,input.byteLength-position),position);
            if(!bytesRead)throw new CdpContractError('ARTIFACT_CHANGED','Owned source reached an unexpected EOF before admission.');
            hash.update(buffer.subarray(0,bytesRead));
            if(output)await this.#writeChunk(output,buffer,bytesRead,position);
            position+=bytesRead;
        }
        if(hash.digest('hex')!==input.sha256)throw new CdpContractError('ARTIFACT_INTEGRITY','Owned source SHA256 differs from the completed-file descriptor.');
    }
    async #writeChunk(output:fs.promises.FileHandle,buffer:Buffer,length:number,position:number):Promise<void> {
        let written=0;
        while(written<length){const result=await output.write(buffer,written,length-written,position+written);
            if(!result.bytesWritten)throw new CdpContractError('ARTIFACT_WRITE_FAILED','Destination write made no progress.');written+=result.bytesWritten;}
    }
    async #removeAdmittedSource(source:string,destination:string,identity:string):Promise<{sourceRemoved:boolean;disposition:CdpOwnedArtifactAdmission['sourceDisposition'];error:string|null}> {
        if(this.#samePath(source,destination))return {sourceRemoved:false,disposition:'already-retained',error:null};
        try {
            const current=await fs.promises.lstat(source,{bigint:true});
            if(this.#fileIdentity(current)!==identity)throw new CdpContractError('ARTIFACT_CHANGED','Source changed after admission. It is not deleted.');
            await fs.promises.unlink(source);return {sourceRemoved:true,disposition:'removed',error:null};
        } catch {return {sourceRemoved:false,disposition:'retained-cleanup-required',error:'ADMITTED_SOURCE_CLEANUP_REQUIRED'};}
    }
    #regularSource(stat:fs.BigIntStats,expected:number):void {
        if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1n)throw new CdpContractError('ARTIFACT_NOT_REGULAR','Owned artifact source must be a nonaliased regular file.');
        if(stat.size!==BigInt(expected))throw new CdpContractError('ARTIFACT_CHANGED','Owned artifact byte length differs from its completed-file descriptor.');
    }
    #sameFile(before:fs.BigIntStats,after:fs.BigIntStats):void {
        this.#regularSource(after,Number(before.size));
        if(this.#fileIdentity(before)!==this.#fileIdentity(after))throw new CdpContractError('ARTIFACT_CHANGED','Owned artifact changed during admission; source is preserved.');
    }
    #fileIdentity(stat:fs.BigIntStats):string{return [stat.dev,stat.ino,stat.size,stat.mtimeNs,stat.ctimeNs].join(':');}
    #samePath(first:string,second:string):boolean{return path.relative(path.resolve(first),path.resolve(second))==='';}
    #retainedFilename(kind:CdpArtifactMetadata['kind'],id:string,mime?:string|null):string {
        if(kind==='image')return this.#filename(id,this.#imageMime(mime));
        if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id))throw new CdpContractError('ARTIFACT_INTEGRITY','Generic artifact identity must be a generated UUID.');
        const directory=kind==='observation'?this.#generic?.observationDirectory:kind==='download'?this.#generic?.downloadDirectory:null;
        if(!directory)throw new CdpContractError('ARTIFACT_DIRECTORY_REQUIRED','Core must supply approved separate retained observation/download directories.');
        this.#guard.assertPrivateDirectory(directory);
        return path.join(directory,id+(kind==='observation'?'.json':'.bin'));
    }
    #configureDirectories(value:CdpArtifactDirectories|undefined):Readonly<CdpArtifactDirectories>|null {
        if(!value)return null;
        const observationDirectory=path.resolve(value.observationDirectory),downloadDirectory=path.resolve(value.downloadDirectory);
        const roots=[this.#directory,observationDirectory,downloadDirectory];
        for(let a=0;a<roots.length;a++)for(let b=a+1;b<roots.length;b++)if(this.#contains(roots[a],roots[b])||this.#contains(roots[b],roots[a]))throw new CdpContractError('ARTIFACT_DIRECTORY_REQUIRED','Image/observation/download roots must be distinct nonoverlapping approved directories.');
        this.#guard.assertPrivateDirectory(observationDirectory);this.#guard.assertPrivateDirectory(downloadDirectory);
        return Object.freeze({observationDirectory,downloadDirectory});
    }
    #contains(parent:string,child:string):boolean{const relative=path.relative(parent,child);return !relative||(!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative));}
    prune(): { expiredReceipts: number; deletedArtifacts: number; } {
        this.#guard.assertPrivateDirectory(this.#directory);
        // Resolve every configured kind BEFORE pruning registry rows. Three-argument image-only use stays valid.
        for(const artifact of this.#store.retainedArtifacts())this.#retainedFilename(artifact.kind,artifact.artifactId,artifact.mime);
        const pruned = this.#store.prune();
        for (const artifact of pruned.artifactsToDelete) fs.rmSync(this.#retainedFilename(artifact.kind,artifact.artifactId,artifact.mime),{force:true});
        return { expiredReceipts:pruned.expiredReceipts, deletedArtifacts:pruned.artifactIdsToDelete.length };
    }
    #reconcile(): void {
        this.prune();
        const retained = new Set(this.#store.retainedArtifacts().filter(value=>value.kind==='image').map(value=>path.basename(this.#filename(value.artifactId,this.#imageMime(value.mime)))));
        const directory = fs.opendirSync(this.#directory); let count = 0;
        try {
            let entry: fs.Dirent | null;
            while ((entry = directory.readSync())) {
                if (++count > 100000) throw new CdpContractError('ARTIFACT_MAINTENANCE_LIMIT','Private image directory reconciliation budget exceeded.');
                if (!/^[0-9a-f-]{36}[.](png|jpg)$/.test(entry.name) || !entry.isFile() || entry.isSymbolicLink()) throw new CdpContractError('UNSAFE_STORAGE_PATH','Unexpected file in the dedicated private image directory.');
                const filename = path.join(this.#directory,entry.name), stat = fs.lstatSync(filename);
                if (stat.nlink !== 1) throw new CdpContractError('UNSAFE_STORAGE_PATH','Aliased private image file rejected.');
                if (!retained.has(entry.name)) fs.unlinkSync(filename);
            }
        } finally { directory.closeSync(); }
    }
    #filename(id:string,mime:CdpImageMime='image/png'):string {if(!/^[0-9a-f-]{36}$/.test(id))throw new CdpContractError('ARTIFACT_INTEGRITY','Artifact identifier is not a generated image identity.');return path.join(this.#directory,id+(mime==='image/png'?'.png':'.jpg'));}
    #hash(bytes: Buffer): string { return createHash('sha256').update(bytes).digest('hex'); }
}
