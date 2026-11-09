import { randomUUID } from 'node:crypto';
import type { Dialog, Page } from 'playwright-core';

export type CdpDialogType = 'alert' | 'beforeunload' | 'confirm' | 'prompt';
export type CdpDialogOriginState = 'inFlight' | 'idle' | 'unknown';
export type CdpDialogState = 'pending' | 'resolving' | 'handled' | 'uncertain' | 'stale';

export interface CdpDialogOwner {
    readonly page: Page;
    readonly pageId: string;
}

/** Correlation evidence supplied by the owner, not an authorization decision. */
export interface CdpDialogOrigin {
    readonly originState?: CdpDialogOriginState;
    readonly originCallId?: string | null;
    readonly originActionId?: string | null;
    readonly documentId?: string | null;
    readonly frameId?: string | null;
}

export interface CdpDialogDescription {
    readonly dialogId: string;
    readonly pageId: string;
    readonly type: CdpDialogType;
    readonly message: string;
    readonly defaultPrompt: string;
    readonly messageTruncated: boolean;
    readonly defaultPromptTruncated: boolean;
    readonly originState: CdpDialogOriginState;
    readonly originCallId: string | null;
    readonly originActionId: string | null;
    readonly documentId: string | null;
    readonly frameId: string | null;
    readonly capturedAtUtc: string;
    readonly resolutionFinishedAtUtc: string | null;
    readonly pageClosedAtUtc: string | null;
    readonly state: CdpDialogState;
    readonly accepted: boolean | null;
    readonly promptTextSupplied: boolean;
    readonly staleReason: 'superseded' | 'pageClosed' | null;
}

export interface CdpDialogCapture {
    readonly isNew: boolean;
    readonly dialog: CdpDialogDescription;
}

export class CdpDialogError extends Error {
    readonly code: string;
    readonly dispatchAttempted: boolean;

    constructor(code: string, message: string, dispatchAttempted = false, cause?: unknown) {
        super(message, cause === undefined ? undefined : { cause });
        this.name = 'CdpDialogError';
        this.code = code;
        this.dispatchAttempted = dispatchAttempted;
    }
}

interface CdpDialogEntry {
    dialog: Dialog | null;
    description: CdpDialogDescription;
}

/**
 * One owner's exact Page. Installs no listeners, publishes no events, and never auto-resolves.
 * Core must authorize, deduplicate ActionId, persist dispatchStarted, and check the exact
 * current origin/gate exception BEFORE resolve(). Local state is not a durable action journal.
 */
export class CdpDialogs {
    readonly #owner: CdpDialogOwner;
    readonly #page: Page;
    readonly #pageId: string;
    readonly #entries = new Map<string, CdpDialogEntry>();
    readonly #seen = new WeakMap<Dialog, CdpDialogEntry>();
    readonly #maxRetained = 128;
    readonly #textLimit = 4096;
    readonly #promptLimit = 8192;
    #activeId: string | null = null;
    #closed = false;

    constructor(owner: CdpDialogOwner) {
        this.#owner = owner;
        this.#page = owner.page;
        this.#pageId = this.#identifier(owner.pageId, 'pageId', true)!;
    }

