import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

export type CdpTraceJson = null | boolean | number | string | readonly CdpTraceJson[] | { readonly [key: string]: CdpTraceJson };
export interface CdpTraceOwner { readonly sessionId: string; readonly pageId: string | null; }
export interface CdpTraceDestination { readonly artifactId: string; readonly filePath: string; }
export interface CdpTraceLimits {
    readonly maxEvents: number;
    readonly maxBytes: number;
    readonly maxSnapshotEvents: number;
    readonly maxAuxiliaryItems: number;
    readonly maxRecordBytes: number;
    readonly maxStringChars: number;
    readonly maxDepth: number;
    readonly maxJsonItems: number;
}
export interface CdpTraceSection {
    readonly section: string;
    readonly status: 'complete' | 'partial' | 'unavailable' | 'references-only' | 'not-requested';
    readonly reason: string;
}
export interface CdpTraceGap { readonly afterEventId: string; readonly throughEventId: string; readonly reason: string; }
export interface CdpTraceEvent { readonly eventId: string; readonly kind: string; readonly data: CdpTraceJson; }
export interface CdpTraceArtifactReference {
    readonly artifactId: string;
    readonly availability: 'retained' | 'unavailable' | 'expired';
    readonly mime: string | null;
    readonly byteLength: number | null;
    readonly sha256: string | null;
    readonly reason: string;
}
export interface CdpTraceSnapshot {
    readonly capturedAtUtc: string;
    readonly afterEventId: string | null;
    readonly throughEventId: string | null;
    /** Last canonical cursor examined by core, including filtered-out events. */
    readonly scannedThroughEventId: string;
    readonly hasMore: boolean;
    readonly include: readonly string[];
    readonly sections: readonly CdpTraceSection[];
    readonly gaps: readonly CdpTraceGap[];
    readonly actions: readonly CdpTraceJson[];
    readonly artifactReferences: readonly CdpTraceArtifactReference[];
    readonly events: readonly CdpTraceEvent[];
}
export interface CdpTraceCoverage {
    readonly intervalComplete: boolean;
    readonly evidenceComplete: boolean;
    readonly truncated: boolean;
    readonly truncationReasons: readonly string[];
    readonly returnedEvents: number;
    readonly suppliedEvents: number;
    readonly firstReturnedEventId: string | null;
    readonly lastReturnedEventId: string | null;
    readonly scannedThroughEventId: string;
    readonly nextCursor: string | null;
    readonly cursorSemantics: 'exclusive-after-event-id';
    readonly sourceHasMore: boolean;
    readonly gapCount: number;
    readonly requestedEndReached: boolean;
    readonly limitations: readonly string[];
}
export interface CdpTraceResult {
    /** Internal owner-only destination. This is not a public artifact URL. */
    readonly filePath: string;
    readonly contentType: 'application/json';
    readonly encoding: 'utf-8';
    readonly exportedAtUtc: string;
    readonly coverage: CdpTraceCoverage;
    readonly artifact: Readonly<{ artifactId: string; sessionId: string; pageId: string | null; kind: 'observation';
        mime: 'application/json'; byteLength: number; sha256: string; width: null; height: null; }>;
}
export class CdpTraceError extends Error {
    readonly code: string;
    readonly fileCreated: boolean;
    readonly partialRemoved: boolean | null;
    constructor(code: string, message: string, cause?: unknown, fileCreated = false, partialRemoved: boolean | null = null) {
        super(message, cause === undefined ? undefined : { cause });
        this.name = 'CdpTraceError'; this.code = code; this.fileCreated = fileCreated; this.partialRemoved = partialRemoved;
    }
}
interface CdpTracePlan { readonly chunks: readonly string[]; readonly byteLength: number; readonly coverage: CdpTraceCoverage; readonly exportedAtUtc: string; }

