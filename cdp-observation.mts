import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };
export type CdpObservationAccess = 'owner' | 'parentInspect';
export interface CdpObservationOwner { readonly sessionId: string; readonly pageId: string; }
export interface CdpObservationLimits {
    maxSnapshots: number; maxRetainedBytes: number; maxSnapshotBytes: number; maxRecords: number;
    retentionMs: number; maxFieldChars: number; maxRecordChars: number; maxDepth: number; maxJsonItems: number;
}
export interface CdpObservationCapture {
    frameId: string; documentId: string; epoch: string; captureSignature: string; capturedAtUtc: string;
    observation: unknown;
}
export interface CdpObservationRead {
    pageId: string; frameId: string; captureSignature: string; cursor: string;
    maxNodes?: number; maxChars?: number; expectedDocumentId?: string | null;
}
export interface CdpObservationProof {
    pageId: string; frameId: string; status: 'available' | 'unavailable';
    documentId: string | null; epoch: string | null; observedAtUtc: string; reason: string;
}
export interface CdpObservationTicket { readonly snapshotId: string; readonly cursor: string; readonly expiresAtUtc: string; }
export class CdpObservationError extends Error {
    readonly code: string;
    constructor(code: string, message: string) { super(message); this.name = 'CdpObservationError'; this.code = code; }
}
interface CopyBudget { bytes: number; items: number; ancestors: Set<object>; }
interface Snapshot {
    id: string; frameId: string; documentId: string; epoch: string; signature: string; capturedAtUtc: string;
    expires: number; bytes: number; metadata: JsonObject; nodes: JsonValue[]; frames: JsonValue[];
    captureTruncated: boolean;
}

/** Owner-held retained observation paging only. Core supplies authorization, capture, scope and live proof. */
export class CdpObservationPager {
    readonly limits: Readonly<CdpObservationLimits>;
    #owner: Readonly<CdpObservationOwner>;
    #key = randomBytes(32);
    #snapshots = new Map<string, Snapshot>();
    #forgotten = new Map<string, string>();
    #retainedBytes = 0;

    constructor(owner: CdpObservationOwner, limits: Partial<CdpObservationLimits> = {}) {
        this.#owner = Object.freeze({ sessionId: this.#id(owner.sessionId), pageId: this.#id(owner.pageId) });
        this.limits = this.#limits(limits);
    }

