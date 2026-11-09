import type { Browser, BrowserContext, CDPSession, Page } from 'playwright-core';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, lstatSync, mkdirSync, opendirSync, rmdirSync, unlinkSync } from 'node:fs';
import path from 'node:path';

export type CdpDownloadPolicy = 'capture' | 'deny';

export interface CdpDownloadLimits {
    maxRecords: number;
    maxConcurrent: number;
    maxFileBytes: number;
    maxRetainedBytes: number;
    maxPages: number;
    maxFramesPerPage: number;
    maxMetadataChars: number;
    commandTimeoutMs: number;
}

export interface CdpDownloadOwner {
    browser: Browser;
    context: BrowserContext;
    anchorPage: Page;
    stagingDirectory: string;
    captureDownloadEvent(event: CdpDownloadEvent): void;
}

/** INTERNAL core proof, bound to the exact owner references; never model/tool input. */
export interface CdpDownloadOwnerShutdown {
    readonly browser: Browser;
    readonly context: BrowserContext;
    readonly browserExited: boolean;
    readonly hostExited: boolean;
}

export interface CdpDownloadMetadata {
    downloadId: string;
    state: string;
    nativeState?: string;
    url: string;
    suggestedFilename: string;
    metadataTruncated: boolean;
    receivedBytes: number;
    expectedBytes: number | null;
    sizeBytes: number | null;
    sha256: string | null;
    mimeType: null;
    artifactId: null;
    pageId: string | null;
    frameId: null;
    documentId: null;
    networkRequestId: null;
    startedAtUtc: string;
    updatedAtUtc: string;
    error: string | null;
    retention: 'nativeTransfer' | 'staged' | 'claimed' | 'adopted' | 'unavailable';
    source: { nativeGuid: string; nativeFrameId: string; nativeBrowserContextId: string };
}

export interface CdpDownloadEvent {
    kind: 'download';
    state: 'started' | 'progress' | 'completed' | 'failed';
    data: CdpDownloadMetadata;
}

export interface CdpCompletedDownload {
    downloadId: string;
    /** INTERNAL owner-only local path. Never serialize this as an artifact URL. */
    filePath: string;
    sizeBytes: number;
    sha256: string;
    suggestedFilename: string;
}

type Begin = { guid: string; frameId: string; url: string; suggestedFilename: string };
type Progress = { guid: string; totalBytes: number; receivedBytes: number; state: string; filePath?: string };
type Entry = { data: CdpDownloadMetadata; reserved: boolean; finishing: boolean; cancelSent: boolean; cancelReason: string | null; work: Promise<void> | null; cancelWork: Promise<void> | null };
type PendingBegin = { begin: Begin; latest: Progress | null };

/** One authoritative native GUID stream for one exclusively owned Chromium context. */
export class CdpDownloads {
    readonly limits: Readonly<CdpDownloadLimits>;
    readonly policy: CdpDownloadPolicy;
    readonly stagingDirectory: string;
    #owner: CdpDownloadOwner;
    #session: CDPSession | null = null;
    #contextId = '';
    #instance = randomUUID();
    #entries = new Map<string, Entry>();
    #evicted = new Set<string>();
    #pages = new Map<Page, CdpDownloadPageScope>();
    #pending = new Map<string, PendingBegin>();
    #work = new Set<Promise<void>>();
    #closed = false;
    #disposed = false;
    #accepting = false;
    #fault: string | null = null;
    #ignored = 0;
    #evictionCount = 0;
    #unrecorded = 0;
    #overflowCancel: Promise<void> | null = null;
    #rootIdentity: { dev: number; ino: number };
    #beginListener = (event: Begin) => this.#begin(event);
    #progressListener = (event: Progress) => this.#progress(event);
    #closeListener = () => { this.#closed = true; this.#accepting = false; };
    #pageListener = (page: Page) => this.#track(this.registerPage(page).then(() => {}));

