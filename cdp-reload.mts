import type {Page, BrowserContext, Frame, CDPSession} from 'playwright-core';

export type CdpReloadMode = 'general' | 'fixture-guarded';
export type CdpReloadWait = 'commit' | 'domcontentloaded' | 'load';
export interface CdpReloadOwner {
    readonly page: Page;
    readonly pageId: string;
    getDocumentId?(): string | null;
}
export interface CdpReloadLimits {readonly maximumTimeoutMs?: number;}
export interface CdpReloadArguments {
    readonly pageId: string;
    readonly bypassCache?: boolean;
    readonly waitUntil?: CdpReloadWait;
    readonly timeoutMs?: number;
}
export class CdpReloadError extends Error {
    readonly code: string;
    readonly inputDispatched: boolean;
    readonly actionOutcome: 'not-dispatched' | 'uncertain';
    constructor(code: string, message: string, dispatched = false, cause?: unknown) {
        super(message, {cause}); this.name = 'CdpReloadError'; this.code = code;
        this.inputDispatched = dispatched; this.actionOutcome = dispatched ? 'uncertain' : 'not-dispatched';
    }
}
interface NativeDocument {frameId: string; loaderId: string;}
export interface CdpReloadState {
    startedAtUtc: string; dispatchedAtUtc: string | null; inputDispatched: boolean;
    nativeCallSettled: boolean; acknowledged: boolean; finished: boolean; errorCode: string | null;
    callerDeadlineExceeded: boolean; waitUntil: CdpReloadWait; bypassCacheRequested: boolean;
    beforeNative: NativeDocument | null; afterNative: NativeDocument | null;
    observed: {commit: boolean; domcontentloaded: boolean; load: boolean;};
}
interface ReloadWork {
    args: Required<CdpReloadArguments>;
    startedAtUtc: string;
    beforeDocumentId: string | null;
    beforeUrl: string;
    before: NativeDocument | null;
    after: NativeDocument | null;
    preparing: boolean;
    dispatched: boolean;
    dispatchedAtUtc: string | null;
    nativeSettled: boolean;
    acknowledged: boolean;
    callerDeadlineExceeded: boolean;
    finished: boolean;
    errorCode: string | null;
    observed: {commit: boolean; domcontentloaded: boolean; load: boolean;};
    lifecycle: Map<string, Set<string>>;
    completion: Promise<CdpReloadReceipt>;
    result: CdpReloadReceipt | null;
    failure: unknown;
    resolve: (receipt: CdpReloadReceipt) => void;
    reject: (error: unknown) => void;
}
export interface CdpReloadReceipt {
    pageId: string;
    documentId: string | null;
    documentIdSource: string;
    before: {documentId: string | null; url: string; native: NativeDocument;};
    after: {documentId: string | null; url: string; native: NativeDocument;};
    waitUntil: CdpReloadWait;
    observed: {commit: boolean; domcontentloaded: boolean; load: boolean;};
    bypassCacheRequested: boolean;
    effectiveHttpCache: string;
    cacheBypassDistinctionSupported: boolean;
    nativeCall: {method: 'Page.reload'; count: 1; ignoreCache: boolean; acknowledged: true;};
    inputMethod: string;
    inputDispatched: true;
    navigationFinished: true;
    callerDeadlineExceeded: boolean;
    startedAtUtc: string;
    dispatchedAtUtc: string;
    completedAtUtc: string;
    contextRecreated: false;
    cacheSettingsChanged: false;
    businessSuccessVerified: false;
    applicationTransactionCancelled: false;
}

// Exact owned Page, one private public CDPSession. Core supplies the real routing mode and input barrier.
export class CdpReload {
    readonly #owner: CdpReloadOwner;
    readonly #page: Page;
    readonly #pageId: string;
    readonly #context: BrowserContext;
    readonly #main: Frame;
    readonly #session: CDPSession;
    readonly #mode: CdpReloadMode;
    readonly #maximumTimeoutMs: number;
    readonly #onNavigation: (event: any) => void;
    readonly #onLifecycle: (event: any) => void;
    readonly #onClose: () => void;
    readonly #onSessionClose: () => void;
    #active: ReloadWork | null = null;
    #last: CdpReloadState | null = null;
    #disposed = false;
    #disposing = false;
    #sessionClosed = false;
    #reloadCalls = 0;