    retain(capture: CdpObservationCapture, access: CdpObservationAccess): CdpObservationTicket {
        this.#ownerOnly(access); this.#prune();
        const snapshot = this.#capture(capture);
        if (this.#snapshots.size >= this.limits.maxSnapshots || this.#retainedBytes + snapshot.bytes > this.limits.maxRetainedBytes)
            this.#fail('SnapshotCapacity', 'Retained observations are at capacity; no live snapshot was evicted.');
        this.#snapshots.set(snapshot.id, snapshot); this.#retainedBytes += snapshot.bytes;
        return Object.freeze({ snapshotId: snapshot.id, cursor: this.#cursor(snapshot, 0), expiresAtUtc: new Date(snapshot.expires).toISOString() });
    }

    read(request: CdpObservationRead, proof: CdpObservationProof, access: CdpObservationAccess): Readonly<JsonObject> {
        this.#access(access);
        const { snapshot, offset } = this.#resolve(request);
        const current = this.#proof(snapshot, request, proof);
        const maxNodes = this.#integer(request.maxNodes ?? 150, 1, 500, 'maxNodes');
        const maxChars = this.#integer(request.maxChars ?? 12000, 1, 32000, 'maxChars');
        return this.#page(snapshot, offset, maxNodes, maxChars, current);
    }

    discard(snapshotId: string, access: CdpObservationAccess): void {
        this.#ownerOnly(access); this.#prune();
        if (!this.#snapshots.has(snapshotId)) this.#fail(this.#forgotten.get(snapshotId) ?? 'UnknownSnapshot', 'Snapshot is not retained.');
        this.#remove(snapshotId, 'SnapshotDiscarded');
    }

    dispose(access: CdpObservationAccess): void {
        this.#ownerOnly(access);
        for (const id of this.#snapshots.keys()) this.#remove(id, 'SnapshotDiscarded');
    }

    #capture(capture: CdpObservationCapture): Snapshot {
        const frameId = this.#id(capture.frameId), documentId = this.#id(capture.documentId);
        const epoch = this.#id(capture.epoch), signature = this.#id(capture.captureSignature, 1024);
        this.#date(capture.capturedAtUtc);
        const budget: CopyBudget = { bytes: 0, items: 0, ancestors: new Set() };
        const value = this.#copy(capture.observation, 0, budget);
        if (!value || Array.isArray(value) || typeof value !== 'object') this.#fail('InvalidObservation', 'Observation must be a plain object.');
        const metadata = value as JsonObject;
        this.#shape(metadata, frameId, documentId);
        const nodes = metadata.nodes as JsonValue[], frames = metadata.frames as JsonValue[];
        this.#records(nodes, frames, frameId, documentId);
        const header: JsonObject = {};
        for (const key of Object.keys(metadata)) if (key !== 'nodes' && key !== 'frames') this.#put(header, key, metadata[key]);
        return this.#snapshot(capture, frameId, documentId, epoch, signature, budget.bytes, header, nodes, frames);
    }

    #snapshot(capture: CdpObservationCapture, frameId: string, documentId: string, epoch: string, signature: string,
        bytes: number, metadata: JsonObject, nodes: JsonValue[], frames: JsonValue[]): Snapshot {
        const envelopeBytes = Buffer.byteLength(JSON.stringify({ frameId, documentId, epoch, signature, capturedAtUtc: capture.capturedAtUtc }));
        if (bytes + envelopeBytes > this.limits.maxSnapshotBytes) this.#fail('SnapshotTooLarge', 'Snapshot including capture metadata exceeds its byte cap.');
        return Object.freeze({ id: randomUUID(), frameId, documentId, epoch, signature, capturedAtUtc: capture.capturedAtUtc,
            expires: Date.now() + this.limits.retentionMs, bytes: bytes + envelopeBytes, metadata: Object.freeze(metadata),
            nodes, frames, captureTruncated: metadata.truncated === true || metadata.framesTruncated === true });
    }

    #shape(value: JsonObject, frameId: string, documentId: string): void {
        if (value.documentId !== documentId || !Array.isArray(value.nodes) || !Array.isArray(value.frames))
            this.#fail('InvalidObservation', 'Observation requires matching documentId and nodes/frames arrays.');
        if ((value.pageId !== undefined && value.pageId !== this.#owner.pageId) || (value.frameId !== undefined && value.frameId !== frameId))
            this.#fail('ScopeMismatch', 'Observation scope differs from the supplied capture scope.');
        for (const key of ['snapshotId', 'capture', 'current', 'paging']) if (Object.hasOwn(value, key))
            this.#fail('ReservedField', `Observation field ${key} is reserved for paging metadata.`);
        for (const key of ['truncated', 'framesTruncated']) if (value[key] !== undefined && typeof value[key] !== 'boolean')
            this.#fail('InvalidObservation', `${key} must be boolean when supplied.`);
    }

    #records(nodes: JsonValue[], frames: JsonValue[], frameId: string, documentId: string): void {
        if (nodes.length + frames.length > this.limits.maxRecords) this.#fail('RecordLimit', 'Too many captured records.');
        for (const row of [...nodes, ...frames]) {
            if (!row || Array.isArray(row) || typeof row !== 'object') this.#fail('InvalidRecord', 'Observation rows must be plain objects.');
            if (JSON.stringify(row).length > this.limits.maxRecordChars) this.#fail('RecordTooLarge', 'An observation record exceeds its character cap.');
        }
        for (const node of nodes) {
            const target = (node as JsonObject).target;
            if (target !== undefined) this.#target(target, frameId, documentId);
        }
    }

    #target(target: JsonValue, frameId: string, documentId: string): void {
        if (!target || Array.isArray(target) || typeof target !== 'object' || target.kind !== 'element' ||
            typeof target.elementId !== 'string' || !target.elementId || target.documentId !== documentId || target.frameId !== frameId)
            this.#fail('TargetScopeMismatch', 'Captured element references must retain exact capture document/frame identity.');
    }

    #copy(value: unknown, depth: number, budget: CopyBudget): JsonValue {
        if (++budget.items > this.limits.maxJsonItems || depth > this.limits.maxDepth) this.#fail('SerializationLimit', 'JSON item/depth limit exceeded.');
        if (value === null) { this.#charge(budget, 4); return null; }
        if (typeof value === 'boolean') { this.#charge(budget, value ? 4 : 5); return value; }
        if (typeof value === 'string') {
            if (value.length > this.limits.maxFieldChars) this.#fail('FieldTooLarge', 'A captured field exceeds its character cap.');
            this.#charge(budget, Buffer.byteLength(JSON.stringify(value))); return value;
        }
        if (typeof value === 'number' && Number.isFinite(value)) { this.#charge(budget, String(value).length); return value; }
        if (typeof value !== 'object' || value === null) this.#fail('InvalidPlainData', 'Only finite plain JSON data is supported.');
        return this.#container(value as object, depth, budget);
    }

    #container(value: object, depth: number, budget: CopyBudget): JsonValue {
        if (budget.ancestors.has(value)) this.#fail('InvalidPlainData', 'Cyclic observations cannot be retained.');
        const array = Array.isArray(value), proto = Object.getPrototypeOf(value);
        if ((array && proto !== Array.prototype) || (!array && proto !== Object.prototype && proto !== null))
            this.#fail('InvalidPlainData', 'Objects/handles with custom prototypes are not plain observations.');
        const keys = Reflect.ownKeys(value);
        if (keys.length > this.limits.maxJsonItems - budget.items + (array ? 1 : 0)) this.#fail('SerializationLimit', 'JSON item limit exceeded.');
        budget.ancestors.add(value); this.#charge(budget, 2);
        try { return array ? this.#array(value as unknown[], keys, depth, budget) : this.#object(value, keys, depth, budget); }
        finally { budget.ancestors.delete(value); }
    }

    #array(value: unknown[], keys: (string | symbol)[], depth: number, budget: CopyBudget): JsonValue[] {
        if (keys.length !== value.length + 1) this.#fail('InvalidPlainData', 'Sparse/decorated arrays are not supported.');
        const result: JsonValue[] = [];
        for (let i = 0; i < value.length; i++) {
            if (i) this.#charge(budget, 1);
            result.push(this.#copy(this.#data(value, String(i)), depth + 1, budget));
        }
        return Object.freeze(result) as unknown as JsonValue[];
    }

    #object(value: object, keys: (string | symbol)[], depth: number, budget: CopyBudget): JsonObject {
        const result: JsonObject = {}; let count = 0;
        for (const key of keys) {
            if (typeof key !== 'string' || key.length > this.limits.maxFieldChars) this.#fail('InvalidPlainData', 'Invalid JSON property key.');
            this.#charge(budget, Buffer.byteLength(JSON.stringify(key)) + 1 + (count++ ? 1 : 0));
            this.#put(result, key as string, this.#copy(this.#data(value, key), depth + 1, budget));
        }
        return Object.freeze(result);
    }

    #data(value: object, key: PropertyKey): unknown {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value'))
            this.#fail('InvalidPlainData', 'Observation properties must be enumerable data properties, not accessors.');
        return descriptor!.value;
    }

    #put(target: JsonObject, key: string, value: JsonValue): void {
        Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
    }

    #charge(budget: CopyBudget, bytes: number): void {
        budget.bytes += bytes;
        if (budget.bytes > this.limits.maxSnapshotBytes) this.#fail('SnapshotTooLarge', 'Captured JSON exceeds its UTF-8 byte cap.');
    }

