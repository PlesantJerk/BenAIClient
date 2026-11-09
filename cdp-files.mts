import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ElementHandle, FileChooser, Page } from 'playwright-core';

export interface CdpFilesOwner { readonly page: Page; readonly pageId: string; }
export interface CdpFileOrigin {
    readonly originState?: 'inFlight' | 'idle' | 'unknown';
    readonly originCallId?: string | null;
    readonly originActionId?: string | null;
    readonly documentId?: string | null;
    readonly frameId?: string | null;
}
export interface CdpFilesLimits {
    readonly maxFiles: number;
    readonly maxFileBytes: number;
    readonly maxTotalBytes: number;
    readonly chooserLifetimeMs: number;
    readonly preparedLifetimeMs: number;
    readonly timeoutMs: number;
}
export type CdpFileState = 'pending' | 'preparing' | 'prepared' | 'resolving' | 'handled' | 'uncertain' | 'stale';
export interface CdpLocalFileMetadata {
    readonly path: string;
    readonly name: string;
    readonly size: number;
    readonly lastModifiedMs: number;
    readonly mimeType: null;
}
export interface CdpFileTarget {
    readonly tagName: 'INPUT';
    readonly type: 'file';
    readonly idAttribute: string;
    readonly nameAttribute: string;
    readonly attributesTruncated: boolean;
    readonly multiple: boolean;
    readonly mainFrame: boolean;
}
export interface CdpObservedFiles {
    readonly totalCount: number;
    readonly truncated: boolean;
    readonly files: ReadonlyArray<Readonly<{ name: string; size: number; mimeType: string; lastModifiedMs: number; nameTruncated: boolean; mimeTypeTruncated: boolean }>>;
}
export interface CdpFileChooserDescription extends CdpFileOrigin {
    readonly chooserId: string;
    readonly pageId: string;
    readonly multiple: boolean;
    readonly capturedAtUtc: string;
    readonly expiresAtUtc: string;
    readonly pageClosedAtUtc: string | null;
    readonly state: CdpFileState;
    readonly selectionId: string | null;
    readonly staleReason: string | null;
}
export interface CdpFileSelectionDescription {
    readonly selectionId: string;
    readonly pageId: string;
    readonly chooserId: string | null;
    readonly mode: 'element' | 'chooser';
    readonly state: CdpFileState;
    readonly target: CdpFileTarget;
    readonly preparedAtUtc: string;
    readonly expiresAtUtc: string;
    readonly finishedAtUtc: string | null;
    readonly pageClosedAtUtc: string | null;
    readonly preparedFiles: ReadonlyArray<CdpLocalFileMetadata>;
    readonly dispatchFiles: ReadonlyArray<CdpLocalFileMetadata> | null;
    readonly observed: CdpObservedFiles | null;
    readonly staleReason: string | null;
}
export class CdpFileError extends Error {
    readonly code: string;
    readonly dispatchAttempted: boolean;
    constructor(code: string, message: string, dispatchAttempted = false, cause?: unknown) {
        super(message, cause === undefined ? undefined : { cause });
        this.name = 'CdpFileError'; this.code = code; this.dispatchAttempted = dispatchAttempted;
    }
}
interface CdpChooserEntry { native: FileChooser | null; description: CdpFileChooserDescription; expires: number; }
interface CdpSelectionEntry {
    element: ElementHandle | null;
    description: CdpFileSelectionDescription;
    expires: number;
    dispatchAttempted: boolean;
}

/** Owner-held native file selection only. No listeners, events, authorization or durable action journal. */
export class CdpFiles {
    readonly limits: CdpFilesLimits;
    readonly #owner: CdpFilesOwner;
    readonly #page: Page;
    readonly #pageId: string;
    readonly #choosers = new Map<string, CdpChooserEntry>();
    readonly #seen = new WeakMap<FileChooser, CdpChooserEntry>();
    readonly #selections = new Map<string, CdpSelectionEntry>();
    #timer: ReturnType<typeof setTimeout> | null = null;
    #closed = false;