    private constructor(owner: CdpDownloadOwner, limits: Partial<CdpDownloadLimits>, policy: CdpDownloadPolicy) {
        if (policy !== 'capture' && policy !== 'deny') throw new Error('Unsupported download policy.');
        this.policy = policy; this.#owner = owner;
        this.limits = this.#validateLimits(limits);
        this.#validateOwner();
        this.stagingDirectory = path.join(path.resolve(owner.stagingDirectory), 'cdp-downloads-' + randomUUID());
        mkdirSync(this.stagingDirectory, { mode: 0o700 });
        const root = lstatSync(this.stagingDirectory);
        this.#rootIdentity = { dev: root.dev, ino: root.ino };
    }

    static async create(owner: CdpDownloadOwner, limits: Partial<CdpDownloadLimits> = {}, policy: CdpDownloadPolicy = 'capture'): Promise<CdpDownloads> {
        const helper = new CdpDownloads(owner, limits, policy);
        try { await helper.#initialize(); return helper; }
        catch (error) { await helper.#failedInitialization(); throw error; }
    }

    #validateLimits(supplied: Partial<CdpDownloadLimits>): Readonly<CdpDownloadLimits> {
        const values = { maxRecords: 64, maxConcurrent: 4, maxFileBytes: 64 * 1024 * 1024,
            maxRetainedBytes: 256 * 1024 * 1024, maxPages: 16, maxFramesPerPage: 256,
            maxMetadataChars: 4096, commandTimeoutMs: 5000, ...supplied };
        for (const [key, value] of Object.entries(values)) {
            if (!Number.isSafeInteger(value) || value < 1) throw new Error('Invalid download limit: ' + key);
        }
        if (values.maxRecords < 4 || values.maxRecords > 1024 || values.maxConcurrent > values.maxRecords - 2 ||
            values.maxFileBytes > 1024 * 1024 * 1024 || values.maxRetainedBytes < values.maxFileBytes ||
            values.maxRetainedBytes > 4 * 1024 * 1024 * 1024 || values.maxPages > 128 ||
            values.maxFramesPerPage > 2048 || values.maxMetadataChars > 16384 || values.commandTimeoutMs > 30000)
            throw new Error('Unsupported download limits.');
        return Object.freeze(values);
    }

    #validateOwner(): void {
        const { browser, context, anchorPage, stagingDirectory } = this.#owner;
        if (context.browser() !== browser || anchorPage.context() !== context || anchorPage.isClosed() || !browser.isConnected())
            throw new Error('Download owner must supply its exact live browser/context/page.');
        if (!path.isAbsolute(stagingDirectory)) throw new Error('Download staging parent must be absolute.');
        const parent = lstatSync(stagingDirectory);
        if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error('Download staging parent must be an owned directory.');
    }

