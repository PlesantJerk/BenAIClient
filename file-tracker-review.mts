import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import { FileTrackerGit } from './file-tracker-git.mts';
import { FileTrackerError, FileTrackerLocation, type TrackerDirectory } from './file-tracker-location.mts';
import { FileTrackerReviewObjects, type CheckpointPair } from './file-tracker-review-objects.mts';
import { FileTrackerStore, type OpenedTrackerStore } from './file-tracker-store.mts';

export type TrackerRouteSnapshot = Readonly<{ rawRoot: string; machine: string; version: string; root: TrackerDirectory }>;
export type TrackerCommand = Readonly<Record<string, unknown>>;
type Change = 'added' | 'modified' | 'deleted';
type Entry = Readonly<{ path: string; change: Change; oldSha: string | null; newSha: string | null }>;

export class FileTrackerReview {
    static readonly manifestCommand = 'QA_FileTrackerReadManifest';
    static readonly fileCommand = 'QA_FileTrackerReadFile';
    static readonly #pageSize = 256;
    static readonly #pageBytes = 56 * 1024;
    static readonly #maxChanges = 2 * FileTrackerReviewObjects.maxTreeFiles;
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
            if (cursor !== null && (typeof cursor !== 'string' || !/^[1-9][0-9]{0,4}\.[0-9a-f]{64}$/u.test(cursor))) throw this.invalid();
            return this.withPair(command, async (pair, objects, store, route) => {
                const { original, final, provenance } = await objects.readPair(pair);
                const { entries, counts } = this.changedPaths(original, final);
                const scope = this.cursorScope(pair, store, route, entries);
                const offset = this.offset(cursor, scope, entries.length);
                const page = this.page(entries, offset);
                const next = offset + page.length;
                return { success: true, ...pair, provenance, totalCount: entries.length, counts, entries: page,
                    nextCursor: next < entries.length ? this.cursor(scope, next) : null };
            });
        });
    }

    async file(command: TrackerCommand, result: object): Promise<void> {
        await this.execute(result, async () => {
            const { path, oldSha, newSha } = command;
            if (!FileTrackerReviewObjects.isPath(path) || !this.isNullableSha(oldSha) || !this.isNullableSha(newSha) || oldSha === newSha) throw this.invalid();
            return this.withPair(command, async (pair, objects) => {
                const trees = await objects.readPair(pair);
                if ((trees.original.get(path) ?? null) !== oldSha || (trees.final.get(path) ?? null) !== newSha) throw this.invalid();
                const [original, final] = await objects.versions(oldSha, newSha);
                return { success: true, ...pair, path, oldSha, newSha, original, final };
            });
        });
    }

    private async execute(result: object, action: () => Promise<object>): Promise<void> {
        try { Object.assign(result, await action()); }
        catch { Object.assign(result, { success: false, msg: 'The checkpoint could not be read safely on this named client.' }); }
    }

    private async withPair<T>(command: TrackerCommand, action: (pair: CheckpointPair, objects: FileTrackerReviewObjects,
        store: OpenedTrackerStore, route: TrackerRouteSnapshot) => Promise<T>): Promise<T> {
        const pair = this.pair(command);
        const route = this.#route();
        if (command.virtualRoot !== route.rawRoot) throw this.invalid();
        const expected = this.location(command, route);
        const repoPath = join(expected.project.path, '.AIWork', 'tracking', FileTrackerLocation.codeName(command.codeName), 'repo.git');
        return this.#store.protectCapture(repoPath, async () => {
            const currentRoute = this.#route();
            const location = this.location(command, currentRoute);
            if (currentRoute.version !== route.version || !FileTrackerLocation.sameDirectory(location.project, expected.project)) throw this.invalid();
            const store = this.openExisting(command, currentRoute, location);
            if (store.repoPath !== repoPath) throw this.invalid();
            // Holding the manifest, config and directory pins lets us validate the full object layout once per request.
            const objects = new FileTrackerReviewObjects(this.#git, repoPath);
            const head = this.#store.trackingHead(repoPath);
            await objects.assertReachable(pair.endCommit, head);
            const result = await action(pair, objects, store, route);
            await objects.assertReachable(pair.endCommit, this.#store.trackingHead(repoPath), head);
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
        location: ReturnType<typeof FileTrackerLocation.project>): OpenedTrackerStore {
        const codeName = FileTrackerLocation.codeName(command.codeName);
        const trackerId = command.trackerId;
        if (typeof trackerId !== 'string' || !FileTrackerStore.uuid.test(trackerId)) throw this.invalid();
        // attach is validation only, unlike open; do not run worktree nesting/ignore probes or issue a binding.
        const store = this.#store.attach(location, codeName, route.machine);
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
        if (entries.length > FileTrackerReview.#maxChanges) throw this.invalid();
        return { entries, counts };
    }

    private cursorScope(pair: CheckpointPair, store: OpenedTrackerStore, route: TrackerRouteSnapshot, entries: readonly Entry[]): string {
        const identity = [route.version, store.manifest.trackerId, store.manifest.repoIdentity, pair.startCommit, pair.endCommit];
        const hash = createHash('sha256').update(JSON.stringify(identity));
        for (const entry of entries) hash.update(JSON.stringify(entry));
        return hash.digest('hex');
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