/** Strict bounded plain-data encoder. No getters/toJSON, silent value loss, binary expansion or input mutation. */
class CdpTraceEncoder {
    readonly #limits: CdpTraceLimits;
    readonly #parts: string[] = [];
    readonly #ancestors = new Set<object>();
    #bytes = 0;
    #items = 0;
    constructor(limits: CdpTraceLimits) { this.#limits = limits; }
    encode(value: unknown): string { this.#value(value, 0); return this.#parts.join(''); }
    #append(value: string): void {
        this.#bytes += Buffer.byteLength(value, 'utf8');
        if (this.#bytes > this.#limits.maxRecordBytes) throw new CdpTraceError('RecordByteLimit', 'A complete trace record exceeds maxRecordBytes.');
        this.#parts.push(value);
    }
    #string(value: string): void {
        if (value.length > this.#limits.maxStringChars) throw new CdpTraceError('StringLimit', 'A trace string exceeds maxStringChars; use retained references or an explicit smaller snapshot.');
        this.#append(JSON.stringify(value));
    }
    #value(value: unknown, depth: number): void {
        if (++this.#items > this.#limits.maxJsonItems) throw new CdpTraceError('JsonItemLimit', 'A trace record exceeds maxJsonItems.');
        if (depth > this.#limits.maxDepth) throw new CdpTraceError('DepthLimit', 'A trace record exceeds maxDepth.');
        if (value === null) { this.#append('null'); return; }
        if (typeof value === 'string') { this.#string(value); return; }
        if (typeof value === 'boolean') { this.#append(String(value)); return; }
        if (typeof value === 'number') { this.#number(value); return; }
        if (typeof value !== 'object') throw new CdpTraceError('NotPlainJson', 'Only explicit plain JSON values are exportable; Int64 values must be strings.');
        this.#container(value, depth);
    }
    #number(value: number): void {
        if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value)))
            throw new CdpTraceError('NotPlainJson', 'Nonfinite or unsafe integer numbers cannot be exported without loss.');
        this.#append(JSON.stringify(value));
    }
    #container(value: object, depth: number): void {
        if (this.#ancestors.has(value)) throw new CdpTraceError('CircularData', 'Circular trace data cannot be serialized.');
        const array = Array.isArray(value), prototype = Object.getPrototypeOf(value);
        if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null)
            throw new CdpTraceError('NotPlainJson', 'Class instances, buffers, dates and handles must be converted by core to plain data/references.');
        const keys = Reflect.ownKeys(value);
        if (keys.length > this.#limits.maxJsonItems) throw new CdpTraceError('JsonItemLimit', 'A trace container has too many properties.');
        this.#ancestors.add(value);
        try { if (array) this.#array(value as unknown[], keys, depth); else this.#object(value, keys, depth); }
        finally { this.#ancestors.delete(value); }
    }
    #data(value: object, key: PropertyKey, enumerable = true): unknown {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !('value' in descriptor) || (enumerable && !descriptor.enumerable))
            throw new CdpTraceError('NotPlainJson', 'Accessors, sparse arrays and hidden object properties are not plain JSON data.');
        return descriptor.value;
    }
    #array(value: unknown[], keys: PropertyKey[], depth: number): void {
        const length = this.#data(value, 'length', false) as number;
        if (length > this.#limits.maxJsonItems || keys.length !== length + 1 || keys.some(key => typeof key !== 'string'))
            throw new CdpTraceError('NotPlainJson', 'Sparse/extended arrays are not accepted as trace JSON.');
        this.#append('[');
        for (let index = 0; index < length; index++) {
            if (index) this.#append(','); this.#value(this.#data(value, String(index)), depth + 1);
        }
        this.#append(']');
    }
    #object(value: object, keys: PropertyKey[], depth: number): void {
        this.#append('{'); let first = true;
        for (const key of keys) {
            if (typeof key !== 'string') throw new CdpTraceError('NotPlainJson', 'Symbol properties cannot be preserved as JSON.');
            if (!first) this.#append(','); first = false; this.#string(key); this.#append(':');
            this.#value(this.#data(value, key), depth + 1);
        }
        this.#append('}');
    }
}

/** Formats a core-authorized retained snapshot. No gathering, artifact store, SQL, auth, browser, or public transport. */
export class CdpTraceWriter {
    readonly limits: CdpTraceLimits;
    readonly #owner: CdpTraceOwner;
    readonly #sessionId: string;
    readonly #pageId: string | null;
    constructor(owner: CdpTraceOwner, limits: Partial<CdpTraceLimits> = {}) {
        this.#owner = owner; this.#sessionId = this.#identifier(owner.sessionId); this.#pageId = owner.pageId === null ? null : this.#identifier(owner.pageId);
        this.limits = this.#limits(limits);
    }
    /** Core approves destination privacy/scope/quotas before calling. Synchronous, bounded, exclusive creation. */
    write(snapshot: CdpTraceSnapshot, destination: CdpTraceDestination): CdpTraceResult {
        this.#binding(); const approved = this.#destination(destination); const normalized = this.#snapshot(snapshot);
        const plan = this.#plan(normalized); this.#binding();
        const written = this.#writeFile(approved.filePath, plan);
        return Object.freeze({ filePath: approved.filePath, contentType: 'application/json', encoding: 'utf-8',
            exportedAtUtc: plan.exportedAtUtc, coverage: plan.coverage,
            artifact: Object.freeze({ artifactId: approved.artifactId, sessionId: this.#sessionId, pageId: this.#pageId,
                kind: 'observation', mime: 'application/json', byteLength: written.byteLength, sha256: written.sha256, width: null, height: null }) });
    }
    #limits(value: Partial<CdpTraceLimits>): CdpTraceLimits {
        const result = { maxEvents: 1000, maxBytes: 5000000, maxSnapshotEvents: 10000, maxAuxiliaryItems: 256,
            maxRecordBytes: 262144, maxStringChars: 65536, maxDepth: 24, maxJsonItems: 10000, ...value };
        const ceilings = { maxEvents: 10000, maxBytes: 20000000, maxSnapshotEvents: 10000, maxAuxiliaryItems: 2048,
            maxRecordBytes: 1048576, maxStringChars: 262144, maxDepth: 64, maxJsonItems: 50000 };
        for (const key of Object.keys(ceilings) as Array<keyof CdpTraceLimits>)
            if (!Number.isSafeInteger(result[key]) || result[key] < 1 || result[key] > ceilings[key])
                throw new CdpTraceError('InvalidLimits', `Invalid trace bound: ${key}.`);
        return Object.freeze(result);
    }
    #binding(): void {
        if (this.#owner.sessionId !== this.#sessionId || this.#owner.pageId !== this.#pageId)
            throw new CdpTraceError('OwnerBindingChanged', 'Trace writer requires its original exact session/page scope.');
    }
    #identifier(value: unknown): string {
        if (typeof value !== 'string' || !value.trim() || value.length > 128) throw new CdpTraceError('InvalidSnapshot', 'Expected a bounded source/artifact identifier.');
        return value;
    }
    #shape(value: unknown, allowed: readonly string[]): Record<string, unknown> {
        if (!value || typeof value !== 'object' || Array.isArray(value) || ![null, Object.prototype].includes(Object.getPrototypeOf(value)))
            throw new CdpTraceError('InvalidSnapshot', 'Expected a plain data object.');
        const keys = Reflect.ownKeys(value); const result = Object.create(null);
        if (keys.length > allowed.length) throw new CdpTraceError('InvalidSnapshot', 'Unexpected snapshot properties.');
        for (const key of keys) {
            const descriptor = Object.getOwnPropertyDescriptor(value, key);
            if (typeof key !== 'string' || !allowed.includes(key) || !descriptor || !('value' in descriptor) || !descriptor.enumerable)
                throw new CdpTraceError('InvalidSnapshot', 'Unknown, hidden or accessor snapshot property.');
            result[key] = descriptor.value;
        }
        return result;
    }
    #array(value: unknown, maximum: number): readonly unknown[] {
        if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum)
            throw new CdpTraceError('SnapshotItemLimit', 'Expected a bounded plain snapshot array.');
        const keys = Reflect.ownKeys(value);
        if (keys.length !== value.length + 1) throw new CdpTraceError('InvalidSnapshot', 'Sparse/extended snapshot array.');
        const result: unknown[] = [];
        for (let index = 0; index < value.length; index++) {
            const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
            if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) throw new CdpTraceError('InvalidSnapshot', 'Snapshot arrays must contain data properties.');
            result.push(descriptor.value);
        }
        return result;
    }
    #cursor(value: unknown): string {
        if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,18})$/.test(value) || BigInt(value) > 9223372036854775807n)
            throw new CdpTraceError('InvalidCursor', 'Event IDs/cursors must be canonical nonnegative Int64 decimal strings.');
        return value;
    }
    #text(value: unknown, maximum = 4096): string {
        if (typeof value !== 'string' || value.length > maximum) throw new CdpTraceError('InvalidSnapshot', 'Expected bounded explanatory text.');
        return value;
    }
    #snapshot(input: CdpTraceSnapshot): CdpTraceSnapshot {
        const value = this.#shape(input, ['capturedAtUtc','afterEventId','throughEventId','scannedThroughEventId','hasMore','include','sections','gaps','actions','artifactReferences','events']);
        const afterEventId = value.afterEventId === null ? null : this.#cursor(value.afterEventId);
        const throughEventId = value.throughEventId === null ? null : this.#cursor(value.throughEventId);
        const scannedThroughEventId = this.#cursor(value.scannedThroughEventId);
        const include = this.#array(value.include, 32).map(item => this.#identifier(item));
        if (!include.length || new Set(include).size !== include.length || typeof value.hasMore !== 'boolean') throw new CdpTraceError('InvalidSnapshot', 'Include must be unique/nonempty and hasMore explicit.');
        const capturedAtUtc = this.#text(value.capturedAtUtc, 40);
        if (!/^\d{4}-\d{2}-\d{2}T.*Z$/.test(capturedAtUtc) || !Number.isFinite(Date.parse(capturedAtUtc))) throw new CdpTraceError('InvalidSnapshot', 'capturedAtUtc must be a UTC timestamp.');
        const sections = this.#sections(value.sections, include), gaps = this.#gaps(value.gaps);
        const events = this.#events(value.events, afterEventId, throughEventId, scannedThroughEventId);
        const actions = this.#array(value.actions, this.limits.maxAuxiliaryItems) as readonly CdpTraceJson[];
        const artifactReferences = this.#references(value.artifactReferences);
        if (BigInt(scannedThroughEventId) < BigInt(afterEventId ?? '0') || (throughEventId !== null && BigInt(scannedThroughEventId) > BigInt(throughEventId))
            || (value.hasMore && scannedThroughEventId === (afterEventId ?? '0'))) throw new CdpTraceError('InvalidSnapshot', 'Source scan bounds must progress and stay inside the requested interval.');
        return { capturedAtUtc, afterEventId, throughEventId, scannedThroughEventId, hasMore: value.hasMore,
            include, sections, gaps, actions, artifactReferences, events };
    }
    #sections(value: unknown, include: readonly string[]): readonly CdpTraceSection[] {
        const sections = this.#array(value, 64).map(item => {
            const row = this.#shape(item, ['section','status','reason']); const section = this.#identifier(row.section);
            if (!['complete','partial','unavailable','references-only','not-requested'].includes(row.status as string)) throw new CdpTraceError('InvalidSnapshot', 'Unknown section coverage.');
            return { section, status: row.status as CdpTraceSection['status'], reason: this.#text(row.reason) };
        });
        if (new Set(sections.map(row => row.section)).size !== sections.length || include.some(name => !sections.some(row => row.section === name)))
            throw new CdpTraceError('InvalidSnapshot', 'Every requested section needs unique explicit coverage.');
        return sections;
    }
    #gaps(value: unknown): readonly CdpTraceGap[] {
        return this.#array(value, this.limits.maxAuxiliaryItems).map(item => {
            const row = this.#shape(item, ['afterEventId','throughEventId','reason']);
            const afterEventId = this.#cursor(row.afterEventId), throughEventId = this.#cursor(row.throughEventId);
            if (BigInt(throughEventId) < BigInt(afterEventId)) throw new CdpTraceError('InvalidCursor', 'Reversed event gap.');
            return { afterEventId, throughEventId, reason: this.#text(row.reason) };
        });
    }
    #events(value: unknown, after: string | null, through: string | null, scanned: string): readonly CdpTraceEvent[] {
        let previous = BigInt(after ?? '0');
        return this.#array(value, this.limits.maxSnapshotEvents).map(item => {
            const row = this.#shape(item, ['eventId','kind','data']); const eventId = this.#cursor(row.eventId), current = BigInt(eventId);
            if (current <= previous || current > BigInt(scanned) || (through !== null && current > BigInt(through)))
                throw new CdpTraceError('InvalidCursor', 'Events must be strictly increasing inside the supplied scan/request interval.');
            if (!Object.hasOwn(row, 'data')) throw new CdpTraceError('InvalidSnapshot', 'Event data must be explicit.');
            previous = current; return { eventId, kind: this.#identifier(row.kind), data: row.data as CdpTraceJson };
        });
    }
    #references(value: unknown): readonly CdpTraceArtifactReference[] {
        return this.#array(value, this.limits.maxAuxiliaryItems).map(item => {
            const row = this.#shape(item, ['artifactId','availability','mime','byteLength','sha256','reason']);
            if (!['retained','unavailable','expired'].includes(row.availability as string) || (row.byteLength !== null && (!Number.isSafeInteger(row.byteLength) || (row.byteLength as number) < 0))
                || (row.sha256 !== null && (typeof row.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(row.sha256)))) throw new CdpTraceError('InvalidSnapshot', 'Invalid retained artifact reference metadata.');
            return { artifactId: this.#identifier(row.artifactId), availability: row.availability as CdpTraceArtifactReference['availability'],
                mime: row.mime === null ? null : this.#text(row.mime, 100), byteLength: row.byteLength as number | null,
                sha256: row.sha256 as string | null, reason: this.#text(row.reason) };
        });
    }
    #encode(value: unknown): string { return new CdpTraceEncoder(this.limits).encode(value); }
    #header(snapshot: CdpTraceSnapshot, exportedAtUtc: string): string {
        const metadata = { format: 'benai.cdp.trace.v1', encoding: 'utf-8', exportedAtUtc, capturedAtUtc: snapshot.capturedAtUtc,
            source: { sessionId: this.#sessionId, pageId: this.#pageId },
            request: { afterEventId: snapshot.afterEventId, throughEventId: snapshot.throughEventId, include: snapshot.include,
                maxEvents: this.limits.maxEvents, maxBytes: this.limits.maxBytes },
            representation: { container: 'json', attachmentMode: 'references-only', privacyTransform: 'none', libraryTrace: false, fullHar: false,
                networkBodies: 'not gathered; only explicit supplied bounded data/references', sqlLogs: 'not gathered; only explicit supplied bounded data/references',
                screenshots: 'artifact references only; image bytes not embedded', attachmentAvailability: 'core-supplied metadata, not revalidated by writer' },
            sections: snapshot.sections, gaps: snapshot.gaps, actions: snapshot.actions, artifactReferences: snapshot.artifactReferences };
        return this.#encode(metadata).slice(0, -1) + ',"events":[';
    }
    #coverage(snapshot: CdpTraceSnapshot, count: number, reason: string | null): CdpTraceCoverage {
        const last = count ? snapshot.events[count - 1].eventId : null, writerTruncated = count < snapshot.events.length;
        const scanned = writerTruncated ? last ?? snapshot.afterEventId ?? '0' : snapshot.scannedThroughEventId;
        const truncated = writerTruncated || snapshot.hasMore;
        const requestedEndReached = snapshot.throughEventId === null ? !snapshot.hasMore : BigInt(scanned) >= BigInt(snapshot.throughEventId);
        const intervalComplete = !truncated && snapshot.gaps.length === 0 && requestedEndReached;
        const evidenceComplete = intervalComplete && snapshot.include.every(name => snapshot.sections.find(row => row.section === name)?.status === 'complete');
        return Object.freeze({ intervalComplete, evidenceComplete, truncated,
            truncationReasons: Object.freeze([...(reason ? [reason] : []), ...(snapshot.hasMore ? ['snapshotHasMore'] : [])]),
            returnedEvents: count, suppliedEvents: snapshot.events.length, firstReturnedEventId: count ? snapshot.events[0].eventId : null,
            lastReturnedEventId: last, scannedThroughEventId: scanned, nextCursor: truncated ? scanned : null,
            cursorSemantics: 'exclusive-after-event-id', sourceHasMore: snapshot.hasMore, gapCount: snapshot.gaps.length, requestedEndReached,
            limitations: Object.freeze(!requestedEndReached ? ['requested-end-not-scanned; no additional source availability implied'] : []) });
    }
    #tail(coverage: CdpTraceCoverage): string { return '],"coverage":' + this.#encode(coverage) + '}\n'; }
    #plan(snapshot: CdpTraceSnapshot): CdpTracePlan {
        const exportedAtUtc = new Date().toISOString(), header = this.#header(snapshot, exportedAtUtc);
        const records: string[] = []; let bytes = Buffer.byteLength(header), reason: string | null = null;
        const maximum = Math.min(snapshot.events.length, this.limits.maxEvents);
        for (let index = 0; index < maximum; index++) {
            const encoded = (index ? ',' : '') + this.#encode(snapshot.events[index]);
            const provisional = this.#coverage(snapshot, index + 1, index + 1 < snapshot.events.length ? 'maxBytes' : null);
            if (bytes + Buffer.byteLength(encoded) + Buffer.byteLength(this.#tail(provisional)) > this.limits.maxBytes) { reason = 'maxBytes'; break; }
            records.push(encoded); bytes += Buffer.byteLength(encoded);
        }
        if (records.length === maximum && maximum < snapshot.events.length) reason = 'maxEvents';
        let coverage = this.#coverage(snapshot, records.length, reason), tail = this.#tail(coverage);
        while (records.length && bytes + Buffer.byteLength(tail) > this.limits.maxBytes) {
            bytes -= Buffer.byteLength(records.pop()!); reason = 'maxBytes'; coverage = this.#coverage(snapshot, records.length, reason); tail = this.#tail(coverage);
        }
        if (bytes + Buffer.byteLength(tail) > this.limits.maxBytes || (snapshot.events.length && !records.length))
            throw new CdpTraceError('TraceBudgetTooSmall', 'No progressing valid trace part fits the byte budget; no artifact was created.');
        return { chunks: [header, ...records, tail], byteLength: bytes + Buffer.byteLength(tail), coverage, exportedAtUtc };
    }
    #destination(value: CdpTraceDestination): CdpTraceDestination {
        const row = this.#shape(value, ['artifactId','filePath']); const artifactId = this.#identifier(row.artifactId);
        if (typeof row.filePath !== 'string' || !path.isAbsolute(row.filePath) || row.filePath.includes('\0') || row.filePath.length > 4096)
            throw new CdpTraceError('InvalidDestination', 'Core must supply an approved fresh absolute private file destination.');
        return { artifactId, filePath: path.resolve(row.filePath) };
    }
    #writeFile(filename: string, plan: CdpTracePlan): { byteLength: number; sha256: string } {
        let descriptor: number;
        try { descriptor = fs.openSync(filename, 'wx', 0o600); }
        catch (error) { throw new CdpTraceError('DestinationNotCreated', 'Exclusive trace creation failed; no existing destination was touched.', error); }
        let identity: fs.Stats | null = null; let open = true;
        try {
            identity = fs.fstatSync(descriptor); const hash = createHash('sha256'); let byteLength = 0;
            for (const chunk of plan.chunks) byteLength += this.#writeChunk(descriptor, chunk, hash);
            if (byteLength !== plan.byteLength || fs.fstatSync(descriptor).size !== byteLength) throw new CdpTraceError('TraceIntegrity', 'Written byte count differs from the trace plan.');
            fs.fsyncSync(descriptor); fs.closeSync(descriptor); open = false;
            return { byteLength, sha256: hash.digest('hex') };
        } catch (error) {
            const failures: unknown[] = [error];
            if (open) { try { fs.closeSync(descriptor); } catch (closeError) { failures.push(closeError); } }
            let removed = false;
            try { removed = this.#removeOwnPartial(filename, identity); } catch (cleanupError) { failures.push(cleanupError); }
            throw new CdpTraceError('TraceWriteFailed', 'Trace write failed; no complete artifact receipt is available.',
                failures.length === 1 ? error : new AggregateError(failures, 'Trace write/cleanup failures.'), true, removed);
        }
    }
    #writeChunk(descriptor: number, text: string, hash: ReturnType<typeof createHash>): number {
        const bytes = Buffer.from(text, 'utf8'); let written = 0;
        while (written < bytes.length) {
            const count = fs.writeSync(descriptor, bytes, written, bytes.length - written);
            if (count <= 0) throw new CdpTraceError('TraceWriteFailed', 'Trace write made no progress.');
            hash.update(bytes.subarray(written, written + count)); written += count;
        }
        return written;
    }
    #removeOwnPartial(filename: string, identity: fs.Stats | null): boolean {
        let current: fs.Stats;
        try { current = fs.lstatSync(filename); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true; throw error; }
        if (!identity || current.dev !== identity.dev || current.ino !== identity.ino || !current.isFile() || current.isSymbolicLink())
            throw new CdpTraceError('PartialOwnershipChanged', 'Destination no longer identifies this newly-created partial; it was not deleted.');
        fs.unlinkSync(filename); return true;
    }
}