    async #initialize(): Promise<void> {
        this.#session = await this.#owner.browser.newBrowserCDPSession();
        await this.registerPage(this.#owner.anchorPage);
        this.#session.on('Browser.downloadWillBegin', this.#beginListener);
        this.#session.on('Browser.downloadProgress', this.#progressListener);
        this.#owner.context.on('close', this.#closeListener);
        this.#owner.context.on('page', this.#pageListener);
        for (const page of this.#owner.context.pages()) await this.registerPage(page);
        await this.#setBehavior(this.policy === 'deny' ? 'deny' : 'allowAndName');
        this.#accepting = this.policy === 'capture';
    }

    /** Await before navigating a newly owned page. Logical labels are optional, never guessed. */
    async registerPage(page: Page, pageId: string | null = null): Promise<void> {
        if (this.#disposed || this.#closed || page.context() !== this.#owner.context || page.isClosed())
            throw new Error('Cannot register this download page.');
        const current = this.#pages.get(page);
        if (current) { await current.ready; current.pageId = pageId ?? current.pageId; return; }
        if (this.#pages.size >= this.limits.maxPages) throw new Error('Download page observation limit reached.');
        const scope = new CdpDownloadPageScope(this, page, pageId);
        this.#pages.set(page, scope);
        await scope.ready;
    }

    /** Internal page-scope handshake, always from a session on the exact owned Page. */
    acceptContextId(contextId: string): void {
        if (!contextId || (this.#contextId && this.#contextId !== contextId)) throw new Error('Native download context is unavailable/mismatched.');
        this.#contextId = contextId;
    }

    pageClosed(page: Page): void { this.#pages.delete(page); }
    observationFailed(error: unknown): void { this.#track(this.#block('OBSERVATION_FAILED: ' + this.#error(error))); }

    async #setBehavior(behavior: 'deny' | 'allowAndName'): Promise<void> {
        if (!this.#session || !this.#contextId) throw new Error('Exact download browserContextId required.');
        await this.#session.send('Browser.setDownloadBehavior', { behavior, browserContextId: this.#contextId,
            ...(behavior === 'allowAndName' ? { downloadPath: this.stagingDirectory } : {}), eventsEnabled: true },
            { timeout: this.limits.commandTimeoutMs });
    }

    #begin(event: Begin): void {
        if (this.#disposed || this.#closed || !this.#validGuid(event.guid) || this.#entries.has(event.guid) || this.#pending.has(event.guid)) return;
        const scope = [...this.#pages.values()].find(page => page.hasFrame(event.frameId));
        if (scope) { this.#admit(event, scope.pageId); return; }
        if (this.#pending.size >= this.limits.maxConcurrent) {
            this.#ignored++;
            if (!this.#fault) this.#track(this.#block('DOWNLOAD_OWNERSHIP_CHECK_CAPACITY'));
            return;
        }
        const pending = { begin: { ...event, url: event.url.slice(0, this.limits.maxMetadataChars),
            suggestedFilename: event.suggestedFilename.slice(0, this.limits.maxMetadataChars) }, latest: null };
        this.#pending.set(event.guid, pending);
        this.#track(this.#resolveUnknownFrame(pending));
    }

    async #resolveUnknownFrame(pending: PendingBegin): Promise<void> {
        try {
            let target;
            try { target = await this.#session!.send('Target.getTargetInfo', { targetId: pending.begin.frameId }, { timeout: this.limits.commandTimeoutMs }); }
            catch {
                this.#ignored++;
                await this.#block('DOWNLOAD_FRAME_CONTEXT_UNAVAILABLE');
                return;
            }
            if (target.targetInfo.browserContextId !== this.#contextId) { this.#ignored++; return; }
            this.#admit(pending.begin, null);
            if (pending.latest) this.#progress(pending.latest);
        } finally { this.#pending.delete(pending.begin.guid); }
    }

    #admit(begin: Begin, pageId: string | null): void {
        if (this.#closed || this.#disposed || this.#entries.has(begin.guid)) return;
        if (!this.#makeRoom()) {
            this.#unrecorded++;
            if (!this.#overflowCancel) {
                this.#overflowCancel = this.#rejectUnrecorded(begin.guid).finally(() => { this.#overflowCancel = null; });
                this.#track(this.#overflowCancel);
            }
            return;
        }
        const timestamp = new Date().toISOString(), chars = this.limits.maxMetadataChars;
        const data: CdpDownloadMetadata = { downloadId: 'download-' + this.#instance + '-' + begin.guid,
            state: 'started', url: begin.url.slice(0, chars), suggestedFilename: begin.suggestedFilename.slice(0, chars),
            metadataTruncated: begin.url.length > chars || begin.suggestedFilename.length > chars,
            receivedBytes: 0, expectedBytes: null, sizeBytes: null, sha256: null, mimeType: null, artifactId: null,
            pageId, frameId: null, documentId: null, networkRequestId: null, startedAtUtc: timestamp, updatedAtUtc: timestamp,
            error: null, retention: 'nativeTransfer', source: { nativeGuid: begin.guid, nativeFrameId: begin.frameId, nativeBrowserContextId: this.#contextId } };
        const entry: Entry = { data, reserved: false, finishing: false, cancelSent: false, cancelReason: null, work: null, cancelWork: null };
        const reason = this.policy === 'deny' ? null : !this.#accepting ? 'CAPTURE_BLOCKED' : this.#activeCount() >= this.limits.maxConcurrent ? 'CONCURRENT_LIMIT' :
            this.#reservedBytes() + this.limits.maxFileBytes > this.limits.maxRetainedBytes ? 'RETAINED_BYTES_LIMIT' : null;
        entry.reserved = this.policy === 'capture' && !reason;
        this.#entries.set(begin.guid, entry);
        this.#emit(entry, 'started');
        if (reason) this.#requestCancel(entry, reason);
    }

    #makeRoom(): boolean {
        if (this.#entries.size < this.limits.maxRecords) return true;
        const victim = [...this.#entries.values()].find(entry => !entry.reserved && !entry.finishing && !entry.cancelWork && !entry.work && entry.data.retention !== 'claimed' && entry.data.retention !== 'nativeTransfer');
        if (!victim) return false;
        try { this.#deleteFiles(victim.data.source.nativeGuid); }
        catch (error) { this.observationFailed(error); return false; }
        this.#entries.delete(victim.data.source.nativeGuid);
        this.#evicted.add(victim.data.downloadId); this.#evictionCount++;
        if (this.#evicted.size > this.limits.maxRecords) this.#evicted.delete(this.#evicted.values().next().value!);
        return true;
    }

    #progress(event: Progress): void {
        if (this.#disposed) return;
        const entry = this.#entries.get(event.guid);
        if (!entry) { const pending = this.#pending.get(event.guid); if (pending) pending.latest = { ...event }; return; }
        if (entry.finishing || entry.data.retention !== 'nativeTransfer') return;
        // Chrome can reset receivedBytes to zero in its final canceled event.
        entry.data.receivedBytes = Math.max(entry.data.receivedBytes, this.#bytes(event.receivedBytes));
        if (event.totalBytes > 0) entry.data.expectedBytes = this.#bytes(event.totalBytes);
        entry.data.updatedAtUtc = new Date().toISOString();
        entry.data.nativeState = event.state.slice(0, 32);
        if (event.state === 'completed' || event.state === 'canceled') {
            entry.finishing = true;
            entry.work = this.#finish(entry, event);
            this.#track(entry.work); return;
        }
        if (this.policy === 'capture' && (entry.data.receivedBytes > this.limits.maxFileBytes || (entry.data.expectedBytes ?? 0) > this.limits.maxFileBytes))
            this.#requestCancel(entry, 'FILE_SIZE_LIMIT');
        if (!entry.cancelSent) entry.data.state = 'progress';
        this.#emit(entry, 'progress');
    }

    #requestCancel(entry: Entry, reason: string): void {
        if (entry.cancelSent) return;
        entry.cancelSent = true; entry.cancelReason = reason; entry.data.state = 'cancelling'; entry.data.error = reason;
        entry.cancelWork = this.#cancelNative(entry).finally(() => { entry.cancelWork = null; });
        this.#track(entry.cancelWork);
    }

    async #cancelNative(entry: Entry): Promise<void> {
        try { await this.#session!.send('Browser.cancelDownload', { guid: entry.data.source.nativeGuid, browserContextId: this.#contextId }, { timeout: this.limits.commandTimeoutMs }); }
        catch (error) {
            if (entry.data.retention === 'nativeTransfer' && !entry.finishing) {
                entry.data.error = 'CANCEL_UNCERTAIN: ' + this.#error(error);
                await this.#block(entry.data.error);
            }
        }
    }

    async #rejectUnrecorded(guid: string): Promise<void> {
        await this.#block('METADATA_CAPACITY_EXHAUSTED');
        await this.#session!.send('Browser.cancelDownload', { guid, browserContextId: this.#contextId }, { timeout: this.limits.commandTimeoutMs });
    }

    async #finish(entry: Entry, event: Progress): Promise<void> {
        try {
            if (this.policy === 'deny') {
                entry.data.state = 'unavailable'; entry.data.retention = 'unavailable';
                entry.data.error = event.state === 'canceled' ? 'NATIVE_DOWNLOAD_CANCELED' : 'DENY_POLICY_NATIVE_COMPLETION';
                this.#deleteFiles(event.guid);
            } else if (entry.cancelReason || event.state === 'canceled') {
                entry.data.state = entry.cancelReason === 'FILE_SIZE_LIMIT' ? 'oversize' : entry.cancelReason === 'OWNER_CANCELLED' ? 'cancelled' : 'failed';
                entry.data.error = entry.cancelReason ?? 'NATIVE_DOWNLOAD_CANCELED';
                entry.data.retention = 'unavailable'; this.#deleteFiles(event.guid);
            } else await this.#verifyFile(entry, event);
        } catch (error) {
            entry.data.state = 'unavailable'; entry.data.error = 'STAGING_UNAVAILABLE: ' + this.#error(error); entry.data.retention = 'unavailable';
            try { this.#deleteFiles(event.guid); } catch (cleanupError) { await this.#block('CLEANUP_FAILED: ' + this.#error(cleanupError)); }
        } finally {
            entry.reserved = false; entry.finishing = false; entry.work = null;
            entry.data.updatedAtUtc = new Date().toISOString();
            this.#emit(entry, entry.data.state === 'completed' ? 'completed' : 'failed');
        }
    }

    async #verifyFile(entry: Entry, event: Progress): Promise<void> {
        entry.data.state = 'verifying';
        const filePath = this.#file(event.guid), before = lstatSync(filePath);
        if (event.filePath && path.resolve(event.filePath) !== filePath) throw new Error('Native completed path did not match GUID destination.');
        if (!before.isFile() || before.isSymbolicLink()) throw new Error('Native staging result is not a regular file.');
        if (before.size > this.limits.maxFileBytes || this.#stagedBytes() + before.size > this.limits.maxRetainedBytes) {
            entry.data.state = 'oversize'; entry.data.error = 'FILE_SIZE_LIMIT'; entry.data.retention = 'unavailable'; this.#deleteFiles(event.guid); return;
        }
        const hash = createHash('sha256'); let bytes = 0;
        for await (const chunk of createReadStream(filePath, { highWaterMark: 65536 })) {
            bytes += chunk.length;
            if (bytes > this.limits.maxFileBytes) throw new Error('Staging file grew beyond size limit.');
            hash.update(chunk);
        }
        const after = lstatSync(filePath);
        if (bytes !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ino !== before.ino || !after.isFile())
            throw new Error('Staging file changed during verification.');
        entry.data.sizeBytes = bytes; entry.data.sha256 = hash.digest('hex');
        entry.data.state = 'completed'; entry.data.retention = 'staged'; entry.data.error = null;
    }

    describe(downloadId: string): CdpDownloadMetadata | { downloadId: string; state: 'unknown' | 'evicted'; reason: string } {
        const entry = this.#find(downloadId);
        return entry ? structuredClone(entry.data) : { downloadId, state: this.#evicted.has(downloadId) ? 'evicted' : 'unknown',
            reason: this.#evicted.has(downloadId) ? 'METADATA_EVICTED' : 'DOWNLOAD_NOT_OBSERVED' };
    }

    list(): CdpDownloadMetadata[] { return [...this.#entries.values()].map(entry => structuredClone(entry.data)); }

    status() {
        return { policy: this.policy, nativeBrowserContextId: this.#contextId, denialEventCoverage: 'only observed native events; denial may be silent', applicationCancellationClaimed: false, disposed: this.#disposed, contextClosed: this.#closed, accepting: this.#accepting, fault: this.#fault,
            retainedRecords: this.#entries.size, activeTransfers: this.#activeCount(), stagedBytes: this.#stagedBytes(),
            pendingHelperOperations: this.#work.size, requiresContextClose: this.#fault !== null,
            reservedBytes: this.#reservedBytes(), observedPages: this.#pages.size, pendingOwnershipChecks: this.#pending.size,
            ignoredUnknownOrOtherContextBegins: this.#ignored, unrecordedCapacityRejections: this.#unrecorded,
            evictionCount: this.#evictionCount, evictionHistorySize: this.#evicted.size, limits: this.limits,
            scope: 'exactContext; registeredFrameIds or exact native target context; unknown logical linkage',
            byteGuarantee: 'admission reservation and terminal verification; asynchronous native transfer can transiently overshoot' };
    }

    /** Pins against retention eviction until acknowledgeMoved or releaseCompletedFile. */
    completedFile(downloadId: string): CdpCompletedDownload {
        if (this.policy === 'deny') throw new Error('Denied downloads have no capturable staged file.');
        const entry = this.#require(downloadId);
        if (entry.data.state !== 'completed' || !['staged', 'claimed'].includes(entry.data.retention)) throw new Error('Completed staged download unavailable.');
        entry.data.retention = 'claimed';
        return Object.freeze({ downloadId, filePath: this.#file(entry.data.source.nativeGuid), sizeBytes: entry.data.sizeBytes!,
            sha256: entry.data.sha256!, suggestedFilename: entry.data.suggestedFilename });
    }

    releaseCompletedFile(downloadId: string): void {
        const entry = this.#require(downloadId);
        if (entry.data.retention !== 'claimed') throw new Error('Download is not claimed.');
        entry.data.retention = 'staged';
    }

    acknowledgeMoved(downloadId: string): void {
        const entry = this.#require(downloadId);
        if (entry.data.retention !== 'claimed') throw new Error('Claim completed download before moving.');
        try { lstatSync(this.#file(entry.data.source.nativeGuid)); throw new Error('Original staging file still exists.'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        entry.data.retention = 'adopted';
    }

    async cancel(downloadId: string): Promise<CdpDownloadMetadata> {
        const entry = this.#require(downloadId);
        if (entry.data.retention !== 'nativeTransfer' || entry.finishing) throw new Error('Download is not an active cancellable transfer.');
        this.#requestCancel(entry, 'OWNER_CANCELLED');
        await this.flush();
        return structuredClone(entry.data);
    }

    discard(downloadId: string): CdpDownloadMetadata {
        const entry = this.#require(downloadId);
        if (entry.data.retention === 'nativeTransfer' || entry.finishing || entry.data.retention === 'claimed') throw new Error('Cannot discard an active or claimed download.');
        if (entry.data.retention !== 'adopted') this.#deleteFiles(entry.data.source.nativeGuid);
        entry.data.retention = entry.data.retention === 'adopted' ? 'adopted' : 'unavailable';
        if (entry.data.retention !== 'adopted') { entry.data.state = 'discarded'; entry.data.error = 'OWNER_DISCARDED'; }
        return structuredClone(entry.data);
    }

    /** Waits already scheduled helper work, not native download completion. */
    async flush(): Promise<void> { while (this.#work.size) await Promise.all([...this.#work]); }

    /** Core closes its verified owning host FIRST; a transport disconnect is not physical closure proof. */
    async disposeAfterContextClosed(shutdown?: CdpDownloadOwnerShutdown): Promise<{ disposed: boolean; stagingRemoved: boolean }> {
        if (this.#disposed) return { disposed: true, stagingRemoved: true };
        this.#assertClosedOwner(shutdown);
        this.#closed = true; this.#accepting = false;
        this.#owner.context.off('close', this.#closeListener); this.#owner.context.off('page', this.#pageListener);
        this.#session?.off('Browser.downloadWillBegin', this.#beginListener); this.#session?.off('Browser.downloadProgress', this.#progressListener);
        await this.#flushClosedWork();
        for (const scope of this.#pages.values()) await scope.detach(true);
        this.#pages.clear();
        try { await this.#session?.detach(); }
        catch (error) { if (!CdpDownloads.isClosedSessionError(error)) throw error; }
        this.#session = null;
        if ([...this.#entries.values()].some(entry => entry.data.retention === 'claimed'))
            throw new Error('Completed download is pinned for artifact admission; finish adoption or release the claim before cleanup.');
        this.#cleanRoot();
        for (const entry of this.#entries.values()) {
            entry.reserved = false;
            if (entry.data.retention !== 'adopted') {
                entry.data.retention = 'unavailable'; entry.data.error = 'CONTEXT_CLOSED';
                if (entry.data.state !== 'discarded') entry.data.state = 'unavailable';
            }
        }
        this.#disposed = true;
        return { disposed: true, stagingRemoved: true };
    }

    #assertClosedOwner(shutdown?: CdpDownloadOwnerShutdown): void {
        const {browser, context} = this.#owner;
        if (shutdown) {
            if (shutdown.browser !== browser || shutdown.context !== context || shutdown.browserExited !== true || shutdown.hostExited !== true || browser.isConnected())
                throw new Error('Exact owning browser/host shutdown must be proved after disconnection.');
            return;
        }
        if (!browser.isConnected()) {
            this.#fault ??= 'OWNED_SHUTDOWN_PROOF_REQUIRED'; this.#accepting = false;
            throw new Error('Disconnected transport is not owner shutdown proof; retain staging and provide verified exact browser/host exits.');
        }
        if (!this.#closed) throw new Error('Observe the owned BrowserContext close event before download cleanup, or provide verified exact owner shutdown proof.');
    }

    /** Classification only; never independent evidence of owner closure. */
    static isClosedSessionError(error: unknown): boolean {
        return error instanceof Error && /\b(?:Target page, context or browser has been closed|Target closed|Session closed|Browser has been closed|Browser closed|Connection closed|No session with given id|Session with given id not found)\b/i.test(error.message);
    }

    async #flushClosedWork(): Promise<void> {
        while (this.#work.size) {
            try { await this.flush(); }
            catch (error) { if (!CdpDownloads.isClosedSessionError(error)) throw error; }
        }
    }

    #cleanRoot(): void {
        this.#assertRoot();
        const directory = opendirSync(this.stagingDirectory);
        try { for (let entry = directory.readSync(); entry; entry = directory.readSync()) {
            if (!this.#validGuid(entry.name.replace(/\.crdownload$/, ''))) throw new Error('Unexpected file in owned download staging; cleanup requires owner review.');
            const file = path.join(this.stagingDirectory, entry.name), stat = lstatSync(file);
            if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Unexpected staging entry type.');
            unlinkSync(file);
        } } finally { directory.closeSync(); }
        rmdirSync(this.stagingDirectory);
    }

    async #failedInitialization(): Promise<void> {
        this.#owner.context.off('close', this.#closeListener); this.#owner.context.off('page', this.#pageListener);
        if (this.#contextId) { try { await this.#setBehavior('deny'); } catch {} }
        for (const scope of this.#pages.values()) { try { await scope.detach(); } catch {} }
        try { await this.#session?.detach(); } catch {}
        // Never remove possible live native output after an uncertain policy mutation.
        this.#accepting = false;
    }

    async #block(message: string): Promise<void> {
        const alreadyBlocked = this.#fault !== null;
        this.#fault ??= message.slice(0, this.limits.maxMetadataChars); this.#accepting = false;
        if (!alreadyBlocked && !this.#closed) await this.#setBehavior('deny');
    }

    #track(work: Promise<void>): void {
        this.#work.add(work);
        void work.then(() => this.#work.delete(work), error => {
            this.#work.delete(work);
            if (!this.#fault) this.#track(this.#block('HELPER_WORK_FAILED: ' + this.#error(error)));
            else this.#accepting = false;
        });
    }

    #emit(entry: Entry, state: CdpDownloadEvent['state']): void {
        try { this.#owner.captureDownloadEvent({ kind: 'download', state, data: structuredClone(entry.data) }); }
        catch (error) { this.observationFailed(error); }
    }

    #require(id: string): Entry { const entry = this.#find(id); if (!entry) throw new Error('Unknown or evicted download ID.'); return entry; }
    #find(id: string): Entry | undefined { return [...this.#entries.values()].find(entry => entry.data.downloadId === id); }
    #activeCount(): number { return [...this.#entries.values()].filter(entry => entry.reserved).length; }
    #stagedBytes(): number { return [...this.#entries.values()].reduce((sum, entry) => sum + (['staged', 'claimed'].includes(entry.data.retention) ? entry.data.sizeBytes ?? 0 : 0), 0); }
    #reservedBytes(): number { return this.#stagedBytes() + this.#activeCount() * this.limits.maxFileBytes; }
    #validGuid(guid: string): boolean { return /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(guid); }
    #file(guid: string): string { if (!this.#validGuid(guid)) throw new Error('Invalid native download GUID.'); this.#assertRoot(); return path.resolve(this.stagingDirectory, guid); }
    #bytes(value: number): number { return Number.isFinite(value) && value >= 0 ? Math.min(Number.MAX_SAFE_INTEGER, Math.floor(value)) : 0; }
    #error(error: unknown): string { return String(error instanceof Error ? error.message : error).slice(0, this.limits.maxMetadataChars); }

    #assertRoot(): void {
        const root = lstatSync(this.stagingDirectory);
        if (!root.isDirectory() || root.isSymbolicLink() || root.dev !== this.#rootIdentity.dev || root.ino !== this.#rootIdentity.ino)
            throw new Error('Owned download staging directory changed.');
    }

    #deleteFiles(guid: string): void {
        for (const file of [this.#file(guid), this.#file(guid) + '.crdownload']) {
            try { const stat = lstatSync(file); if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Unexpected staging file type.'); unlinkSync(file); }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        }
    }
}

/** A bounded child scope, never a shared browser/session instrumentation owner. */
class CdpDownloadPageScope {
    readonly ready: Promise<void>;
    pageId: string | null;
    #owner: CdpDownloads;
    #page: Page;
    #session: CDPSession | null = null;
    #frames = new Set<string>();
    #closed = false;
    #attached = (event: { frameId: string }) => this.#add(event.frameId);
    #navigated = (event: { frame: { id: string; parentId?: string } }) => this.#add(event.frame.id);
    #detached = (event: { frameId: string }) => this.#frames.delete(event.frameId);
    #onClose = () => { this.#closed = true; this.#owner.pageClosed(this.#page); void this.detach().catch(error => this.#owner.observationFailed(error)); };

    constructor(owner: CdpDownloads, page: Page, pageId: string | null) {
        this.#owner = owner; this.#page = page; this.pageId = pageId;
        this.ready = this.#initialize();
    }

    async #initialize(): Promise<void> {
        this.#session = await this.#page.context().newCDPSession(this.#page);
        const target = await this.#session.send('Target.getTargetInfo', {}, { timeout: this.#owner.limits.commandTimeoutMs });
        this.#owner.acceptContextId(target.targetInfo.browserContextId ?? '');
        this.#session.on('Page.frameAttached', this.#attached); this.#session.on('Page.frameNavigated', this.#navigated);
        this.#session.on('Page.frameDetached', this.#detached); this.#page.on('close', this.#onClose);
        await this.#session.send('Page.enable', {}, { timeout: this.#owner.limits.commandTimeoutMs });
        const result = await this.#session.send('Page.getFrameTree', {}, { timeout: this.#owner.limits.commandTimeoutMs });
        this.#tree(result.frameTree);
    }

    #tree(tree: { frame: { id: string }; childFrames?: Array<any> }): void {
        this.#add(tree.frame.id);
        for (const child of tree.childFrames ?? []) this.#tree(child);
    }

    #add(frameId: string): void {
        if (this.#frames.has(frameId) || this.#closed) return;
        if (this.#frames.size >= this.#owner.limits.maxFramesPerPage) { this.#owner.observationFailed('Download frame observation limit reached.'); return; }
        this.#frames.add(frameId);
    }

    hasFrame(frameId: string): boolean { return !this.#closed && this.#frames.has(frameId); }

    async detach(closedOwnerProved = false): Promise<void> {
        this.#page.off('close', this.#onClose);
        this.#session?.off('Page.frameAttached', this.#attached); this.#session?.off('Page.frameNavigated', this.#navigated);
        this.#session?.off('Page.frameDetached', this.#detached);
        try { await this.#session?.detach(); }
        catch (error) {
            if (closedOwnerProved ? !CdpDownloads.isClosedSessionError(error) : !this.#page.isClosed()) throw error;
        }
        this.#session = null; this.#frames.clear();
    }
}