    #resolve(request: CdpObservationRead): { snapshot: Snapshot; offset: number } {
        const match = typeof request.cursor === 'string' && /^v1\.([0-9a-f-]{36})\.([0-9a-z]{1,8})\.([A-Za-z0-9_-]{43})$/.exec(request.cursor);
        if (!match || request.cursor.length > 128) this.#fail('InvalidCursor', 'Cursor is corrupt or unsupported.');
        const snapshot = this.#snapshots.get(match[1]);
        if (!snapshot) this.#fail(this.#forgotten.get(match[1]) ?? 'UnknownSnapshot', 'Cursor snapshot is not retained by this pager.');
        if (snapshot.expires <= Date.now()) this.#fail('SnapshotExpired', 'Cursor snapshot retention has expired.');
        if (request.pageId !== this.#owner.pageId || request.frameId !== snapshot.frameId || request.captureSignature !== snapshot.signature)
            this.#fail('CursorBindingMismatch', 'Cursor page/frame/capture signature does not match.');
        const offset = parseInt(match[2], 36), expected = this.#cursor(snapshot, offset).split('.')[3];
        if (offset.toString(36) !== match[2] || offset > snapshot.nodes.length + snapshot.frames.length ||
            !timingSafeEqual(Buffer.from(expected), Buffer.from(match[3]))) this.#fail('InvalidCursor', 'Cursor signature or offset is invalid.');
        return { snapshot, offset };
    }

