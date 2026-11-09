import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { types } from 'node:util';
import type { BigIntStats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';

export interface CdpArtifactReadDescriptor {
    readonly artifactId: string;
    readonly filePath: string;
    readonly byteLength?: number | null;
    readonly sha256?: string | null;
    readonly mime?: string | null;
    readonly kind?: string | null;
    readonly sessionId?: string | null;
    readonly pageId?: string | null;
    readonly capturedAtUtc?: string | null;
    readonly expiresAtUtc?: string | null;
    readonly retentionState?: string | null;
    readonly width?: number | null;
    readonly height?: number | null;
    readonly scaling?: { readonly applied: boolean | null; readonly method: string | null; readonly maximumDimension: number | null } | null;
}

export interface CdpArtifactTextOptions {
    readonly offset?: number;
    readonly maxBytes?: number;
}

export interface CdpArtifactReadMetadata {
    readonly artifact: {
        readonly artifactId: string;
        readonly sessionId: string | null;
        readonly pageId: string | null;
        readonly kind: string | null;
        readonly mime: string | null;
        readonly byteLength: number;
        readonly sha256: string | null;
        readonly width: number | null;
        readonly height: number | null;
    };
    readonly capturedAtUtc: string | null;
    readonly expiresAtUtc: string | null;
    readonly retentionState: string | null;
    readonly scaling: CdpArtifactReadDescriptor['scaling'];
    readonly fileState: 'available';
    readonly verification: {
        readonly byteLength: 'matches-admission' | 'observed-only';
        readonly sha256: 'admission-value-not-reverified' | 'unknown';
        readonly fileIdentity: 'stable-during-read-and-prior-reader-observations';
        readonly wholeFileHashVerified: false;
    };
}

export interface CdpArtifactTextPage {
    readonly metadata: CdpArtifactReadMetadata;
    readonly payloadKind: 'text';
    readonly paginationSupported: true;
    readonly encoding: 'utf-8';
    readonly textMode: 'declared-text' | 'explicit-unknown-mime';
    readonly utf8Validation: 'returned-page-and-cut-boundary-only';
    readonly offset: number;
    readonly maxBytes: number;
    readonly bytesReturned: number;
    readonly nextOffset: number;
    readonly eof: boolean;
    readonly text: string;
}

export class CdpArtifactReadError extends Error {
    readonly code: string;
    constructor(code: string, message: string) {
        super(message);
        this.name = 'CdpArtifactReadError';
        this.code = code;
    }
}

/** Core alone authorizes/adopts this file. This helper only reads its immutable approved descriptor. */
export class CdpArtifactReader {
    private readonly descriptor: Readonly<Required<CdpArtifactReadDescriptor>>;
    private observedIdentity: string | null = null;

    constructor(descriptor: CdpArtifactReadDescriptor) {
        this.descriptor = this.copyDescriptor(descriptor);
    }

    /** Stats only. Does not recompute a whole-file hash or certify MIME/content. */
    metadata(): Promise<CdpArtifactReadMetadata> {
        return this.withFile(async (_handle, stat) => this.buildMetadata(stat));
    }

    /** Offset and MaxBytes are bytes. A supplied offset inside a UTF8 scalar is rejected, never silently shifted. */
    readText(options: CdpArtifactTextOptions = {}): Promise<CdpArtifactTextPage> {
        const normalized = this.options(options);
        const textMode = this.textMode();
        return this.withFile(async (handle, stat) => {
            const total = Number(stat.size);
            if (normalized.offset > total) this.fail('ARTIFACT_OFFSET_RANGE', 'Offset exceeds the observed artifact byte length.');
            const bytes = await this.readWindow(handle, normalized.offset, normalized.maxBytes, total);
            const count = this.completePrefix(bytes, normalized.maxBytes);
            const text = this.decode(bytes.subarray(0, count));
            return Object.freeze({ metadata: this.buildMetadata(stat), payloadKind: 'text', paginationSupported: true,
                encoding: 'utf-8', textMode, utf8Validation: 'returned-page-and-cut-boundary-only',
                offset: normalized.offset, maxBytes: normalized.maxBytes, bytesReturned: count,
                nextOffset: normalized.offset + count, eof: normalized.offset + count === total, text });
        });
    }

    describe(): object {
        return { byteOffsets: true, defaultMaxBytes: 16000, maximumMaxBytes: 65536, maximumReadBufferBytes: 65539,
            wholeFileHashOnMetadataOrPage: false, binaryText: false, imageDecoding: false, modifiesFiles: false,
            nextOffset: 'exclusive byte end, including at EOF; stop when eof is true',
            unknownMime: 'readText is an explicit UTF8 text request, not MIME certification' };
    }

    private copyDescriptor(value: CdpArtifactReadDescriptor): Readonly<Required<CdpArtifactReadDescriptor>> {
        const data = this.dataObject(value, ['artifactId','filePath','byteLength','sha256','mime','kind','sessionId','pageId',
            'capturedAtUtc','expiresAtUtc','retentionState','width','height','scaling']);
        const artifactId = this.requiredText(data.artifactId, 128, 'artifactId');
        const filePath = this.requiredText(data.filePath, 32768, 'filePath');
        if (!path.isAbsolute(filePath) || filePath.includes('\0')) this.fail('ARTIFACT_DESCRIPTOR', 'Approved filePath must be an actual absolute local path.');
        const sha256 = this.optionalText(data.sha256, 64, 'sha256');
        if (sha256 !== null && !/^[a-fA-F0-9]{64}$/.test(sha256)) this.fail('ARTIFACT_DESCRIPTOR', 'Supplied SHA256 must contain 64 hexadecimal digits.');
        return Object.freeze({ artifactId, filePath, byteLength: this.optionalInteger(data.byteLength, false, 'byteLength'), sha256,
            mime: this.optionalText(data.mime, 256, 'mime'), kind: this.optionalText(data.kind, 64, 'kind'),
            sessionId: this.optionalText(data.sessionId, 128, 'sessionId'), pageId: this.optionalText(data.pageId, 128, 'pageId'),
            capturedAtUtc: this.optionalText(data.capturedAtUtc, 128, 'capturedAtUtc'), expiresAtUtc: this.optionalText(data.expiresAtUtc, 128, 'expiresAtUtc'),
            retentionState: this.optionalText(data.retentionState, 64, 'retentionState'),
            width: this.optionalInteger(data.width, true, 'width'), height: this.optionalInteger(data.height, true, 'height'),
            scaling: this.scaling(data.scaling) });
    }

    private scaling(value: unknown): Required<CdpArtifactReadDescriptor>['scaling'] {
        if (value === null || value === undefined) return null;
        const data = this.dataObject(value, ['applied','method','maximumDimension']);
        if (data.applied !== null && data.applied !== undefined && typeof data.applied !== 'boolean') this.fail('ARTIFACT_DESCRIPTOR', 'Scaling applied must be boolean or null.');
        return Object.freeze({ applied: (data.applied ?? null) as boolean | null,
            method: this.optionalText(data.method, 64, 'scaling.method'),
            maximumDimension: this.optionalInteger(data.maximumDimension, true, 'scaling.maximumDimension') });
    }

    private dataObject(value: unknown, allowed: string[]): Record<string, unknown> {
        if (!value || typeof value !== 'object' || types.isProxy(value)) this.fail('ARTIFACT_DESCRIPTOR', 'Expected plain data, not accessors/proxies.');
        const prototype = Object.getPrototypeOf(value);
        if (prototype !== Object.prototype && prototype !== null) this.fail('ARTIFACT_DESCRIPTOR', 'Expected plain data object.');
        const output: Record<string, unknown> = Object.create(null);
        for (const key of Reflect.ownKeys(value)) {
            if (typeof key !== 'string' || !allowed.includes(key)) this.fail('ARTIFACT_DESCRIPTOR', 'Unsupported descriptor or option field.');
            const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
            if (!('value' in descriptor)) this.fail('ARTIFACT_DESCRIPTOR', 'Descriptor/option getters are not invoked.');
            output[key] = descriptor.value;
        }
        return output;
    }

    private requiredText(value: unknown, maximum: number, name: string): string {
        if (typeof value !== 'string' || !value.length || value.length > maximum) this.fail('ARTIFACT_DESCRIPTOR', `${name} is missing or exceeds its text bound.`);
        return value;
    }

    private optionalText(value: unknown, maximum: number, name: string): string | null {
        return value === null || value === undefined ? null : this.requiredText(value, maximum, name);
    }

    private optionalInteger(value: unknown, positive: boolean, name: string): number | null {
        if (value === null || value === undefined) return null;
        if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < (positive ? 1 : 0)) this.fail('ARTIFACT_DESCRIPTOR', `${name} must be a safe ${positive ? 'positive' : 'nonnegative'} integer or null.`);
        return value;
    }

    private options(value: CdpArtifactTextOptions): { offset: number; maxBytes: number } {
        const data = this.dataObject(value, ['offset','maxBytes']);
        const offset = data.offset === undefined ? 0 : data.offset;
        const maxBytes = data.maxBytes === undefined ? 16000 : data.maxBytes;
        if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0) this.fail('ARTIFACT_OFFSET_RANGE', 'Offset must be a nonnegative safe byte integer.');
        if (typeof maxBytes !== 'number' || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 65536) this.fail('ARTIFACT_PAGE_LIMIT', 'MaxBytes must be an integer from 1 to 65536.');
        return { offset, maxBytes };
    }

    private textMode(): 'declared-text' | 'explicit-unknown-mime' {
        const mime = this.descriptor.mime;
        if (mime === null) return 'explicit-unknown-mime';
        const parts = mime.toLowerCase().split(';');
        const type = parts[0].trim();
        const textual = type.startsWith('text/') || /^application\/(?:json|xml|javascript|x-javascript|ndjson|x-ndjson)$/.test(type) || /^application\/[a-z0-9!#$&^_.+-]+\+(?:json|xml)$/.test(type);
        if (!textual) this.fail('ARTIFACT_BINARY_TEXT_UNSUPPORTED', 'Declared MIME is not a supported text/JSON/XML type; metadata remains available.');
        for (let i = 1; i < parts.length; i++) {
            const match = /^\s*charset\s*=\s*"?([^"\s;]+)"?\s*$/.exec(parts[i]);
            if (match && match[1] !== 'utf-8' && match[1] !== 'utf8') this.fail('ARTIFACT_TEXT_ENCODING_UNSUPPORTED', 'This helper reads strict UTF8 only; declared charset differs.');
        }
        return 'declared-text';
    }

    private async withFile<T>(action: (handle: FileHandle, stat: BigIntStats) => Promise<T>): Promise<T> {
        let handle: FileHandle | null = null;
        try {
            const named = await fs.lstat(this.descriptor.filePath, { bigint: true });
            this.regular(named);
            handle = await fs.open(this.descriptor.filePath, 'r');
            const stat = await handle.stat({ bigint: true });
            this.checkStat(stat);
            this.same(named, stat);
            const value = await action(handle, stat);
            this.same(stat, await handle.stat({ bigint: true }));
            this.same(stat, await fs.lstat(this.descriptor.filePath, { bigint: true }));
            this.observedIdentity ??= this.identity(stat);
            return value;
        } catch (error) {
            throw this.mapError(error);
        } finally {
            if (handle) {
                try { await handle.close(); }
                catch { throw new CdpArtifactReadError('ARTIFACT_CLOSE_UNCERTAIN', 'Closing this read-only file descriptor failed; no successful read is certified.'); }
            }
        }
    }

    private regular(stat: BigIntStats): void {
        if (!stat.isFile() || stat.isSymbolicLink()) this.fail('ARTIFACT_NOT_REGULAR', 'Approved path is no longer a regular file.');
        if (stat.size < 0n || stat.size > BigInt(Number.MAX_SAFE_INTEGER)) this.fail('ARTIFACT_FILE_SIZE_RANGE', 'File byte size cannot be represented safely by this byte-offset contract.');
    }

    private checkStat(stat: BigIntStats): void {
        this.regular(stat);
        const expected = this.descriptor.byteLength;
        if (expected !== null && stat.size !== BigInt(expected)) this.fail('ARTIFACT_CHANGED', 'Observed byte length differs from the supplied admission descriptor.');
        if (this.observedIdentity !== null && this.identity(stat) !== this.observedIdentity) this.fail('ARTIFACT_CHANGED', 'File identity/size/timestamps changed since this reader last observed it.');
    }

    private same(before: BigIntStats, after: BigIntStats): void {
        this.regular(after);
        if (this.identity(before) !== this.identity(after)) this.fail('ARTIFACT_CHANGED', 'File identity/size/timestamps changed during this read.');
    }

    private identity(stat: BigIntStats): string {
        return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
    }

    private buildMetadata(stat: BigIntStats): CdpArtifactReadMetadata {
        const d = this.descriptor;
        return Object.freeze({ artifact: Object.freeze({ artifactId: d.artifactId, sessionId: d.sessionId, pageId: d.pageId,
            kind: d.kind, mime: d.mime, byteLength: Number(stat.size), sha256: d.sha256, width: d.width, height: d.height }),
            capturedAtUtc: d.capturedAtUtc, expiresAtUtc: d.expiresAtUtc, retentionState: d.retentionState,
            scaling: d.scaling, fileState: 'available', verification: Object.freeze({
                byteLength: d.byteLength === null ? 'observed-only' : 'matches-admission',
                sha256: d.sha256 === null ? 'unknown' : 'admission-value-not-reverified',
                fileIdentity: 'stable-during-read-and-prior-reader-observations', wholeFileHashVerified: false }) });
    }

    private async readWindow(handle: FileHandle, offset: number, maxBytes: number, total: number): Promise<Buffer> {
        const length = Math.min(total - offset, maxBytes + 3);
        const buffer = Buffer.alloc(length);
        let read = 0;
        while (read < length) {
            const result = await handle.read(buffer, read, length - read, offset + read);
            if (!result.bytesRead) this.fail('ARTIFACT_CHANGED', 'Unexpected EOF before the stat-observed bounded read completed.');
            read += result.bytesRead;
        }
        return buffer;
    }

    private completePrefix(bytes: Buffer, maxBytes: number): number {
        let offset = 0;
        while (offset < bytes.length && offset < maxBytes) {
            const width = this.scalarWidth(bytes[offset], offset === 0);
            this.validateScalar(bytes, offset, width);
            if (offset + width > maxBytes) break;
            offset += width;
        }
        if (offset === 0 && bytes.length) this.fail('ARTIFACT_PAGE_TOO_SMALL', 'MaxBytes cannot fit the next complete UTF8 scalar; increase it, do not skip bytes.');
        return offset;
    }

    private scalarWidth(lead: number, first: boolean): number {
        if (lead < 0x80) return 1;
        if (lead >= 0xC2 && lead <= 0xDF) return 2;
        if (lead >= 0xE0 && lead <= 0xEF) return 3;
        if (lead >= 0xF0 && lead <= 0xF4) return 4;
        if (first && lead >= 0x80 && lead <= 0xBF) this.fail('ARTIFACT_UTF8_OFFSET', 'Offset starts inside a UTF8 scalar or on an invalid standalone continuation byte.');
        return this.fail('ARTIFACT_INVALID_UTF8', 'Returned byte window contains an invalid UTF8 leading byte.');
    }

    private validateScalar(bytes: Buffer, offset: number, width: number): void {
        if (offset + width > bytes.length) this.fail('ARTIFACT_TRUNCATED_UTF8', 'Artifact ends with an incomplete UTF8 scalar in the requested window.');
        for (let i = 1; i < width; i++) if (bytes[offset + i] < 0x80 || bytes[offset + i] > 0xBF) this.fail('ARTIFACT_INVALID_UTF8', 'Requested byte window contains an invalid UTF8 continuation.');
        const lead = bytes[offset], second = bytes[offset + 1];
        if ((lead === 0xE0 && second < 0xA0) || (lead === 0xED && second > 0x9F) || (lead === 0xF0 && second < 0x90) || (lead === 0xF4 && second > 0x8F))
            this.fail('ARTIFACT_INVALID_UTF8', 'Overlong, surrogate or out-of-range UTF8 scalar is unsupported.');
        if (width === 1 && ((lead < 0x20 && lead !== 9 && lead !== 10 && lead !== 13) || lead === 0x7F))
            this.fail('ARTIFACT_BINARY_TEXT_UNSUPPORTED', 'Requested data contains binary control bytes; it is not emitted as model text.');
    }

    private decode(bytes: Buffer): string {
        try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
        catch { return this.fail('ARTIFACT_INVALID_UTF8', 'Requested complete byte page is not valid UTF8.'); }
    }

    private mapError(error: unknown): Error {
        if (error instanceof CdpArtifactReadError) return error;
        const code = (error as NodeJS.ErrnoException)?.code;
        if (code === 'ENOENT' || code === 'ENOTDIR') return new CdpArtifactReadError('ARTIFACT_MISSING', 'Approved artifact file is missing.');
        if (code === 'EISDIR') return new CdpArtifactReadError('ARTIFACT_NOT_REGULAR', 'Approved artifact path is not a regular file.');
        if (code === 'EACCES' || code === 'EPERM') return new CdpArtifactReadError('ARTIFACT_UNAVAILABLE', 'Approved artifact is not currently readable.');
        return new CdpArtifactReadError('ARTIFACT_READ_FAILED', 'Read-only artifact operation failed; no data or integrity success is certified.');
    }

    private fail(code: string, message: string): never {
        throw new CdpArtifactReadError(code, message);
    }
}
