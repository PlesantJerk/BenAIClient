import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import { FileTrackerGit } from './file-tracker-git.mts';
import { FileTrackerError, FileTrackerLocation, type TrackerDirectory } from './file-tracker-location.mts';
import { FileTrackerReviewObjects, type CheckpointPair, type CheckpointProvenance } from './file-tracker-review-objects.mts';
import { FileTrackerStore, type OpenedTrackerStore } from './file-tracker-store.mts';
import { FileTrackerVersionReader } from './file-tracker-version-reader.mts';

export type TrackerRouteSnapshot = Readonly<{ rawRoot: string; machine: string; version: string; root: TrackerDirectory }>;
export type TrackerCommand = Readonly<Record<string, unknown>>;
type Change = 'added' | 'modified' | 'deleted';
type Entry = Readonly<{ path: string; change: Change; oldSha: string | null; newSha: string | null }>;
type FilePair = Readonly<{ path: string; oldSha: string | null; newSha: string | null }>;
type Manifest = Readonly<{ entries: Entry[]; counts: Record<Change, number>; provenance: CheckpointProvenance }>;

export class FileTrackerReview {
    static readonly manifestCommand = 'QA_FileTrackerReadManifest';
    static readonly fileCommand = 'QA_FileTrackerReadFile';
    static readonly #pageSize = 256;
    static readonly #pageBytes = 56 * 1024;
    readonly #readers = new Map<string, FileTrackerVersionReader>();
    readonly #manifests = new Map<string, { data: Manifest; head: string; timer: NodeJS.Timeout }>();
    readonly #cursorKey = randomBytes(32);
    readonly #git: FileTrackerGit;
    readonly #store: FileTrackerStore;
    readonly #route: () => TrackerRouteSnapshot;

    constructor(git: FileTrackerGit, store: FileTrackerStore, route: () => TrackerRouteSnapshot) {
        this.#git = git;
        this.#store = store;
        this.#route = route;
    }

    static handles(command: unknown): boolean { return command === this.manifestCommand || command === this.fileCommand; }

