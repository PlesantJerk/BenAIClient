import { createHash, randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { FileTrackerBinding, type SelectedTracker } from './file-tracker-binding.mts';
import { FileTrackerCaptureJobs, type FileTrackerJobScope } from './file-tracker-capture-jobs.mts';
import type { FileTrackerCaptureMetadata } from './file-tracker-capture-worker.mts';
import { FileTrackerCapture } from './file-tracker-capture.mts';
import { FileTrackerCaptureError, FileTrackerGit } from './file-tracker-git.mts';
import { FileTrackerIgnore } from './file-tracker-ignore.mts';
import { FileTrackerError, FileTrackerLocation, type TrackerLocation } from './file-tracker-location.mts';
import { FileTrackerReview, type TrackerCommand, type TrackerRouteSnapshot } from './file-tracker-review.mts';
import { FileTrackerScope } from './file-tracker-scope.mts';
import { FileTrackerStore } from './file-tracker-store.mts';

type TrackerRoute = Readonly<{ rootDirectory: string; clientName: string; account: string }>;

export class FileTrackerOperations {
    static readonly openCommand = 'QA_OpenFileTracker';
    static readonly scopedOpenCommand = 'QA_OpenScopedFileTracker';
    static readonly commitCommand = 'QA_CommitFileTracker';
    static readonly startCommand = 'QA_StartFileTrackerCapture';
    static readonly statusCommand = 'QA_GetFileTrackerCaptureStatus';
    static readonly #maxId = 9223372036854775807n;
    static readonly #operationId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    static readonly #privateCorrelation = /^filetracker-[0-9a-f]{32}$/;
    readonly #host = hostname();
    readonly #git = new FileTrackerGit();
    readonly #store = new FileTrackerStore(this.#git);
    readonly #ignore = new FileTrackerIgnore(this.#git);
    readonly #capture = new FileTrackerCapture();
    readonly #jobs = new FileTrackerCaptureJobs();
    readonly #bindings = new Map<string, SelectedTracker>();
    readonly #getRoute: () => TrackerRoute;
    #routeVersion?: string;
    #routeGeneration = 0;
    #pending: Promise<void> = Promise.resolve();

    constructor(getRoute: () => TrackerRoute) { this.#getRoute = getRoute; }

    createReview(): FileTrackerReview {
        return new FileTrackerReview(this.#git, this.#store, () => this.routeSnapshot());
    }

    static handles(command: unknown): boolean {
        return this.isCaptureHandle(command) || this.isLegacyWrite(command);
    }

    static isCaptureHandle(command: unknown): boolean {
        return command === this.startCommand || command === this.statusCommand;
    }

    static isLegacyWrite(command: unknown): boolean {
        return command === this.openCommand || command === this.scopedOpenCommand || command === this.commitCommand;
    }

    get capturePending(): boolean { return this.#jobs.hasPending; }

    routeChanged(): void {
        this.#jobs.revoke();
        this.#routeGeneration++;
    }

    private invalidateBindings(): void {
        this.routeChanged();
        this.#bindings.clear();
        this.#routeVersion = undefined;
    }

    async open(command: TrackerCommand, result: object): Promise<void> {
        await this.run(() => this.openTracker(command, false), result, 'The private file tracker could not be opened safely.');
    }

    async openScoped(command: TrackerCommand, result: object): Promise<void> {
        await this.run(() => this.openTracker(command, true), result, 'The scoped file tracker could not be opened safely.');
    }

    async commit(command: TrackerCommand, result: object): Promise<void> {
        await this.run(() => this.commitTracker(command), result, 'The private file tracker capture failed.');
    }

    start(command: TrackerCommand, result: object): void {
        const scope = this.jobScope(command);
        const binding = scope && this.jobBinding(scope);
        const metadata = scope && this.jobMetadata(scope, command);
        if (!scope || !binding || !metadata) return this.unavailable(command, result);
        const existing = this.#jobs.find(scope, binding, metadata);
        if (existing) { Object.assign(result, existing); return; }
        const job = this.#jobs.reserve(scope, binding, metadata, this.#git.captureSelection());
        if (!job) return this.unavailable(command, result);
        Object.assign(result, job.receipt());
        void this.enqueue(() => this.#jobs.run(job));
    }

    status(command: TrackerCommand, result: object): void {
        const scope = this.jobScope(command);
        const binding = scope && this.jobBinding(scope);
        const receipt = scope && binding && this.#jobs.find(scope, binding);
        if (!receipt) return this.unavailable(command, result);
        Object.assign(result, receipt);
    }

    private jobScope(command: TrackerCommand): FileTrackerJobScope | undefined {
        const { id, operationId, trackerId, bindingId, conversationId } = command;
        if (command.version !== 1 || typeof id !== 'string' || !FileTrackerOperations.#privateCorrelation.test(id)
            || !FileTrackerOperations.isOperationId(operationId) || typeof trackerId !== 'string' || !FileTrackerStore.uuid.test(trackerId)
            || typeof bindingId !== 'string' || !FileTrackerStore.uuid.test(bindingId) || !this.isId(conversationId)) return undefined;
        return { operationId, trackerId, bindingId, conversationId };
    }

    private static isOperationId(value: unknown): value is string {
        return typeof value === 'string' && this.#operationId.test(value) && value !== '00000000-0000-0000-0000-000000000000';
    }

    private jobBinding(scope: FileTrackerJobScope): SelectedTracker | undefined {
        const binding = this.#bindings.get(scope.bindingId);
        if (!binding || binding.generation !== this.#routeGeneration || binding.store.manifest.trackerId !== scope.trackerId) return undefined;
        try {
            // Only check configured root identity on the poll thread; deep project/store validation lives in the worker.
            if (FileTrackerLocation.sameDirectory(FileTrackerLocation.directory(binding.route.root.path), binding.route.root)) return binding;
        } catch { /* a replaced or unavailable configured root is no longer this route */ }
        this.invalidateBindings();
    }

    private jobMetadata(scope: FileTrackerJobScope, command: TrackerCommand): FileTrackerCaptureMetadata | undefined {
        const { statementId, description, reviewProof } = command;
        if ((statementId !== null && !this.isId(statementId)) || !this.isDescription(description)
            || typeof reviewProof !== 'string' || !/^[A-Za-z0-9_-]{1,8192}$/u.test(reviewProof)) return undefined;
        return { conversationId: scope.conversationId, statementId, description, reviewProof };
    }

    private unavailable(command: TrackerCommand, result: object): void {
        const operationId = command.operationId;
        Object.assign(result, { success: false, version: 1, status: 'unknown',
            ...(FileTrackerOperations.isOperationId(operationId) ? { operationId } : {}) });
    }

    private enqueue<T>(action: () => Promise<T>): Promise<T> {
        const turn = this.#pending.then(action);
        this.#pending = turn.then(() => undefined, () => undefined);
        return turn;
    }

    private async run(action: () => Promise<object>, result: object, fallback: string): Promise<void> {
        try { Object.assign(result, await this.enqueue(action)); }
        catch (err) {
            const known = err instanceof FileTrackerError || err instanceof FileTrackerCaptureError;
            const unknown = err instanceof FileTrackerCaptureError && err.outcomeUnknown;
            Object.assign(result, { success: false, msg: known ? err.message : fallback, ...(unknown ? { outcomeUnknown: true } : {}) });
        }
    }

    private async openTracker(command: TrackerCommand, scoped: boolean) {
        const route = this.readRoute();
        const generation = this.#routeGeneration;
        if (typeof command.virtualRoot !== 'string' || command.virtualRoot !== route.rawRoot) {
            throw new FileTrackerError('The configured virtual root changed or did not match the trusted open request.');
        }
        const codeName = FileTrackerLocation.codeName(command.codeName);
        if (this.#bindings.size >= 512) throw new FileTrackerError('The client reached its pilot limit of open tracker bindings.');
        const location = FileTrackerLocation.project(route.rawRoot, command.projectPath);
        if (!scoped && Object.hasOwn(command, 'includeDirectories')) {
            throw new FileTrackerError('Use the scoped open command to request include directories explicitly.');
        }
        const includes = scoped ? FileTrackerScope.resolve(location.project.path, command.includeDirectories) : undefined;
        const verify = () => { this.verifySelection(location, route); };
        const store = await this.#store.open(location, codeName, route.machine, verify, includes);
        const binding = { location, store, route, generation };
        this.revalidate(binding);
        const warnings = await this.#ignore.warnings(location, store.repoPath);
        this.revalidate(binding);
        const bindingId = randomUUID();
        this.#bindings.set(bindingId, binding);
        return { success: true, trackerId: store.manifest.trackerId, bindingId, codeName,
            projectPath: location.projectPath, warnings, created: store.created,
            ...(store.manifest.version === 2 ? { includeDirectories: store.manifest.includeDirectories } : {}) };
    }

    private async commitTracker(command: TrackerCommand) {
        this.readRoute();
        const trackerId = command.trackerId;
        const bindingId = command.bindingId;
        if (typeof trackerId !== 'string' || !FileTrackerStore.uuid.test(trackerId)
            || typeof bindingId !== 'string' || !FileTrackerStore.uuid.test(bindingId)) throw FileTrackerBinding.stale();
        const binding = this.#bindings.get(bindingId);
        if (!binding || binding.store.manifest.trackerId !== trackerId) throw FileTrackerBinding.stale();
        const conversationId = this.id(command.conversationId);
        const statementId = command.statementId === null ? null : this.id(command.statementId);
        const description = command.description;
        if (!this.isDescription(description)) throw new FileTrackerError('Supply a nonblank capture description of at most 2048 characters.');
        const validateLocation = () => { this.revalidate(binding); };
        return this.#store.protectCapture(binding.store.repoPath, async () => {
            this.revalidate(binding);
            return this.#capture.capture({ rootPath: binding.location.project.path, repoPath: binding.store.repoPath,
                location: { ...binding.location, machine: binding.route.machine }, includes: binding.store.includes,
                conversationId, statementId, description, reviewProof: command.reviewProof, validateLocation, git: this.#git });
        });
    }

    private routeSnapshot(): TrackerRouteSnapshot {
        const route = this.#getRoute();
        if (typeof route.clientName !== 'string' || !route.clientName || typeof route.account !== 'string' || !route.account) throw FileTrackerBinding.stale();
        const machine = createHash('sha256').update(JSON.stringify([this.#host, route.clientName, route.account.toLowerCase()])).digest('hex');
        const root = FileTrackerLocation.configuredRoot(route.rootDirectory);
        const version = JSON.stringify([machine, route.rootDirectory, root.path, root.identity]);
        return { rawRoot: route.rootDirectory, machine, root, version };
    }

    private readRoute(): TrackerRouteSnapshot {
        try {
            const route = this.routeSnapshot();
            if (this.#routeVersion !== undefined && route.version !== this.#routeVersion) {
                this.invalidateBindings();
                return this.readRoute();
            }
            this.#routeVersion = route.version;
            return route;
        } catch (err) {
            this.invalidateBindings();
            throw err;
        }
    }

    private verifySelection(location: TrackerLocation, expected: TrackerRouteSnapshot): void {
        this.verifyRoute(expected);
        const current = FileTrackerLocation.project(expected.rawRoot, location.projectPath);
        if (!FileTrackerLocation.sameDirectory(current.project, location.project)) throw FileTrackerBinding.stale();
    }

    private verifyRoute(expected: TrackerRouteSnapshot): void {
        if (this.readRoute().version !== expected.version) throw FileTrackerBinding.stale();
    }

    private revalidate(binding: SelectedTracker): void {
        this.verifyRoute(binding.route);
        FileTrackerBinding.validate(binding, this.#store);
    }

    private isDescription(value: unknown): value is string {
        return typeof value === 'string' && !!value.trim() && value.isWellFormed() && value.length <= 2048 && !value.includes('\0');
    }

    private isId(value: unknown): value is string {
        return typeof value === 'string' && /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) <= FileTrackerOperations.#maxId;
    }

    private id(value: unknown): string {
        if (!this.isId(value)) throw new FileTrackerError('Trusted capture metadata must supply canonical positive signed-64-bit decimal identifiers.');
        return value;
    }
}