    private constructor(owner: CdpReloadOwner, mode: CdpReloadMode, session: CDPSession, maximumTimeoutMs: number) {
        this.#owner = owner; this.#page = owner.page; this.#pageId = owner.pageId; this.#context = owner.page.context();
        this.#main = owner.page.mainFrame(); this.#mode = mode; this.#session = session; this.#maximumTimeoutMs = maximumTimeoutMs;
        this.#onNavigation = event => this.#observe(() => this.#navigation(event));
        this.#onLifecycle = event => this.#observe(() => this.#lifecycle(event));
        this.#onClose = () => this.#failActive('PAGE_CLOSED', 'The exact owned Page closed during reload.');
        this.#onSessionClose = () => {this.#sessionClosed = true; this.#failActive('SESSION_CLOSED', 'Owned CDPSession closed; this alone is not proof of physical browser exit.');};
        session.on('Page.frameNavigated', this.#onNavigation); session.on('Page.lifecycleEvent', this.#onLifecycle);
        session.on('close', this.#onSessionClose); this.#page.on('close', this.#onClose);
    }
    static async create(owner: CdpReloadOwner, mode: CdpReloadMode, limits: CdpReloadLimits = {}): Promise<CdpReload> {
        if (!owner?.pageId || owner.page.isClosed()) throw new CdpReloadError('PAGE_UNAVAILABLE', 'An exact live owned Page/pageId is required.');
        if (mode !== 'general' && mode !== 'fixture-guarded') throw new CdpReloadError('CACHE_MODE_REQUIRED', 'Core must explicitly supply the actual general or fixture-guarded mode.');
        const maximum = limits.maximumTimeoutMs ?? 120000;
        if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 120000) throw new CdpReloadError('INVALID_TIMEOUT', 'maximumTimeoutMs must be in 1..120000.');
        const session = await owner.page.context().newCDPSession(owner.page), helper = new CdpReload(owner, mode, session, maximum);
        try {await session.send('Page.enable'); await session.send('Page.setLifecycleEventsEnabled', {enabled: true}); return helper;}
        catch (error) {
            helper.#removeListeners();
            try {await session.detach();} catch (detachError) {if (!owner.page.isClosed() || !this.#closedError(detachError)) throw new AggregateError([error, detachError], 'Reload initialization and own-session cleanup failed.');}
            throw error;
        }
    }
    #assertPage(pageId = this.#pageId): void {
        if (this.#disposed || this.#disposing) throw new CdpReloadError('DISPOSED', 'The reload helper is disposed or disposing.');
        if (pageId !== this.#pageId || this.#owner.pageId !== this.#pageId || this.#owner.page !== this.#page || this.#page.context() !== this.#context || this.#page.mainFrame() !== this.#main)
            throw new CdpReloadError('PAGE_IDENTITY_CHANGED', 'Only the exact original Page/pageId/context/main Frame is supported.');
        if (this.#page.isClosed()) throw new CdpReloadError('PAGE_CLOSED', 'The exact owned Page is closed.');
        if (this.#sessionClosed) throw new CdpReloadError('SESSION_UNAVAILABLE', 'The owned native session is closed; no retry or replacement session was created.');
    }
    #arguments(args: CdpReloadArguments): Required<CdpReloadArguments> {
        this.#assertPage(args.pageId);
        const value = {pageId: args.pageId, bypassCache: args.bypassCache ?? false, waitUntil: args.waitUntil ?? 'domcontentloaded', timeoutMs: args.timeoutMs ?? 30000};
        if (typeof value.bypassCache !== 'boolean' || !['commit', 'domcontentloaded', 'load'].includes(value.waitUntil)) throw new CdpReloadError('INVALID_RELOAD', 'Invalid bypassCache or waitUntil.');
        if (!Number.isSafeInteger(value.timeoutMs) || value.timeoutMs < 1 || value.timeoutMs > this.#maximumTimeoutMs) throw new CdpReloadError('INVALID_TIMEOUT', 'timeoutMs is outside the configured bounds.');
        if (value.bypassCache && this.#mode === 'fixture-guarded') throw new CdpReloadError('CACHE_BYPASS_UNSUPPORTED', 'Explicit fixture routing already disables cache; no differentiated bypass was dispatched.');
        if (this.#active) throw new CdpReloadError('OPERATION_PENDING', 'Retain the existing reload completion; a deadline does not cancel native work or authorize another reload.', this.#active.dispatched);
        return value;
    }
    #work(args: Required<CdpReloadArguments>): ReloadWork {
        let resolve!: ReloadWork['resolve'], reject!: ReloadWork['reject'];
        const completion = new Promise<CdpReloadReceipt>((accept, fail) => {resolve = accept; reject = fail;});
        return {args, completion, resolve, reject, result: null, failure: null, startedAtUtc: new Date().toISOString(), beforeDocumentId: this.#owner.getDocumentId?.() ?? null,
            beforeUrl: this.#page.url().slice(0, 4096), before: null, after: null, preparing: true, dispatched: false, dispatchedAtUtc: null,
            nativeSettled: false, acknowledged: false, callerDeadlineExceeded: false, finished: false, errorCode: null,
            observed: {commit: false, domcontentloaded: false, load: false}, lifecycle: new Map()};
    }
    async reload(args: CdpReloadArguments): Promise<CdpReloadReceipt> {
        const work = this.#work(this.#arguments(args)); this.#active = work;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const deadline = new Promise<never>((_, reject) => {timer = setTimeout(() => {
            work.callerDeadlineExceeded = true;
            const error = new CdpReloadError(work.dispatched ? 'RELOAD_TIMEOUT' : 'TIMEOUT_BEFORE_DISPATCH', 'Reload deadline elapsed. Native work is retained, never cancelled or replayed.', work.dispatched);
            if (!work.dispatched) this.#fail(work, error); reject(error);
        }, work.args.timeoutMs);});
        void this.#dispatch(work);
        try {return await Promise.race([work.completion, deadline]);} finally {if (timer) clearTimeout(timer);}
    }
    async #dispatch(work: ReloadWork): Promise<void> {
        try {
            const tree = await this.#session.send('Page.getFrameTree');
            if (work.finished) return;
            this.#assertPage(work.args.pageId); work.before = this.#native(tree.frameTree.frame);
            if (work.beforeDocumentId !== (this.#owner.getDocumentId?.() ?? null)) throw new CdpReloadError('DOCUMENT_CHANGED_BEFORE_DISPATCH', 'Owner document changed during reload preparation. No reload was dispatched.');
            work.dispatched = true; work.dispatchedAtUtc = new Date().toISOString(); this.#reloadCalls++;
            await this.#session.send('Page.reload', {ignoreCache: work.args.bypassCache, loaderId: work.before.loaderId});
            work.acknowledged = true;
        } catch (error) {this.#fail(work, error instanceof CdpReloadError ? error : new CdpReloadError('RELOAD_NATIVE_ERROR', String(error instanceof Error ? error.message : error).slice(0, 4096), work.dispatched, error));}
        finally {work.preparing = false; work.nativeSettled = true; this.#tryComplete(work); this.#release(work);}
    }
    #native(frame: any): NativeDocument {
        if (!frame || frame.parentId || typeof frame.id !== 'string' || !frame.id || frame.id.length > 512 || typeof frame.loaderId !== 'string' || !frame.loaderId || frame.loaderId.length > 512)
            throw new CdpReloadError('NATIVE_DOCUMENT_UNAVAILABLE', 'Exact page main native frame and nonempty loader proof are required.');
        return {frameId: frame.id, loaderId: frame.loaderId};
    }
    #observe(action: () => void): void {
        try {action();} catch (error) {if (this.#active) this.#fail(this.#active, error);}
    }
    #navigation(event: any): void {
        const work = this.#active;
        if (!work || work.finished || !work.dispatched || !work.before || event.frame?.parentId || event.frame?.id !== work.before.frameId) return;
        const after = this.#native(event.frame); if (after.loaderId === work.before.loaderId) return;
        if (work.after && work.after.loaderId !== after.loaderId) throw new CdpReloadError('NAVIGATION_REPLACED', 'Another main document replaced the observed reload before its requested state.', true);
        work.after = after; work.observed.commit = true; this.#applyLifecycle(work); this.#tryComplete(work);
    }
    #lifecycle(event: any): void {
        const work = this.#active;
        if (!work || work.finished || !work.dispatched || !work.before || event.frameId !== work.before.frameId || event.loaderId === work.before.loaderId || !['DOMContentLoaded', 'load'].includes(event.name)) return;
        if (typeof event.loaderId !== 'string' || !event.loaderId || event.loaderId.length > 512) throw new CdpReloadError('NATIVE_DOCUMENT_UNAVAILABLE', 'Lifecycle loader proof is unavailable.', true);
        let names = work.lifecycle.get(event.loaderId);
        if (!names) {if (work.lifecycle.size >= 8) throw new CdpReloadError('OBSERVATION_LIMIT', 'Reload lifecycle candidate bound exceeded.', true); names = new Set(); work.lifecycle.set(event.loaderId, names);}
        names.add(event.name); this.#applyLifecycle(work); this.#tryComplete(work);
    }
    #applyLifecycle(work: ReloadWork): void {
        if (!work.after) return; const names = work.lifecycle.get(work.after.loaderId);
        work.observed.domcontentloaded = names?.has('DOMContentLoaded') ?? false; work.observed.load = names?.has('load') ?? false;
    }
    #tryComplete(work: ReloadWork): void {
        if (work.finished || !work.acknowledged || !work.before || !work.after || !work.observed[work.args.waitUntil]) return;
        try {
            this.#assertPage(work.args.pageId); let documentId:string|null=null;
            try{documentId=this.#owner.getDocumentId?.()??null;}catch{/* Optional owner sample cannot erase acknowledged native lifecycle completion. */}
            const receipt: CdpReloadReceipt = {pageId: this.#pageId, documentId, documentIdSource: 'owner sample only; core document refresh remains authoritative',
                before: {documentId: work.beforeDocumentId, url: work.beforeUrl, native: {...work.before}}, after: {documentId, url: this.#page.url().slice(0, 4096), native: {...work.after}},
                waitUntil: work.args.waitUntil, observed: {...work.observed}, bypassCacheRequested: work.args.bypassCache,
                effectiveHttpCache: this.#mode === 'general' ? 'browser-managed' : 'disabled by explicit fixture routing', cacheBypassDistinctionSupported: this.#mode === 'general',
                nativeCall: {method: 'Page.reload', count: 1, ignoreCache: work.args.bypassCache, acknowledged: true}, inputMethod: 'public CDP Page.reload', inputDispatched: true, navigationFinished: true,
                callerDeadlineExceeded: work.callerDeadlineExceeded, startedAtUtc: work.startedAtUtc, dispatchedAtUtc: work.dispatchedAtUtc!, completedAtUtc: new Date().toISOString(),
                contextRecreated: false, cacheSettingsChanged: false, businessSuccessVerified: false, applicationTransactionCancelled: false};
            work.finished = true; work.result = receipt; this.#release(work);
        } catch (error) {this.#fail(work, error);}
    }
    #fail(work: ReloadWork, error: unknown): void {
        if (work.finished) return; work.finished = true; work.errorCode = error instanceof CdpReloadError ? error.code : 'OWNER_OR_OBSERVATION_ERROR'; work.failure = error; this.#release(work);
    }
    #failActive(code: string, message: string): void {if (this.#active) this.#fail(this.#active, new CdpReloadError(code, message, this.#active.dispatched));}
    #state(work: ReloadWork) {
        return {startedAtUtc: work.startedAtUtc, dispatchedAtUtc: work.dispatchedAtUtc, inputDispatched: work.dispatched, nativeCallSettled: work.nativeSettled,
            acknowledged: work.acknowledged, finished: work.finished, errorCode: work.errorCode, callerDeadlineExceeded: work.callerDeadlineExceeded,
            waitUntil: work.args.waitUntil, bypassCacheRequested: work.args.bypassCache, beforeNative: work.before ? {...work.before} : null,
            afterNative: work.after ? {...work.after} : null, observed: {...work.observed}};
    }
    #release(work: ReloadWork): void {if (work.finished && work.nativeSettled && !work.preparing && this.#active === work) {this.#last = this.#state(work); this.#active = null; if (work.result) work.resolve(work.result); else work.reject(work.failure);}}
    pendingCompletion(): Promise<CdpReloadReceipt> | null {return this.#active?.completion ?? null;}
    describe(): {pageId: string; mode: CdpReloadMode; disposed: boolean; disposing: boolean; sessionClosed: boolean; busy: boolean; pending: CdpReloadState | null; last: unknown; nativeReloadCalls: number; maximumTimeoutMs: number; bypassCacheSupported: boolean; cacheSettingsChanged: false;} {
        return {pageId: this.#pageId, mode: this.#mode, disposed: this.#disposed, disposing: this.#disposing, sessionClosed: this.#sessionClosed,
            busy: this.#active !== null, pending: this.#active ? this.#state(this.#active) : null, last: this.#last, nativeReloadCalls: this.#reloadCalls,
            maximumTimeoutMs: this.#maximumTimeoutMs, bypassCacheSupported: this.#mode === 'general', cacheSettingsChanged: false};
    }
    static #closedError(error: unknown): boolean {return /(?:target (?:page, context or browser has been )?closed|session (?:has been )?closed|browser closed|already detached|Protocol error \(Target\.detachFromTarget\): No session with given id)/i.test(String(error instanceof Error ? error.message : error));}
    #removeListeners(): void {this.#session.off('Page.frameNavigated', this.#onNavigation); this.#session.off('Page.lifecycleEvent', this.#onLifecycle); this.#session.off('close', this.#onSessionClose); this.#page.off('close', this.#onClose);}
    async dispose() {
        if (this.#disposed) return {disposed: true, alreadyDisposed: true, otherSessionsDetached: false};
        if (this.#disposing || this.#active && !this.#page.isClosed()) throw new CdpReloadError('OPERATION_PENDING', 'Do not detach live pending native work; close the exact Page/owned host first.', this.#active?.dispatched ?? false);
        this.#disposing = true;
        try {
            try {await this.#session.detach();} catch (error) {if (!this.#page.isClosed() || !CdpReload.#closedError(error)) throw error;}
            this.#removeListeners(); this.#disposed = true;
            return {disposed: true, alreadyDisposed: false, otherSessionsDetached: false};
        } finally {this.#disposing = false;}
    }
}
