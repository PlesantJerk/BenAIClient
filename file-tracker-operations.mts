import { createHash, randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { FileTrackerCapture } from './file-tracker-capture.mts';
import { FileTrackerCaptureError, FileTrackerGit } from './file-tracker-git.mts';
import { FileTrackerIgnore } from './file-tracker-ignore.mts';
import { FileTrackerError, FileTrackerLocation, type TrackerDirectory, type TrackerLocation } from './file-tracker-location.mts';
import { FileTrackerStore, type OpenedTrackerStore } from './file-tracker-store.mts';

type TrackerRoute = Readonly<{ rootDirectory: string; clientName: string; account: string }>;
type RouteSnapshot = Readonly<{ rawRoot: string; machine: string; version: string; root: TrackerDirectory }>;
type SelectedTracker = Readonly<{ location: TrackerLocation; store: OpenedTrackerStore; route: RouteSnapshot }>;
type TrackerCommand = Readonly<Record<string, unknown>>;

export class FileTrackerOperations {
    static readonly openCommand = 'QA_OpenFileTracker';
    static readonly commitCommand = 'QA_CommitFileTracker';
    static readonly #maxId = 9223372036854775807n;
    readonly #host = hostname();
    readonly #git = new FileTrackerGit();
    readonly #store = new FileTrackerStore(this.#git);
    readonly #ignore = new FileTrackerIgnore(this.#git);
    readonly #capture = new FileTrackerCapture();
    readonly #bindings = new Map<string, SelectedTracker>();
    readonly #getRoute: () => TrackerRoute;
    #routeVersion?: string;
    #pending: Promise<void> = Promise.resolve();

    constructor(getRoute: () => TrackerRoute) { this.#getRoute = getRoute; }

    static handles(command: unknown): boolean {
        return command === this.openCommand || command === this.commitCommand;
    }

    async open(command: TrackerCommand, result: object): Promise<void> {
        await this.run(() => this.openTracker(command), result, 'The private file tracker could not be opened safely.');
    }

    async commit(command: TrackerCommand, result: object): Promise<void> {
        await this.run(() => this.commitTracker(command), result, 'The private file tracker capture failed.');
    }

    private async run(action: () => Promise<object>, result: object, fallback: string): Promise<void> {
        const turn = this.#pending.then(action);
        this.#pending = turn.then(() => undefined, () => undefined);
        try { Object.assign(result, await turn); }
        catch (err) {
            const known = err instanceof FileTrackerError || err instanceof FileTrackerCaptureError;
            const unknown = err instanceof FileTrackerCaptureError && err.outcomeUnknown;
            Object.assign(result, { success: false, msg: known ? err.message : fallback, ...(unknown ? { outcomeUnknown: true } : {}) });
        }
    }

    private async openTracker(command: TrackerCommand) {
        const route = this.readRoute();
        if (typeof command.virtualRoot !== 'string' || command.virtualRoot !== route.rawRoot) {
            throw new FileTrackerError('The configured virtual root changed or did not match the trusted open request.');
        }
        const codeName = FileTrackerLocation.codeName(command.codeName);
        if (this.#bindings.size >= 512) throw new FileTrackerError('The client reached its pilot limit of open tracker bindings.');
        const location = FileTrackerLocation.project(route.rawRoot, command.projectPath);
        FileTrackerLocation.assertNotNested(location);
        const verify = () => { this.verifySelection(location, route); };
        const store = await this.#store.open(location, codeName, route.machine, verify);
        const binding = { location, store, route };
        this.revalidate(binding);
        const warnings = await this.#ignore.warnings(location, store.repoPath);
        this.revalidate(binding);
        const bindingId = randomUUID();
        this.#bindings.set(bindingId, binding);
        return { success: true, trackerId: store.manifest.trackerId, bindingId, codeName,
            projectPath: location.projectPath, warnings, created: store.created };
    }

    private async commitTracker(command: TrackerCommand) {
        this.readRoute();
        const trackerId = command.trackerId;
        const bindingId = command.bindingId;
        if (typeof trackerId !== 'string' || !FileTrackerStore.uuid.test(trackerId)
            || typeof bindingId !== 'string' || !FileTrackerStore.uuid.test(bindingId)) throw this.stale();
        const binding = this.#bindings.get(bindingId);
        if (!binding || binding.store.manifest.trackerId !== trackerId) throw this.stale();
        const conversationId = this.id(command.conversationId);
        const statementId = command.statementId === null ? null : this.id(command.statementId);
        const description = command.description;
        if (typeof description !== 'string' || !description.trim() || !description.isWellFormed() || description.length > 2048 || description.includes('\0')) {
            throw new FileTrackerError('Supply a nonblank capture description of at most 2048 characters.');
        }
        const validateLocation = async () => { this.revalidate(binding); };
        return this.#store.protectCapture(binding.store.repoPath, async () => {
            this.revalidate(binding);
            FileTrackerLocation.assertNotNested(binding.location);
            return this.#capture.capture({ rootPath: binding.location.project.path, repoPath: binding.store.repoPath,
                conversationId, statementId, description, validateLocation, git: this.#git });
        });
    }

    private readRoute(): RouteSnapshot {
        try {
            const route = this.#getRoute();
            if (typeof route.clientName !== 'string' || !route.clientName || typeof route.account !== 'string' || !route.account) throw this.stale();
            const machine = createHash('sha256').update(JSON.stringify([this.#host, route.clientName, route.account.toLowerCase()])).digest('hex');
            const root = FileTrackerLocation.configuredRoot(route.rootDirectory);
            const version = JSON.stringify([machine, route.rootDirectory, root.path, root.identity]);
            if (version !== this.#routeVersion) this.#bindings.clear();
            this.#routeVersion = version;
            return { rawRoot: route.rootDirectory, machine, root, version };
        } catch (err) {
            this.#bindings.clear();
            this.#routeVersion = undefined;
            throw err;
        }
    }

    private verifySelection(location: TrackerLocation, expected: RouteSnapshot): TrackerLocation {
        const route = this.readRoute();
        if (route.version !== expected.version || !FileTrackerLocation.sameDirectory(route.root, location.virtualRoot)) throw this.stale();
        const current = FileTrackerLocation.project(route.rawRoot, location.projectPath);
        if (!FileTrackerLocation.sameDirectory(current.project, location.project)) throw this.stale();
        return current;
    }

    private revalidate(binding: SelectedTracker): void {
        const location = this.verifySelection(binding.location, binding.route);
        const expected = binding.store;
        const current = this.#store.attach(location, expected.manifest.codeName, binding.route.machine);
        if (current.manifest.trackerId !== expected.manifest.trackerId || current.manifestFile !== expected.manifestFile
            || current.manifest.workIdentity !== expected.manifest.workIdentity || current.manifest.trackingIdentity !== expected.manifest.trackingIdentity
            || current.manifest.storeIdentity !== expected.manifest.storeIdentity || current.manifest.repoIdentity !== expected.manifest.repoIdentity
            || current.configFile !== expected.configFile || !FileTrackerLocation.samePath(current.repoPath, expected.repoPath)) throw this.stale();
    }

    private id(value: unknown): string {
        if (typeof value !== 'string' || !/^[1-9][0-9]{0,18}$/.test(value) || BigInt(value) > FileTrackerOperations.#maxId) {
            throw new FileTrackerError('Trusted capture metadata must supply canonical positive signed-64-bit decimal identifiers.');
        }
        return value;
    }

    private stale(): FileTrackerError {
        return new FileTrackerError('The file tracker selection is stale or does not match this client and virtual root. Reopen the exact project before capturing.');
    }
}