    #cursor(snapshot: Snapshot, offset: number): string {
        const tuple = [this.#owner.sessionId, this.#owner.pageId, snapshot.id, snapshot.frameId, snapshot.documentId, snapshot.epoch, snapshot.signature, offset];
        const signature = createHmac('sha256', this.#key).update(JSON.stringify(tuple)).digest('base64url');
        return `v1.${snapshot.id}.${offset.toString(36)}.${signature}`;
    }

    #proof(snapshot: Snapshot, request: CdpObservationRead, proof: CdpObservationProof): JsonObject {
        if (proof.pageId !== this.#owner.pageId || proof.frameId !== snapshot.frameId) this.#fail('ProofScopeMismatch', 'Current proof has a different scope.');
        if (proof.status !== 'available' && proof.status !== 'unavailable') this.#fail('InvalidProof', 'Current proof status is required.');
        this.#date(proof.observedAtUtc); this.#text(proof.reason, 512, 'proof reason');
        if (proof.status === 'available') { this.#id(proof.documentId); this.#id(proof.epoch); }
        else if (proof.documentId !== null || proof.epoch !== null) this.#fail('InvalidProof', 'Unavailable proof cannot assert a current document/epoch.');
        this.#expected(snapshot, request.expectedDocumentId, proof);
        const state = proof.status === 'unavailable' ? 'unavailable' : proof.documentId !== snapshot.documentId ? 'changed-document' : proof.epoch !== snapshot.epoch ? 'changed-epoch' : 'matches-core-proof';
        return Object.freeze({ status: state, documentId: proof.documentId, epoch: proof.epoch, observedAtUtc: proof.observedAtUtc,
            reason: proof.reason, isStale: proof.status === 'unavailable' ? null : state !== 'matches-core-proof', liveDomClaim: false });
    }

    #expected(snapshot: Snapshot, expected: string | null | undefined, proof: CdpObservationProof): void {
        if (expected === undefined || expected === null) return;
        this.#id(expected);
        if (expected !== snapshot.documentId) this.#fail('StaleDocument', 'Requested document differs from this captured snapshot.');
        if (proof.status !== 'available') this.#fail('DocumentProofUnavailable', 'Requested document cannot be checked against unavailable current proof.');
        if (proof.documentId !== expected) this.#fail('StaleDocument', 'Requested document is no longer the current core-proven document.');
    }

    #page(snapshot: Snapshot, start: number, maxNodes: number, maxChars: number, current: JsonObject): Readonly<JsonObject> {
        const nodes: JsonValue[] = [], frames: JsonValue[] = []; let end = start;
        let page = this.#result(snapshot, start, end, nodes, frames, current);
        const total = snapshot.nodes.length + snapshot.frames.length;
        if (start === total && JSON.stringify(page).length > maxChars) this.#fail('MetadataTooLarge', 'Paging metadata alone exceeds maxChars.');
        while (end < total && end - start < maxNodes) {
            const list = end < snapshot.nodes.length ? nodes : frames;
            list.push(end < snapshot.nodes.length ? snapshot.nodes[end] : snapshot.frames[end - snapshot.nodes.length]);
            const candidate = this.#result(snapshot, start, end + 1, nodes, frames, current);
            if (JSON.stringify(candidate).length > maxChars) { list.pop(); break; }
            page = candidate; end++;
        }
        if (end === start && end < total) {
            if (JSON.stringify(page).length > maxChars) this.#fail('MetadataTooLarge', 'Paging metadata alone exceeds maxChars.');
            this.#fail('WholeRecordTooLarge', 'Next whole record cannot fit maxChars; cursor has not advanced.');
        }
        return this.#freezePage(page);
    }

