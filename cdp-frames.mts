import {randomUUID} from 'node:crypto';
import type {Page, Frame, BrowserContext} from 'playwright-core';

export interface CdpFramesOwner {
    readonly page: Page;
    readonly pageId: string;
    getDocumentId?(frame: Frame): Promise<string | null>;
}
export interface CdpFramesLimits {
    readonly maxRecords?: number;
    readonly maxLiveFrames?: number;
    readonly maxInventoryFrames?: number;
    readonly maxInventoryChars?: number;
    readonly maxMetadataChars?: number;
}
export interface CdpFrameRequest {readonly pageId: string; readonly frameId?: string | null; readonly expectedDocumentId?: string | null;}
export interface CdpFrameDescriptor {
    readonly pageId: string; readonly frameId: string; readonly parentFrameId: string | null; readonly isMain: boolean;
    readonly state: 'available' | 'detached' | 'unavailable'; readonly lifecycleState: 'attached' | 'navigated' | 'detached';
    readonly url: string; readonly name: string; readonly metadataTruncated: boolean;
    readonly documentId: string | null; readonly documentState: 'verified' | 'unavailable' | 'changedDuringRead';
    readonly documentError: string | null; readonly lastKnownDocumentId: string | null; readonly lastDocumentObservedAtUtc: string | null;
    readonly attachedAtUtc: string; readonly updatedAtUtc: string; readonly detachedAtUtc: string | null; readonly unavailableReason: string | null;
    readonly revision: number; readonly changedDuringRead: boolean; readonly nativeFrameId: null; readonly networkContextId: null;
}
interface FrameRecord {
    id: string; frame: Frame | null; parentId: string | null; main: boolean;
    state: 'available' | 'detached' | 'unavailable'; lifecycle: 'attached' | 'navigated' | 'detached';
    url: string; name: string; truncated: boolean; documentId: string | null; documentAt: string | null;
    attachedAt: string; updatedAt: string; detachedAt: string | null; reason: string | null; revision: number;
}
export class CdpFramesError extends Error {
    readonly code: string;
    constructor(code: string, message: string) {super(message); this.name = 'CdpFramesError'; this.code = code;}
}