    constructor(owner: CdpFilesOwner, limits: Partial<CdpFilesLimits> = {}) {
        this.#owner = owner; this.#page = owner.page;
        this.#pageId = this.#identifier(owner.pageId, 'pageId')!;
        if (!this.#pageId) throw new CdpFileError('InvalidMetadata', 'pageId is required.');
        this.limits = this.#limits(limits);
    }

    /** Delegate from the owner's persistent sole filechooser broker, not a per-watch listener. */
    captureChooser(chooser: FileChooser, origin: CdpFileOrigin = {}): Readonly<{ isNew: boolean; chooser: CdpFileChooserDescription }> {
        this.#ready();
        if (chooser.page() !== this.#page) throw new CdpFileError('ForeignChooser', 'FileChooser belongs to another Page.');
        const seen = this.#seen.get(chooser);
        if (seen) return Object.freeze({ isNew: false, chooser: seen.description });
        this.#makeRoom(this.#choosers);
        const expires = Date.now() + this.limits.chooserLifetimeMs;
        const description = Object.freeze({ chooserId: randomUUID(), pageId: this.#pageId, multiple: chooser.isMultiple(),
            ...this.#origin(origin), capturedAtUtc: new Date().toISOString(), expiresAtUtc: new Date(expires).toISOString(),
            pageClosedAtUtc: null, state: 'pending' as const, selectionId: null, staleReason: null });
        const entry = { native: chooser, description, expires };
        this.#choosers.set(description.chooserId, entry); this.#seen.set(chooser, entry); this.#schedule();
        return Object.freeze({ isNew: true, chooser: description });
    }

    describeChooser(id: string): CdpFileChooserDescription | null {
        this.#assertBinding(); this.prune(); return this.#choosers.get(id)?.description ?? null;
    }
    describeChoosers(): ReadonlyArray<CdpFileChooserDescription> {
        this.#assertBinding(); this.prune(); return Object.freeze([...this.#choosers.values()].map(entry => entry.description));
    }
    describeSelection(id: string): CdpFileSelectionDescription | null {
        this.#assertBinding(); this.prune(); return this.#selections.get(id)?.description ?? null;
    }

    async prepareElement(element: ElementHandle, absolutePaths: ReadonlyArray<string>): Promise<CdpFileSelectionDescription> {
        this.#ready();
        const target = await this.#inspect(element, true);
        const files = await this.#files(absolutePaths);
        this.#checkMultiple(target, files.length); this.#ready();
        return this.#retainSelection(element, target, files, null);
    }

    async prepareChooser(id: string, absolutePaths: ReadonlyArray<string>): Promise<CdpFileSelectionDescription> {
        this.#ready();
        const chooser = this.#pendingChooser(id);
        chooser.description = Object.freeze({ ...chooser.description, state: 'preparing' });
        try {
            const element = chooser.native!.element();
            const target = await this.#inspect(element, false);
            const files = await this.#files(absolutePaths);
            this.#checkMultiple(target, files.length, chooser); this.#ready();
            if (chooser.description.state !== 'preparing') throw new CdpFileError('StaleChooser', 'Chooser expired during preparation.');
            return this.#retainSelection(element, target, files, chooser);
        } catch (error) {
            this.#releasePreparation(chooser, error); throw error;
        }
    }

    /** Owner must persist dispatchStarted BEFORE this call; it is never a journal substitute. */
    async apply(id: string): Promise<CdpFileSelectionDescription> {
        this.#ready();
        const entry = this.#prepared(id);
        const chooser = entry.description.chooserId ? this.#choosers.get(entry.description.chooserId)! : null;
        this.#begin(entry, chooser);
        try {
            await this.#revalidate(entry, chooser);
            await this.#dispatch(entry, chooser);
            const observed = await this.#observe(entry.element!);
            this.#finish(entry, chooser, 'handled', observed);
            return entry.description;
        } catch (error) {
            this.#finish(entry, chooser, entry.dispatchAttempted ? 'uncertain' : 'stale', null);
            if (!entry.dispatchAttempted) throw error;
            throw new CdpFileError('FileSelectionUncertain', 'Selection or post-selection observation failed; do not retry this prepared ID.', true, error);
        }
    }

    /** Release only an undispatched prepared plan. This is not native chooser Cancel. */
    discardPrepared(id: string): void {
        this.#ready(); const entry = this.#prepared(id);
        const chooser = entry.description.chooserId ? this.#choosers.get(entry.description.chooserId) : null;
        this.#staleSelection(entry, 'discarded');
        if (chooser?.description.state === 'prepared')
            chooser.description = Object.freeze({ ...chooser.description, state: 'pending', selectionId: null });
        this.#schedule();
    }

    prune(): void {
        const now = Date.now();
        for (const chooser of this.#choosers.values())
            if (chooser.expires <= now && this.#expirable(chooser.description.state)) this.#staleChooser(chooser, 'expired');
        for (const selection of this.#selections.values())
            if (selection.expires <= now && selection.description.state === 'prepared') this.#expireSelection(selection);
        this.#schedule();
    }

    /** Exact verified closure only. No setFiles, empty selection, events or page.close calls. */
    disposeAfterPageClosed(): void {
        this.#assertBinding();
        if (!this.#page.isClosed()) throw new CdpFileError('PageStillOpen', 'Verify exact Page closure before disposing files.');
        if (this.#closed) return;
        this.#closed = true; if (this.#timer) clearTimeout(this.#timer); this.#timer = null;
        const closed = new Date().toISOString();
        for (const chooser of this.#choosers.values()) this.#closeChooser(chooser, closed);
        for (const entry of this.#selections.values()) this.#closeSelection(entry, closed);
    }

    #limits(value: Partial<CdpFilesLimits>): CdpFilesLimits {
        const result = { maxFiles: 16, maxFileBytes: 8 * 1024 * 1024, maxTotalBytes: 16 * 1024 * 1024,
            chooserLifetimeMs: 60000, preparedLifetimeMs: 60000, timeoutMs: 10000, ...value };
        const bounds = { maxFiles: [1, 64], maxFileBytes: [0, 64 * 1024 * 1024], maxTotalBytes: [0, 128 * 1024 * 1024],
            chooserLifetimeMs: [1, 600000], preparedLifetimeMs: [1, 600000], timeoutMs: [1, 60000] };
        for (const key of Object.keys(bounds) as Array<keyof CdpFilesLimits>) {
            const [minimum, maximum] = bounds[key];
            if (!Number.isSafeInteger(result[key]) || result[key] < minimum || result[key] > maximum)
                throw new CdpFileError('InvalidLimits', `Invalid operational file limit: ${key}.`);
        }
        return Object.freeze(result);
    }
    #assertBinding(): void {
        if (this.#owner.page !== this.#page || this.#owner.pageId !== this.#pageId)
            throw new CdpFileError('OwnerBindingChanged', 'A different Page needs a new file helper.');
    }
    #ready(): void {
        this.#assertBinding(); this.prune();
        if (this.#closed || this.#page.isClosed()) throw new CdpFileError('PageClosed', 'Owned Page is closed.');
    }
    #identifier(value: unknown, name: string): string | null {
        if (value === undefined || value === null) return null;
        if (typeof value === 'string' && value.trim() && value.length <= 128) return value;
        throw new CdpFileError('InvalidMetadata', `${name} must be a nonblank identifier of at most 128 UTF-16 units.`);
    }
    #origin(value: CdpFileOrigin): CdpFileOrigin {
        const originState = value.originState ?? 'unknown';
        const originCallId = this.#identifier(value.originCallId, 'originCallId');
        const originActionId = this.#identifier(value.originActionId, 'originActionId');
        if (!['inFlight', 'idle', 'unknown'].includes(originState) || (originState === 'inFlight' && (!originCallId || !originActionId))
            || (originState === 'idle' && originActionId)) throw new CdpFileError('InvalidMetadata', 'Invalid chooser origin evidence.');
        return { originState, originCallId, originActionId, documentId: this.#identifier(value.documentId, 'documentId'),
            frameId: this.#identifier(value.frameId, 'frameId') };
    }

    async #inspect(element: ElementHandle, mainOnly: boolean): Promise<CdpFileTarget> {
        try {
            const frame = await element.ownerFrame();
            if (!frame) throw new CdpFileError('TargetUnavailable', 'Pinned input has no live owner frame.');
            if (frame.page() !== this.#page || (mainOnly && frame !== this.#page.mainFrame()))
                throw new CdpFileError('ForeignTarget', 'Target must be the exact owned Page and permitted frame.');
            const value = await element.evaluate(node => {
                const input = node as HTMLInputElement;
                return { valid: input.tagName === 'INPUT' && input.type === 'file', connected: input.isConnected,
                    disabled: input.matches(':disabled'), directory: input.hasAttribute('webkitdirectory') || input.hasAttribute('directory'),
                    multiple: input.multiple === true, id: (input.getAttribute('id') ?? '').slice(0, 257), name: (input.getAttribute('name') ?? '').slice(0, 257) };
            });
            this.#validateTarget(value);
            return Object.freeze({ tagName: 'INPUT', type: 'file', idAttribute: value.id.slice(0, 256), nameAttribute: value.name.slice(0, 256),
                attributesTruncated: value.id.length > 256 || value.name.length > 256, multiple: value.multiple, mainFrame: frame === this.#page.mainFrame() });
        } catch (error) {
            if (error instanceof CdpFileError) throw error;
            throw new CdpFileError('TargetUnavailable', 'Pinned input is unavailable; no retargeting performed.', false, error);
        }
    }
    #validateTarget(value: { valid: boolean; connected: boolean; disabled: boolean; directory: boolean }): void {
        if (!value.connected || !value.valid) throw new CdpFileError('TargetUnavailable', 'Pinned target is detached or no longer a native file input.');
        if (value.disabled) throw new CdpFileError('DisabledTarget', 'Native file input is disabled.');
        if (value.directory) throw new CdpFileError('DirectoryInputUnsupported', 'Directory upload is not this regular-file operation.');
    }
    #checkMultiple(target: CdpFileTarget, count: number, chooser?: CdpChooserEntry | null): void {
        if (count > 1 && (!target.multiple || (chooser && !chooser.description.multiple)))
            throw new CdpFileError('MultipleFilesNotAllowed', 'Native input/chooser does not permit multiple files.');
    }
    #localPath(value: unknown): string {
        if (typeof value !== 'string' || !value || value.length > 4096 || value.includes('\0') || !path.isAbsolute(value)
            || value.startsWith('\\\\') || value.startsWith('//') || /^[a-z][a-z0-9+.-]*:\/\//i.test(value))
            throw new CdpFileError('InvalidLocalPath', 'Supply an explicit absolute local file path, not a URI, network share or directory.');
        if (process.platform === 'win32' && value.slice(2).includes(':')) throw new CdpFileError('InvalidLocalPath', 'Alternate data streams are not regular file selections.');
        return path.resolve(value);
    }
    async #file(value: string): Promise<CdpLocalFileMetadata> {
        try {
            const canonical = this.#localPath(await fs.realpath(this.#localPath(value)));
            const handle = await fs.open(canonical, 'r');
            try {
                const stat = await handle.stat();
                if (!stat.isFile()) throw new CdpFileError('NotRegularFile', 'Selection requires regular files, not directories/devices.');
                if (!Number.isSafeInteger(stat.size) || stat.size > this.limits.maxFileBytes)
                    throw new CdpFileError('FileTooLarge', 'File exceeds the configured per-file byte bound.');
                return Object.freeze({ path: canonical, name: path.basename(canonical), size: stat.size, lastModifiedMs: stat.mtimeMs, mimeType: null });
            } finally { await handle.close(); }
        } catch (error) {
            if (error instanceof CdpFileError) throw error;
            throw new CdpFileError('LocalFileUnavailable', 'Cannot validate a readable regular local file.', false, error);
        }
    }
    async #files(values: ReadonlyArray<string>): Promise<ReadonlyArray<CdpLocalFileMetadata>> {
        if (!Array.isArray(values) || values.length > this.limits.maxFiles)
            throw new CdpFileError('FileCountExceeded', 'File list exceeds the configured count bound.');
        const files: CdpLocalFileMetadata[] = []; let total = 0;
        for (const value of values) {
            const file = await this.#file(value); total += file.size;
            if (total > this.limits.maxTotalBytes) throw new CdpFileError('TotalFilesTooLarge', 'File list exceeds the configured aggregate byte bound.');
            files.push(file);
        }
        return Object.freeze(files);
    }

    #pendingChooser(id: string): CdpChooserEntry {
        const entry = this.#choosers.get(id);
        if (!entry) throw new CdpFileError('UnknownChooser', 'Unknown, foreign or evicted FileChooserId.');
        if (entry.description.state !== 'pending' || !entry.native) throw new CdpFileError(`ChooserNotPending:${entry.description.state}`, 'Chooser is not pending.');
        return entry;
    }
    #prepared(id: string): CdpSelectionEntry {
        const entry = this.#selections.get(id);
        if (!entry) throw new CdpFileError('UnknownSelection', 'Unknown, foreign or evicted prepared selection ID.');
        if (entry.description.state !== 'prepared' || !entry.element) throw new CdpFileError(`SelectionNotPrepared:${entry.description.state}`, 'Selection has been consumed or is stale.');
        return entry;
    }
    #retainSelection(element: ElementHandle, target: CdpFileTarget, files: ReadonlyArray<CdpLocalFileMetadata>, chooser: CdpChooserEntry | null): CdpFileSelectionDescription {
        this.#makeRoom(this.#selections);
        const expires = Math.min(Date.now() + this.limits.preparedLifetimeMs, chooser?.expires ?? Infinity);
        const description = Object.freeze({ selectionId: randomUUID(), pageId: this.#pageId, chooserId: chooser?.description.chooserId ?? null,
            mode: chooser ? 'chooser' as const : 'element' as const, state: 'prepared' as const, target, preparedAtUtc: new Date().toISOString(),
            expiresAtUtc: new Date(expires).toISOString(), finishedAtUtc: null, pageClosedAtUtc: null,
            preparedFiles: files, dispatchFiles: null, observed: null, staleReason: null });
        this.#selections.set(description.selectionId, { element, description, expires, dispatchAttempted: false });
        if (chooser) chooser.description = Object.freeze({ ...chooser.description, state: 'prepared', selectionId: description.selectionId });
        this.#schedule(); return description;
    }
    #releasePreparation(chooser: CdpChooserEntry, error: unknown): void {
        if (chooser.description.state !== 'preparing') return;
        if (error instanceof CdpFileError && error.code === 'TargetUnavailable') this.#staleChooser(chooser, 'inputUnavailable');
        else chooser.description = Object.freeze({ ...chooser.description, state: 'pending' });
        this.#schedule();
    }
    #begin(entry: CdpSelectionEntry, chooser: CdpChooserEntry | null): void {
        if (chooser && (chooser.description.state !== 'prepared' || chooser.description.selectionId !== entry.description.selectionId || !chooser.native))
            throw new CdpFileError('StaleChooser', 'Prepared selection no longer owns its exact chooser.');
        entry.description = Object.freeze({ ...entry.description, state: 'resolving' });
        if (chooser) chooser.description = Object.freeze({ ...chooser.description, state: 'resolving' });
    }
    async #revalidate(entry: CdpSelectionEntry, chooser: CdpChooserEntry | null): Promise<void> {
        const target = await this.#inspect(entry.element!, entry.description.mode === 'element');
        const files = await this.#files(entry.description.preparedFiles.map(file => file.path));
        this.#checkMultiple(target, files.length, chooser); this.#ready();
        if (entry.description.state !== 'resolving') throw new CdpFileError('StaleSelection', 'Prepared selection is no longer current.');
        entry.description = Object.freeze({ ...entry.description, target, dispatchFiles: files });
    }
    async #dispatch(entry: CdpSelectionEntry, chooser: CdpChooserEntry | null): Promise<void> {
        const paths = entry.description.dispatchFiles!.map(file => file.path);
        entry.dispatchAttempted = true;
        if (chooser) await chooser.native!.setFiles(paths, { timeout: this.limits.timeoutMs });
        else await entry.element!.setInputFiles(paths, { timeout: this.limits.timeoutMs });
    }
    async #observe(element: ElementHandle): Promise<CdpObservedFiles> {
        const observed = await element.evaluate((node, limit) => {
            const files = (node as HTMLInputElement).files;
            const values = []; const totalCount = files?.length ?? 0;
            for (let index = 0; files && index < Math.min(totalCount, limit); index++) {
                const file = files[index]; values.push({ name: file.name.slice(0, 1024), size: file.size, mimeType: file.type.slice(0, 256),
                    lastModifiedMs: file.lastModified, nameTruncated: file.name.length > 1024, mimeTypeTruncated: file.type.length > 256 });
            }
            return { files: values, totalCount, truncated: totalCount > limit };
        }, this.limits.maxFiles);
        return Object.freeze({ ...observed, files: Object.freeze(observed.files.map(file => Object.freeze(file))) });
    }
    #finish(entry: CdpSelectionEntry, chooser: CdpChooserEntry | null, state: 'handled' | 'uncertain' | 'stale', observed: CdpObservedFiles | null): void {
        entry.description = Object.freeze({ ...entry.description, state, observed, finishedAtUtc: new Date().toISOString(),
            staleReason: state === 'stale' ? 'preDispatchRejected' : null });
        entry.element = null;
        if (chooser) { chooser.description = Object.freeze({ ...chooser.description, state, staleReason: entry.description.staleReason }); chooser.native = null; }
        this.#schedule();
    }

    #expirable(state: CdpFileState): boolean { return state === 'pending' || state === 'preparing' || state === 'prepared'; }
    #terminal(state: CdpFileState): boolean { return state === 'handled' || state === 'uncertain' || state === 'stale'; }
    #makeRoom<T extends { description: { state: CdpFileState } }>(entries: Map<string, T>): void {
        if (entries.size < 128) return;
        for (const [id, entry] of entries) if (this.#terminal(entry.description.state)) { entries.delete(id); return; }
        throw new CdpFileError('FileRegistryFull', 'No safe local history slot is available.');
    }
    #staleSelection(entry: CdpSelectionEntry, reason: string): void {
        entry.description = Object.freeze({ ...entry.description, state: 'stale', staleReason: reason }); entry.element = null;
    }
    #staleChooser(chooser: CdpChooserEntry, reason: string): void {
        chooser.description = Object.freeze({ ...chooser.description, state: 'stale', staleReason: reason }); chooser.native = null;
        const selection = chooser.description.selectionId ? this.#selections.get(chooser.description.selectionId) : null;
        if (selection?.description.state === 'prepared') this.#staleSelection(selection, reason);
    }
    #expireSelection(entry: CdpSelectionEntry): void {
        this.#staleSelection(entry, 'expired');
        const chooser = entry.description.chooserId ? this.#choosers.get(entry.description.chooserId) : null;
        if (chooser?.description.state === 'prepared') chooser.description = Object.freeze({ ...chooser.description, state: 'pending', selectionId: null });
    }
    #schedule(): void {
        if (this.#timer) clearTimeout(this.#timer); this.#timer = null;
        if (this.#closed) return;
        const due = [...this.#choosers.values()].filter(entry => this.#expirable(entry.description.state)).map(entry => entry.expires);
        due.push(...[...this.#selections.values()].filter(entry => entry.description.state === 'prepared').map(entry => entry.expires));
        if (!due.length) return;
        this.#timer = setTimeout(() => this.prune(), Math.max(1, Math.min(...due) - Date.now())); this.#timer.unref();
    }
    #closeChooser(chooser: CdpChooserEntry, closed: string): void {
        if (this.#expirable(chooser.description.state)) this.#staleChooser(chooser, 'pageClosed');
        chooser.description = Object.freeze({ ...chooser.description, pageClosedAtUtc: closed });
    }
    #closeSelection(entry: CdpSelectionEntry, closed: string): void {
        if (entry.description.state === 'prepared') this.#staleSelection(entry, 'pageClosed');
        entry.description = Object.freeze({ ...entry.description, pageClosedAtUtc: closed });
    }
}