    #result(snapshot: Snapshot, start: number, end: number, nodes: JsonValue[], frames: JsonValue[], current: JsonObject): JsonObject {
        const total = snapshot.nodes.length + snapshot.frames.length, hasMore = end < total;
        return { ...snapshot.metadata, pageId: this.#owner.pageId, frameId: snapshot.frameId, snapshotId: snapshot.id,
            nodes: nodes.slice(), frames: frames.slice(), truncated: snapshot.captureTruncated || hasMore,
            capture: Object.freeze({ capturedAtUtc: snapshot.capturedAtUtc, documentId: snapshot.documentId, epoch: snapshot.epoch,
                captureSignature: snapshot.signature, expiresAtUtc: new Date(snapshot.expires).toISOString(),
                captureTruncated: snapshot.captureTruncated, totalNodes: snapshot.nodes.length, totalFrames: snapshot.frames.length,
                charactersSemantics: 'capture-total-not-page-total' }), current,
            paging: Object.freeze({ startIndex: start, endIndex: end, totalRecords: total, returnedNodes: nodes.length, returnedFrames: frames.length,
                pagingComplete: !hasMore, hasMore, nextCursor: hasMore ? this.#cursor(snapshot, end) : null, order: 'nodes-then-frames',
                maxNodesSemantics: 'combined-node-and-frame-record-cap', maxCharsSemantics: 'whole-page-JSON-UTF16-units' }) };
    }

    #freezePage(page: JsonObject): Readonly<JsonObject> {
        Object.freeze(page.nodes); Object.freeze(page.frames); return Object.freeze(page);
    }

    #prune(): void {
        const now = Date.now();
        for (const [id, snapshot] of this.#snapshots) if (snapshot.expires <= now) this.#remove(id, 'SnapshotExpired');
    }

    #remove(id: string, reason: string): void {
        const snapshot = this.#snapshots.get(id);
        if (!snapshot) return;
        this.#retainedBytes -= snapshot.bytes; this.#snapshots.delete(id); this.#forgotten.set(id, reason);
        while (this.#forgotten.size > 32) this.#forgotten.delete(this.#forgotten.keys().next().value!);
    }

    #limits(input: Partial<CdpObservationLimits>): Readonly<CdpObservationLimits> {
        const defaults = { maxSnapshots: 8, maxRetainedBytes: 2097152, maxSnapshotBytes: 524288, maxRecords: 5000,
            retentionMs: 60000, maxFieldChars: 32768, maxRecordChars: 65536, maxDepth: 16, maxJsonItems: 50000 };
        const ceilings = { maxSnapshots: 64, maxRetainedBytes: 16777216, maxSnapshotBytes: 4194304, maxRecords: 20000,
            retentionMs: 600000, maxFieldChars: 262144, maxRecordChars: 524288, maxDepth: 32, maxJsonItems: 200000 };
        const result = { ...defaults };
        for (const key of Object.keys(input)) if (!Object.hasOwn(defaults, key)) this.#fail('InvalidLimit', `Unknown limit ${key}.`);
        for (const key of Object.keys(result) as (keyof CdpObservationLimits)[]) result[key] = this.#integer(input[key] ?? defaults[key], 1, ceilings[key], key);
        if (result.maxSnapshotBytes > result.maxRetainedBytes) this.#fail('InvalidLimit', 'maxSnapshotBytes must not exceed maxRetainedBytes.');
        return Object.freeze(result);
    }

    #integer(value: number, min: number, max: number, label: string): number {
        if (!Number.isSafeInteger(value) || value < min || value > max) this.#fail('InvalidLimit', `${label} must be an integer from ${min} to ${max}.`);
        return value;
    }

    #id(value: unknown, max = 256): string {
        if (typeof value !== 'string' || !value.length || value.length > max || /\s/.test(value)) this.#fail('InvalidIdentity', 'Expected a nonempty bounded identity/signature.');
        return value as string;
    }

    #text(value: unknown, max: number, label: string): void {
        if (typeof value !== 'string' || value.length > max) this.#fail('InvalidProof', `Invalid ${label}.`);
    }

    #date(value: unknown): void {
        if (typeof value !== 'string' || value.length > 40 || !/^\d{4}-\d\d-\d\dT.*Z$/.test(value) || !Number.isFinite(Date.parse(value)))
            this.#fail('InvalidCaptureTime', 'Expected a bounded UTC ISO timestamp.');
    }

    #access(access: CdpObservationAccess): void {
        if (access !== 'owner' && access !== 'parentInspect') this.#fail('InvalidAccess', 'Core access classification is required.');
    }

    #ownerOnly(access: CdpObservationAccess): void {
        this.#access(access); if (access !== 'owner') this.#fail('OwnerRequired', 'Read-only parent inspection cannot create/discard retained snapshots.');
    }

    #fail(code: string, message: string): never { throw new CdpObservationError(code, message); }
}