// INTERNAL owner reference. JSON contains only metadata, never the public Frame object or its Page.
export class CdpFrameSelection {
    readonly #registry: CdpFrames;
    readonly #snapshot: CdpFrameDescriptor;
    constructor(registry: CdpFrames, snapshot: CdpFrameDescriptor) {this.#registry = registry; this.#snapshot = Object.freeze({...snapshot});}
    frame(): Frame {return this.#registry.internalFrame(this.#snapshot.frameId);}
    describe(): CdpFrameDescriptor {return {...this.#snapshot};}
    toJSON(): CdpFrameDescriptor {return this.describe();}
    async assertCurrent(): Promise<CdpFrameDescriptor> {
        if (this.#snapshot.documentId === null) throw new CdpFramesError('DOCUMENT_UNAVAILABLE', 'A selection without document proof cannot assert an unchanged document.');
        return (await this.#registry.resolve({pageId: this.#snapshot.pageId, frameId: this.#snapshot.frameId, expectedDocumentId: this.#snapshot.documentId})).describe();
    }
}

// No installed listeners or second document authority. Core delegates its sole Page lifecycle listeners.
export class CdpFrames {
    readonly #owner: CdpFramesOwner;
    readonly #page: Page;
    readonly #context: BrowserContext;
    readonly #pageId: string;
    readonly #limits: Required<CdpFramesLimits>;
    readonly #records = new Map<string, FrameRecord>();
    readonly #live = new Map<Frame, FrameRecord>();
    readonly #evicted = new Set<string>();
    #root: Frame | null = null;
    #mainId: string | null = null;
    #revision = 0;
    #capacityRejections = 0;
    #evictions = 0;
    #disposed = false;
    #seeded = false;
    #untrackedPossible = true;
    constructor(owner: CdpFramesOwner, limits: CdpFramesLimits = {}) {
        if (!owner || typeof owner.pageId !== 'string' || !owner.pageId || owner.pageId.length > 256 || owner.page.isClosed())
            throw new CdpFramesError('PAGE_UNAVAILABLE', 'An exact live owned Page and bounded pageId are required.');
        this.#owner = owner; this.#page = owner.page; this.#pageId = owner.pageId; this.#context = owner.page.context();
        this.#limits = CdpFrames.#configure(limits);
    }
    static #configure(input: CdpFramesLimits): Required<CdpFramesLimits> {
        const value = {maxRecords: input.maxRecords ?? 256, maxLiveFrames: input.maxLiveFrames ?? 128,
            maxInventoryFrames: input.maxInventoryFrames ?? 32, maxInventoryChars: input.maxInventoryChars ?? 65536, maxMetadataChars: input.maxMetadataChars ?? 2048};
        for (const [name, number] of Object.entries(value)) {
            const max = name === 'maxMetadataChars' ? 8192 : name.endsWith('Chars') ? 262144 : 1024, min = name === 'maxInventoryChars' ? 4096 : 1;
            if (!Number.isSafeInteger(number) || number < min || number > max) throw new CdpFramesError('INVALID_LIMIT', `${name} must be an integer in ${min}..${max}.`);
        }
        if (value.maxLiveFrames > value.maxRecords || value.maxInventoryFrames > value.maxRecords)
            throw new CdpFramesError('INVALID_LIMIT', 'Live/inventory frame limits cannot exceed retained records.');
        return Object.freeze(value);
    }
    #assertOwner(pageId = this.#pageId, live = false): void {
        if (pageId !== this.#pageId || this.#owner.pageId !== this.#pageId || this.#owner.page !== this.#page || this.#page.context() !== this.#context)
            throw new CdpFramesError('PAGE_IDENTITY_CHANGED', 'Only the exact owning Page/pageId/context is supported.');
        if (live && this.#disposed) throw new CdpFramesError('DISPOSED', 'Frame registry is disposed.');
        if (live && this.#page.isClosed()) throw new CdpFramesError('PAGE_CLOSED', 'Owned Page is closed.');
    }
    #assertFrame(frame: Frame): void {
        this.#assertOwner();
        if (frame.page() !== this.#page) throw new CdpFramesError('FRAME_FOREIGN_PAGE', 'Frame belongs to another Page; no fallback.');
    }
    #metadata(record: FrameRecord, frame: Frame): void {
        const url = frame.url(), name = frame.name(), chars = this.#limits.maxMetadataChars;
        record.url = url.slice(0, chars); record.name = name.slice(0, Math.min(chars, 256));
        record.truncated = url.length > record.url.length || name.length > record.name.length;
    }
    #room(): boolean {
        if (this.#live.size >= this.#limits.maxLiveFrames) return false;
        if (this.#records.size < this.#limits.maxRecords) return true;
        const victim = [...this.#records.values()].find(record => record.frame === null && record.id !== this.#mainId);
        if (!victim) return false;
        this.#records.delete(victim.id); this.#evicted.add(victim.id); this.#evictions++;
        if (this.#evicted.size > this.#limits.maxRecords) this.#evicted.delete(this.#evicted.values().next().value!);
        return true;
    }
    #register(frame: Frame, parentId: string | null, main: boolean): FrameRecord | null {
        const existing = this.#live.get(frame); if (existing) return existing;
        if (this.#disposed || this.#page.isClosed() || frame.isDetached()) return null;
        if (!this.#room()) {this.#capacityRejections++; this.#untrackedPossible = true; return null;}
        const now = new Date().toISOString();
        const record: FrameRecord = {id: randomUUID(), frame, parentId, main, state: 'available', lifecycle: 'attached', url: '', name: '', truncated: false,
            documentId: null, documentAt: null, attachedAt: now, updatedAt: now, detachedAt: null, reason: null, revision: ++this.#revision};
        this.#metadata(record, frame); this.#records.set(record.id, record); this.#live.set(frame, record); return record;
    }
    #main(): FrameRecord | null {
        const current = this.#page.mainFrame();
        if (this.#root && this.#root !== current && this.#mainId) this.#detachTree(this.#mainId, 'MAIN_FRAME_REPLACED');
        this.#root = current;
        const record = this.#live.get(current) ?? this.#register(current, null, true);
        if (record) this.#mainId = record.id; return record;
    }
    #ensure(frame: Frame, depth = 0): FrameRecord | null {
        this.#assertFrame(frame);
        if (depth >= this.#limits.maxRecords || frame.isDetached()) return null;
        const main = this.#main(); if (frame === this.#root) return main;
        const existing = this.#live.get(frame); if (existing) return existing;
        const parent = frame.parentFrame(); if (!parent) return null;
        const parentRecord = this.#ensure(parent, depth + 1); return parentRecord ? this.#register(frame, parentRecord.id, false) : null;
    }
    seed() {
        this.#assertOwner(this.#pageId, true); this.#main();
        const frames = this.#page.frames(); let scanned = 0;
        for (const frame of frames) {if (scanned++ >= this.#limits.maxRecords) break; this.#ensure(frame);}
        this.#seeded = true; this.#untrackedPossible = frames.some(frame => !this.#live.has(frame));
        return {scannedFrames: Math.min(scanned, this.#limits.maxRecords), observedPageFrames: frames.length,
            truncated: frames.length > this.#live.size, ...this.describe()};
    }
    #capture(frame: Frame, navigated: boolean) {
        this.#assertOwner(this.#pageId, true); this.#assertFrame(frame);
        const known = this.#live.has(frame), record = this.#ensure(frame);
        if (!record) {if (!frame.isDetached()) this.#untrackedPossible = true; return {accepted: false, isNew: false, frameId: null, reason: frame.isDetached() ? 'FRAME_DETACHED' : 'FRAME_CAPACITY_OR_PARENT_UNAVAILABLE'};}
        if (navigated) {this.#metadata(record, frame); record.lifecycle = 'navigated'; record.revision = ++this.#revision; record.updatedAt = new Date().toISOString();}
        return {accepted: true, isNew: !known, frameId: record.id, reason: null, revision: record.revision};
    }
    captureAttached(frame: Frame) {return this.#capture(frame, false);}
    captureNavigated(frame: Frame) {return this.#capture(frame, true);}
    #detachTree(id: string, reason: string): void {
        const ids = new Set([id]);
        for (let pass = 0; pass < this.#limits.maxRecords; pass++) {
            let added = false;
            for (const record of this.#records.values()) if (record.parentId && ids.has(record.parentId) && !ids.has(record.id)) {ids.add(record.id); added = true;}
            if (!added) break;
        }
        for (const childId of ids) {
            const record = this.#records.get(childId); if (!record || record.frame === null) continue;
            this.#metadata(record, record.frame); this.#live.delete(record.frame); record.frame = null;
            record.state = 'detached'; record.lifecycle = 'detached'; record.reason = reason;
            record.updatedAt = record.detachedAt = new Date().toISOString(); record.revision = ++this.#revision;
        }
    }
    captureDetached(frame: Frame) {
        this.#assertFrame(frame); const record = this.#live.get(frame);
        if (!record) return {accepted: false, frameId: null, reason: 'ALREADY_DETACHED_OR_UNRETAINED'};
        if (!frame.isDetached() && !this.#page.isClosed()) throw new CdpFramesError('FRAME_STILL_LIVE', 'A detach delegate must correspond to actual public frame/Page detachment.');
        this.#detachTree(record.id, 'FRAME_DETACHED'); return {accepted: true, frameId: record.id, reason: null, revision: record.revision};
    }
    capturePageClosed(): void {
        this.#assertOwner(); if (!this.#page.isClosed()) throw new CdpFramesError('PAGE_STILL_LIVE', 'Page closure must be observed before marking frames closed.');
        for (const record of this.#records.values()) if (record.frame) this.#detachTree(record.id, 'PAGE_CLOSED');
    }
    idFor(frame: Frame): string | null {this.#assertFrame(frame); return this.#live.get(frame)?.id ?? null;}
    mainFrameId(): string {
        this.#assertOwner(this.#pageId, true); const main = this.#main();
        if (!main) throw new CdpFramesError('FRAME_CAPACITY', 'Main frame could not be retained.'); return main.id;
    }
    #lookup(frameId: string): FrameRecord {
        const record = this.#records.get(frameId);
        if (!record) throw new CdpFramesError(this.#evicted.has(frameId) ? 'FRAME_EVICTED' : 'FRAME_UNKNOWN_OR_FOREIGN', 'FrameId is not retained by this exact Page registry.');
        if (record.frame?.isDetached()) this.#detachTree(record.id, 'FRAME_DETACHED');
        if (!record.frame || record.state !== 'available') throw new CdpFramesError(record.state === 'detached' ? 'FRAME_DETACHED' : 'FRAME_UNAVAILABLE', 'Exact retained frame is not live; no main-frame fallback.');
        this.#assertFrame(record.frame); return record;
    }
    /** INTERNAL core-owner API. Never place this return value in tool JSON. */
    internalFrame(frameId: string): Frame {this.#assertOwner(this.#pageId, true); return this.#lookup(frameId).frame!;}
    #descriptor(record: FrameRecord): CdpFrameDescriptor {
        return {pageId: this.#pageId, frameId: record.id, parentFrameId: record.parentId, isMain: record.main, state: record.state,
            lifecycleState: record.lifecycle, url: record.url, name: record.name, metadataTruncated: record.truncated,
            documentId: null, documentState: 'unavailable', documentError: record.reason ?? 'NOT_READ', lastKnownDocumentId: record.documentId,
            lastDocumentObservedAtUtc: record.documentAt, attachedAtUtc: record.attachedAt, updatedAtUtc: record.updatedAt, detachedAtUtc: record.detachedAt,
            unavailableReason: record.reason, revision: record.revision, changedDuringRead: false, nativeFrameId: null, networkContextId: null};
    }
    async #sample(record: FrameRecord): Promise<CdpFrameDescriptor> {
        if (record.frame?.isDetached()) this.#detachTree(record.id, 'FRAME_DETACHED');
        const descriptor = this.#descriptor(record), frame = record.frame, revision = record.revision;
        if (!frame || this.#disposed || this.#page.isClosed()) return descriptor;
        this.#metadata(record, frame); let id: string | null = null, error: string | null = null;
        try {
            if (!this.#owner.getDocumentId) error = 'DOCUMENT_PROVIDER_UNAVAILABLE';
            else {id = await this.#owner.getDocumentId(frame); if (id === null) error = 'DOCUMENT_UNAVAILABLE';
                else if (typeof id !== 'string' || !id || id.length > 256) {id = null; error = 'DOCUMENT_ID_INVALID_OR_OVERSIZE';}}
        } catch {error = 'DOCUMENT_PROVIDER_FAILED';}
        this.#assertOwner();
        if (frame.isDetached() || this.#page.isClosed()) this.#detachTree(record.id, this.#page.isClosed() ? 'PAGE_CLOSED' : 'FRAME_DETACHED');
        const changed = record.revision !== revision || record.frame !== frame || this.#disposed;
        if (changed) return {...this.#descriptor(record), documentState: 'changedDuringRead', documentError: 'FRAME_CHANGED_DURING_READ', changedDuringRead: true};
        if (id !== null) {record.documentId = id; record.documentAt = new Date().toISOString();}
        return {...this.#descriptor(record), documentId: id, documentState: id === null ? 'unavailable' : 'verified', documentError: error};
    }
    async resolve(request: CdpFrameRequest): Promise<CdpFrameSelection> {
        this.#assertOwner(request.pageId, true);
        const id = request.frameId == null ? this.mainFrameId() : request.frameId;
        if (typeof id !== 'string' || !id || id.length > 256) throw new CdpFramesError('INVALID_FRAME_ID', 'An explicit FrameId must be a nonempty bounded string.');
        const expected = request.expectedDocumentId ?? null;
        if (expected !== null && (typeof expected !== 'string' || !expected || expected.length > 256)) throw new CdpFramesError('INVALID_DOCUMENT_ID', 'Expected document identity must be a nonempty bounded string.');
        const record = this.#lookup(id), descriptor = await this.#sample(record); this.#assertOwner(request.pageId, true);
        if (descriptor.changedDuringRead) throw new CdpFramesError('FRAME_CHANGED_DURING_READ', 'Frame navigated/detached while its owner document proof was read.');
        this.#lookup(id);
        if (expected !== null && descriptor.documentId === null) throw new CdpFramesError('DOCUMENT_UNAVAILABLE', 'Expected-document validation cannot succeed without exact owner proof.');
        if (expected !== null && descriptor.documentId !== expected) throw new CdpFramesError('STALE_DOCUMENT', 'Expected document does not match the owner-proved document in this exact Frame.');
        return new CdpFrameSelection(this, descriptor);
    }
    async inventory(options: {pageId: string; maxFrames?: number; includeDetached?: boolean}) {
        this.#assertOwner(options.pageId); if (this.#page.isClosed()) this.capturePageClosed();
        const max = options.maxFrames ?? this.#limits.maxInventoryFrames;
        if (!Number.isSafeInteger(max) || max < 1 || max > this.#limits.maxInventoryFrames) throw new CdpFramesError('INVALID_LIMIT', 'maxFrames exceeds the configured inventory bound.');
        if (options.includeDetached !== undefined && typeof options.includeDetached !== 'boolean') throw new CdpFramesError('INVALID_LIMIT', 'includeDetached must be boolean.');
        const start = this.#revision, records = [...this.#records.values()].filter(record => options.includeDetached !== false || record.state === 'available');
        records.sort((a, b) => Number(b.state === 'available') - Number(a.state === 'available'));
        const frames: CdpFrameDescriptor[] = []; let chars = 1024;
        for (const record of records) {
            if (frames.length >= max) break; const item = await this.#sample(record), length = JSON.stringify(item).length + 1;
            if (chars + length > this.#limits.maxInventoryChars) break; frames.push(item); chars += length;
        }
        const result = {pageId: this.#pageId, frames, framesTruncated: frames.length < records.length || this.#untrackedPossible, untrackedFramesPossible: this.#untrackedPossible, seeded: this.#seeded, retainedRecords: this.#records.size,
            liveFrames: this.#live.size, omittedRetainedRecords: records.length - frames.length, capacityRejections: this.#capacityRejections,
            startRevision: start, endRevision: this.#revision, changedDuringRead: start !== this.#revision || frames.some(frame => frame.changedDuringRead),
            snapshotAtomic: false, nativeFrameMapping: 'unavailable', documentAuthority: 'owner.getDocumentId(exactFrame)', disposed: this.#disposed};
        if (JSON.stringify(result).length > this.#limits.maxInventoryChars) throw new CdpFramesError('INVENTORY_LIMIT', 'Inventory metadata exceeded its configured serialized bound.');
        return result;
    }
    describe() {
        return {pageId: this.#pageId, disposed: this.#disposed, liveFrames: this.#live.size, retainedRecords: this.#records.size,
            mainFrameId: this.#mainId, revision: this.#revision, evictions: this.#evictions, evictionHistorySize: this.#evicted.size,
            capacityRejections: this.#capacityRejections, seeded: this.#seeded, untrackedFramesPossible: this.#untrackedPossible, limits: {...this.#limits}, listenersInstalled: 0,
            documentAuthority: 'owner only; none minted', nativeFrameMapping: 'unavailable', oopifProcessIsolationMeasured: false};
    }
    dispose(): void {
        if (this.#disposed) return; this.#assertOwner(); this.#disposed = true;
        for (const record of this.#records.values()) if (record.frame) {record.frame = null; record.state = 'unavailable'; record.reason = 'REGISTRY_DISPOSED'; record.revision = ++this.#revision;}
        this.#live.clear(); this.#root = null;
    }
}