    /** Delegate from the owner's existing single page.on('dialog') listener. */
    capture(dialog: Dialog, origin: CdpDialogOrigin = {}): CdpDialogCapture {
        this.#assertBinding();
        this.#assertOpen();
        if (dialog.page() !== this.#page)
            throw new CdpDialogError('ForeignDialog', 'Dialog does not belong to this exact Page.');
        const seen = this.#seen.get(dialog);
        if (seen) return Object.freeze({ isNew: false, dialog: seen.description });
        const description = this.#describeNew(dialog, origin);
        this.#makeRoom();
        this.#supersedeActive();
        return this.#retain(dialog, description);
    }

    describeActive(): CdpDialogDescription | null {
        this.#assertBinding();
        return this.#activeId ? this.#entries.get(this.#activeId)?.description ?? null : null;
    }

    /** Historical snapshots are bounded; an evicted ID remains unresolvable. */
    describe(dialogId: string): CdpDialogDescription | null {
        this.#assertBinding();
        return this.#entries.get(dialogId)?.description ?? null;
    }

    /**
     * The caller must persist its dispatchStarted checkpoint BEFORE invoking this method.
     * A failed Playwright resolution is uncertain, consumes this handle, and is never retried.
     * Omitted/null prompt text preserves the bounded full browser default; explicit '' clears it.
     */
    async resolve(dialogId: string, accept: boolean, promptText?: string | null): Promise<CdpDialogDescription> {
        this.#assertBinding();
        if (this.#page.isClosed()) this.disposeAfterPageClosed();
        const entry = this.#pendingEntry(dialogId);
        const text = this.#validateResolution(entry, accept, promptText);
        const dialog = entry.dialog!;
        this.#setResolving(entry, accept, promptText !== undefined && promptText !== null);
        await this.#dispatchResolution(entry, dialog, accept, text);
        return entry.description;
    }

    /** Verified Page closure only. This does NOT call accept(), dismiss(), or page.close(). */
    disposeAfterPageClosed(): void {
        this.#assertBinding();
        if (!this.#page.isClosed())
            throw new CdpDialogError('PageStillOpen', 'Verify exact Page closure before disposing dialogs.');
        if (this.#closed) return;
        this.#closed = true;
        const closedAt = new Date().toISOString();
        for (const entry of this.#entries.values()) this.#markPageClosed(entry, closedAt);
        this.#activeId = null;
    }

    #assertBinding(): void {
        if (this.#owner.page !== this.#page || this.#owner.pageId !== this.#pageId)
            throw new CdpDialogError('OwnerBindingChanged', 'Create a new helper for a different Page owner.');
    }

    #assertOpen(): void {
        if (this.#closed || this.#page.isClosed())
            throw new CdpDialogError('PageClosed', 'Cannot capture a dialog after exact Page closure.');
    }

    #identifier(value: unknown, name: string, required = false): string | null {
        if (value === undefined || value === null) {
            if (!required) return null;
        } else if (typeof value === 'string' && value.trim().length > 0 && value.length <= 128) {
            return value;
        }
        throw new CdpDialogError('InvalidDialogMetadata', `${name} must be a nonblank identifier of at most 128 UTF-16 units.`);
    }

    #origin(origin: CdpDialogOrigin): Pick<CdpDialogDescription, 'originState' | 'originCallId' | 'originActionId' | 'documentId' | 'frameId'> {
        const state = origin.originState ?? 'unknown';
        const call = this.#identifier(origin.originCallId, 'originCallId');
        const action = this.#identifier(origin.originActionId, 'originActionId');
        if (!['inFlight', 'idle', 'unknown'].includes(state))
            throw new CdpDialogError('InvalidDialogMetadata', 'Unknown dialog originState.');
        if ((state === 'inFlight' && (!call || !action)) || (state === 'idle' && action))
            throw new CdpDialogError('InvalidDialogMetadata', 'inFlight requires call/action IDs; idle cannot name an originating action.');
        return { originState: state, originCallId: call, originActionId: action,
            documentId: this.#identifier(origin.documentId, 'documentId'), frameId: this.#identifier(origin.frameId, 'frameId') };
    }

    #type(dialog: Dialog): CdpDialogType {
        const type = dialog.type();
        if (type === 'alert' || type === 'beforeunload' || type === 'confirm' || type === 'prompt') return type;
        throw new CdpDialogError('UnsupportedDialogType', 'Only public native Playwright dialog types are supported.');
    }

    #boundedText(text: string): string {
        let length = Math.min(text.length, this.#textLimit);
        const last = text.charCodeAt(length - 1);
        if (length < text.length && last >= 0xD800 && last <= 0xDBFF) length--;
        return text.slice(0, length);
    }

    #describeNew(dialog: Dialog, origin: CdpDialogOrigin): CdpDialogDescription {
        const type = this.#type(dialog);
        const message = dialog.message();
        const defaultPrompt = type === 'prompt' ? dialog.defaultValue() : '';
        const boundedMessage = this.#boundedText(message);
        const boundedDefault = this.#boundedText(defaultPrompt);
        return Object.freeze({ dialogId: randomUUID(), pageId: this.#pageId, type,
            message: boundedMessage, defaultPrompt: boundedDefault,
            messageTruncated: boundedMessage.length !== message.length, defaultPromptTruncated: boundedDefault.length !== defaultPrompt.length,
            ...this.#origin(origin), capturedAtUtc: new Date().toISOString(), resolutionFinishedAtUtc: null, pageClosedAtUtc: null,
            state: 'pending', accepted: null, promptTextSupplied: false, staleReason: null });
    }

    #makeRoom(): void {
        if (this.#entries.size < this.#maxRetained) return;
        for (const [id, entry] of this.#entries) {
            if (id === this.#activeId || entry.description.state === 'resolving' || entry.description.state === 'pending') continue;
            this.#entries.delete(id);
            return;
        }
        throw new CdpDialogError('DialogRegistryFull', 'Dialog registry has no safe history slot available.');
    }

    #supersedeActive(): void {
        const previous = this.#activeId ? this.#entries.get(this.#activeId) : undefined;
        if (previous?.description.state === 'pending') {
            previous.description = Object.freeze({ ...previous.description, state: 'stale', staleReason: 'superseded' });
            previous.dialog = null;
        }
        this.#activeId = null;
    }

    #retain(dialog: Dialog, description: CdpDialogDescription): CdpDialogCapture {
        const entry = { dialog, description };
        this.#entries.set(description.dialogId, entry);
        this.#seen.set(dialog, entry);
        this.#activeId = description.dialogId;
        return Object.freeze({ isNew: true, dialog: description });
    }

    #pendingEntry(dialogId: string): CdpDialogEntry {
        const entry = this.#entries.get(dialogId);
        if (!entry) throw new CdpDialogError('UnknownDialog', 'DialogId is unknown, foreign, or no longer retained.');
        const state = entry.description.state;
        if (state !== 'pending')
            throw new CdpDialogError(`DialogNotPending:${state}`, 'DialogId has already been consumed or is stale.');
        if (this.#closed || this.#activeId !== dialogId || !entry.dialog)
            throw new CdpDialogError('DialogNotCurrent', 'DialogId is not the exact current pending dialog.');
        return entry;
    }

    #validateResolution(entry: CdpDialogEntry, accept: boolean, text: unknown): string | undefined {
        if (typeof accept !== 'boolean') throw new CdpDialogError('InvalidDialogResolution', 'Accept must be boolean.');
        const supplied = text !== undefined && text !== null;
        if (!supplied && (!accept || entry.description.type !== 'prompt')) return undefined;
        const value = supplied ? text : entry.dialog!.defaultValue();
        if (!accept || entry.description.type !== 'prompt' || typeof value !== 'string')
            throw new CdpDialogError('InvalidDialogResolution', 'PromptText is only valid when accepting a prompt dialog.');
        if (value.length > this.#promptLimit || Buffer.byteLength(value, 'utf8') > 32768)
            throw new CdpDialogError('PromptTextTooLarge', 'PromptText or browser default exceeds the 8192 UTF-16 / 32768 UTF-8 byte limit.');
        return value;
    }

    #setResolving(entry: CdpDialogEntry, accept: boolean, supplied: boolean): void {
        entry.description = Object.freeze({ ...entry.description, state: 'resolving', accepted: accept, promptTextSupplied: supplied });
    }

    async #dispatchResolution(entry: CdpDialogEntry, dialog: Dialog, accept: boolean, text: string | undefined): Promise<void> {
        try {
            if (accept) await dialog.accept(text);
            else await dialog.dismiss();
        } catch (error) {
            this.#finishResolution(entry, 'uncertain');
            throw new CdpDialogError('DialogResolutionUncertain', 'Resolution I/O failed; do not retry this DialogId.', true, error);
        }
        this.#finishResolution(entry, 'handled');
    }

    #finishResolution(entry: CdpDialogEntry, state: 'handled' | 'uncertain'): void {
        entry.description = Object.freeze({ ...entry.description, state, resolutionFinishedAtUtc: new Date().toISOString() });
        entry.dialog = null;
        if (state === 'handled' && this.#activeId === entry.description.dialogId) this.#activeId = null;
    }

    #markPageClosed(entry: CdpDialogEntry, closedAt: string): void {
        const pending = entry.description.state === 'pending';
        entry.description = Object.freeze({ ...entry.description, pageClosedAtUtc: closedAt,
            state: pending ? 'stale' : entry.description.state, staleReason: pending ? 'pageClosed' : entry.description.staleReason });
        if (entry.description.state !== 'resolving') entry.dialog = null;
    }
}