    async manifest(command: TrackerCommand, result: object): Promise<void> {
        await this.execute(result, async () => {
            const cursor = command.cursor;
            if (cursor !== null && (typeof cursor !== 'string' || !/^[1-9][0-9]{0,15}\.[0-9a-f]{64}$/u.test(cursor))) throw this.invalid();
            const cacheKey = JSON.stringify([this.#route().version, command.trackerId, command.projectPath, command.codeName, command.startCommit, command.endCommit]);
            const cached = cursor === null ? undefined : this.#manifests.get(cacheKey);
            return this.withPair(command, async (pair, objects, store, route, head) => {
                const scope = this.cursorScope(pair, store, route);
                const manifest = cursor === null ? await this.readManifest(pair, objects) : cached?.data;
                if (!manifest) throw this.invalid();
                const { entries, counts, provenance } = manifest;
                const offset = this.offset(cursor, scope, entries.length);
                const page = this.page(entries, offset);
                const next = offset + page.length;
                if (next < entries.length || cursor !== null) this.rememberManifest(cacheKey, manifest, head);
                return { success: true, ...pair, provenance, totalCount: entries.length, counts, entries: page,
                    nextCursor: next < entries.length ? this.cursor(scope, next) : null };
            }, cached?.head);
        });
    }

    private async readManifest(pair: CheckpointPair, objects: FileTrackerReviewObjects): Promise<Manifest> {
        const { original, final, provenance } = await objects.readPair(pair);
        return { ...this.changedPaths(original, final), provenance };
    }

    private rememberManifest(key: string, data: Manifest, head: string): void {
        clearTimeout(this.#manifests.get(key)?.timer);
        this.#manifests.set(key, { data, head, timer: setTimeout(() => this.#manifests.delete(key), 120_000).unref() });
    }

    async file(command: TrackerCommand, result: object): Promise<void> {
        await this.execute(result, async () => {
            const files = this.filePair(command);
            if (command.transfer === 'open') return this.openReader(command, files);
            if (command.transfer === 'chunk' || command.transfer === 'close') return this.readTransfer(command, files);
            if (command.transfer !== undefined) throw this.invalid();
            return this.withPair(command, async (pair, objects) => {
                await this.assertFile(objects, pair, files);
                const [original, final] = await objects.versions(files.oldSha, files.newSha);
                return { success: true, ...pair, ...files, original, final };
            });
        });
    }

    private filePair(command: TrackerCommand): FilePair {
        const { path, oldSha, newSha } = command;
        if (!FileTrackerReviewObjects.isPath(path) || !this.isNullableSha(oldSha) || !this.isNullableSha(newSha) || oldSha === newSha) throw this.invalid();
        return { path, oldSha, newSha };
    }

    private async assertFile(objects: FileTrackerReviewObjects, pair: CheckpointPair, files: FilePair): Promise<void> {
        const trees = await objects.readPair(pair);
        if ((trees.original.get(files.path) ?? null) !== files.oldSha || (trees.final.get(files.path) ?? null) !== files.newSha) throw this.invalid();
    }

    private openReader(command: TrackerCommand, files: FilePair): Promise<object> {
        const opened = Promise.withResolvers<object>();
        let reader: FileTrackerVersionReader | undefined;
        this.withPair(command, async (pair, objects, store, route) => {
            await this.assertFile(objects, pair, files);
            const original = await this.blob(objects, files.oldSha);
            const final = await this.blob(objects, files.newSha);
            reader = new FileTrackerVersionReader(this.readerScope(command, route), store.repoPath, original, final,
                () => this.closeReader(reader!));
            this.#readers.set(reader.id, reader);
            opened.resolve({ success: true, ...pair, ...files, readerId: reader.id, ...reader.lengths() });
            // Keep the repository protections until both streams and the post-read scope check finish.
            await reader.copy(objects);
        }).then(() => reader?.settle(true), error => { reader?.settle(false); opened.reject(error); });
        return opened.promise;
    }

    private async blob(objects: FileTrackerReviewObjects, sha: string | null) {
        if (sha === null) return null;
        const size = await objects.blobSize(sha);
        if (!size) await objects.copyBlob(sha, size, () => {});
        return { sha, size };
    }

    private readTransfer(command: TrackerCommand, files: FilePair): object {
        const pair = this.pair(command);
        const { readerId, side, offset } = command;
        const reader = typeof readerId === 'string' ? this.#readers.get(readerId) : undefined;
        if (!reader) throw this.invalid();
        reader.assertScope(this.readerScope(command, this.#route()));
        if (command.transfer === 'close') {
            this.closeReader(reader);
            return { success: true, readerId };
        }
        const position = Number(offset);
        if ((side !== 'original' && side !== 'final') || typeof offset !== 'string' || !Number.isSafeInteger(position) || position < 0 || String(position) !== offset) throw this.invalid();
        return { success: true, ...pair, ...files, readerId, side, offset, ...reader.chunk(side, position) };
    }

    private readerScope(command: TrackerCommand, route: TrackerRouteSnapshot): string {
        return JSON.stringify([route.version, command.virtualRoot, command.projectPath, command.codeName, command.trackerId,
            command.startCommit, command.endCommit, command.path, command.oldSha, command.newSha]);
    }

    private closeReader(reader: FileTrackerVersionReader): void {
        this.#readers.delete(reader.id);
        reader.close();
    }

    private async execute(result: object, action: () => Promise<object>): Promise<void> {
        try { Object.assign(result, await action()); }
        catch { Object.assign(result, { success: false, msg: 'The checkpoint could not be read safely on this named client.' }); }
    }

    private async withPair<T>(command: TrackerCommand, action: (pair: CheckpointPair, objects: FileTrackerReviewObjects,
        store: OpenedTrackerStore, route: TrackerRouteSnapshot, head: string) => Promise<T>, verifiedHead?: string): Promise<T> {
        const pair = this.pair(command);
        const route = this.#route();
        if (command.virtualRoot !== route.rawRoot) throw this.invalid();
        const expected = this.location(command, route);
        const repoPath = join(expected.project.path, FileTrackerLocation.workAreaName(expected.project.path), 'tracking', FileTrackerLocation.codeName(command.codeName), 'repo.git');
        return this.#store.protectCapture(repoPath, async () => {
            const currentRoute = this.#route();
            const location = this.location(command, currentRoute);
            if (currentRoute.version !== route.version || !FileTrackerLocation.sameDirectory(location.project, expected.project)) throw this.invalid();
            const head = this.#store.trackingHead(repoPath);
            const fast = verifiedHead === head;
            const store = this.openExisting(command, currentRoute, location, fast ? head : undefined);
            if (store.repoPath !== repoPath) throw this.invalid();
            const objects = new FileTrackerReviewObjects(this.#git, repoPath);
            await objects.assertReachable(pair.endCommit, head, fast ? head : undefined);
            const result = await action(pair, objects, store, route, head);
            const after = this.#store.trackingHead(repoPath);
            if (fast && head !== after) this.openExisting(command, currentRoute, location);
            await objects.assertReachable(pair.endCommit, after, head);
            if (this.#route().version !== route.version) throw this.invalid();
            return result;
        });
    }

    private pair(command: TrackerCommand): CheckpointPair {
        const { startCommit, endCommit } = command;
        if (!this.isNullableSha(startCommit) || !FileTrackerReviewObjects.isSha(endCommit) || startCommit === endCommit) throw this.invalid();
        return { startCommit, endCommit };
    }

    private location(command: TrackerCommand, route: TrackerRouteSnapshot) {
        if (command.virtualRoot !== route.rawRoot) throw this.invalid();
        const location = FileTrackerLocation.project(route.rawRoot, command.projectPath);
        if (location.projectPath !== command.projectPath || !FileTrackerLocation.sameDirectory(location.virtualRoot, route.root)) throw this.invalid();
        return location;
    }

    private openExisting(command: TrackerCommand, route: TrackerRouteSnapshot,
        location: ReturnType<typeof FileTrackerLocation.project>, verifiedHead?: string): OpenedTrackerStore {
        const codeName = FileTrackerLocation.codeName(command.codeName);
        const trackerId = command.trackerId;
        if (typeof trackerId !== 'string' || !FileTrackerStore.uuid.test(trackerId)) throw this.invalid();
        // attach is validation only, unlike open; do not run worktree nesting/ignore probes or issue a binding.
        const store = this.#store.attach(location, codeName, route.machine, verifiedHead);
        if (store.manifest.trackerId !== trackerId) throw this.invalid();
        return store;
    }

    private changedPaths(original: ReadonlyMap<string, string>, final: ReadonlyMap<string, string>) {
        const entries: Entry[] = [];
        const counts = { added: 0, modified: 0, deleted: 0 };
        for (const path of [...new Set([...original.keys(), ...final.keys()])].sort()) {
            const oldSha = original.get(path) ?? null;
            const newSha = final.get(path) ?? null;
            if (oldSha === newSha) continue;
            const change = oldSha === null ? 'added' : newSha === null ? 'deleted' : 'modified';
            counts[change]++;
            entries.push({ path, change, oldSha, newSha });
        }
        return { entries, counts };
    }

    private cursorScope(pair: CheckpointPair, store: OpenedTrackerStore, route: TrackerRouteSnapshot): string {
        const identity = [route.version, store.manifest.trackerId, store.manifest.repoIdentity, pair.startCommit, pair.endCommit];
        return createHash('sha256').update(JSON.stringify(identity)).digest('hex');
    }

    private cursor(scope: string, offset: number): string {
        const signature = createHmac('sha256', this.#cursorKey).update(`${scope}:${offset}`).digest('hex');
        return `${offset}.${signature}`;
    }

    private offset(cursor: string | null, scope: string, total: number): number {
        if (cursor === null) return 0;
        const offset = Number(cursor.split('.')[0]);
        if (offset <= 0 || offset >= total) throw this.invalid();
        const expected = Buffer.from(this.cursor(scope, offset));
        const actual = Buffer.from(cursor);
        if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw this.invalid();
        return offset;
    }

    private page(entries: readonly Entry[], offset: number): Entry[] {
        const page: Entry[] = [];
        let bytes = 2;
        for (let i = offset; i < entries.length && page.length < FileTrackerReview.#pageSize; i++) {
            const entry = entries[i];
            bytes += Buffer.byteLength(JSON.stringify(entry)) + 1;
            if (bytes > FileTrackerReview.#pageBytes) break;
            page.push(entry);
        }
        if (offset < entries.length && page.length === 0) throw this.invalid();
        return page;
    }

    private isNullableSha(value: unknown): value is string | null { return value === null || FileTrackerReviewObjects.isSha(value); }
    private invalid(): FileTrackerError { return new FileTrackerError('Invalid checkpoint review selection.'); }
}
