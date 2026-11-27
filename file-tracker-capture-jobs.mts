import { Worker } from 'node:worker_threads';
import { FileTrackerCaptureFence } from './file-tracker-capture-fence.mts';
import type { SelectedTracker } from './file-tracker-binding.mts';
import type { FileTrackerCaptureMetadata, FileTrackerCaptureResult, FileTrackerWorkerRequest } from './file-tracker-capture-worker.mts';
import type { FileTrackerGitSelection } from './file-tracker-git.mts';

export type FileTrackerJobScope = Readonly<{ operationId: string; trackerId: string; bindingId: string; conversationId: string }>;
export type FileTrackerJobReceipt = { success: true; version: 1; status: 'pending' | 'completed' | 'error'; operationId: string; result?: FileTrackerCaptureResult };

export class FileTrackerCaptureJob {
    readonly #scope: FileTrackerJobScope;
    readonly #binding: SelectedTracker;
    readonly #metadata: FileTrackerCaptureMetadata;
    readonly #git: FileTrackerGitSelection;
    readonly #fence = new FileTrackerCaptureFence();
    #result?: FileTrackerCaptureResult;
    #expiry?: NodeJS.Timeout;
    #retentionMs = 0;
    #expiresAt = Infinity;

    get expired(): boolean { return performance.now() >= this.#expiresAt; }

    constructor(scope: FileTrackerJobScope, binding: SelectedTracker, metadata: FileTrackerCaptureMetadata, git: FileTrackerGitSelection) {
        this.#scope = scope;
        this.#binding = binding;
        this.#metadata = metadata;
        this.#git = git;
    }

    matches(scope: FileTrackerJobScope, binding: SelectedTracker, metadata?: FileTrackerCaptureMetadata): boolean {
        const expected = this.#scope;
        return this.#binding === binding && expected.trackerId === scope.trackerId && expected.bindingId === scope.bindingId
            && expected.conversationId === scope.conversationId && (!metadata || (metadata.statementId === this.#metadata.statementId
                && metadata.description === this.#metadata.description && metadata.reviewProof === this.#metadata.reviewProof));
    }

    receipt(): FileTrackerJobReceipt {
        if (this.#expiry) {
            this.#expiresAt = performance.now() + this.#retentionMs;
            this.#expiry.refresh();
        }
        const operationId = this.#scope.operationId;
        const result = this.#result;
        if (!result) return { success: true, version: 1, status: 'pending', operationId };
        return { success: true, version: 1, status: result.success ? 'completed' : 'error', operationId, result };
    }

    async run(): Promise<void> {
        if (!this.#fence.isCurrent) return;
        try { this.#result = await this.capture(); }
        catch { this.#result = this.workerFailure(); }
    }

    retire(): void {
        this.#fence.revoke();
        clearTimeout(this.#expiry);
    }

    expireAfter(ms: number, jobs: Map<string, FileTrackerCaptureJob>): void {
        if (jobs.get(this.#scope.operationId) !== this) return;
        this.#retentionMs = ms;
        this.#expiresAt = performance.now() + ms;
        this.#expiry = setTimeout(() => jobs.delete(this.#scope.operationId), ms).unref();
    }

    private capture(): Promise<FileTrackerCaptureResult> {
        const workerData: FileTrackerWorkerRequest = { binding: this.#binding, metadata: this.#metadata, git: this.#git, state: this.#fence.state };
        return new Promise(resolve => {
            const worker = new Worker(new URL('./file-tracker-capture-worker.mts', import.meta.url), { workerData });
            let receipt: FileTrackerCaptureResult | undefined;
            worker.once('message', result => { receipt = result; });
            worker.once('error', () => { /* receipt is unavailable; wait for the worker to exit */ });
            worker.once('exit', () => { resolve(receipt ?? this.workerFailure()); });
        });
    }

    private workerFailure(): FileTrackerCaptureResult {
        return { success: false, msg: 'The private file tracker capture worker stopped without a receipt.',
            ...(this.#fence.publicationAdmitted ? { outcomeUnknown: true } : {}) };
    }
}

export class FileTrackerCaptureJobs {
    static readonly retentionMs = 20 * 60 * 1000;
    readonly #jobs = new Map<string, FileTrackerCaptureJob>();
    // Evict the actual handle/result. A UUIDv4 has no age, so keep only used IDs until desktop restart
    // to distinguish delayed START replays from new jobs, even after switching to a fresh binding.
    readonly #admittedIds = new Set<string>();
    #pending = 0;

    get hasPending(): boolean { return this.#pending !== 0; }

    find(scope: FileTrackerJobScope, binding: SelectedTracker, metadata?: FileTrackerCaptureMetadata): FileTrackerJobReceipt | undefined {
        const job = this.#jobs.get(scope.operationId);
        if (job?.expired) {
            job.retire();
            this.#jobs.delete(scope.operationId);
            return undefined;
        }
        if (job?.matches(scope, binding, metadata)) return job.receipt();
    }

    reserve(scope: FileTrackerJobScope, binding: SelectedTracker, metadata: FileTrackerCaptureMetadata,
        git: FileTrackerGitSelection): FileTrackerCaptureJob | undefined {
        if (this.#admittedIds.has(scope.operationId)) return undefined;
        const job = new FileTrackerCaptureJob(scope, binding, metadata, git);
        this.#admittedIds.add(scope.operationId);
        this.#jobs.set(scope.operationId, job);
        this.#pending++;
        return job;
    }

    async run(job: FileTrackerCaptureJob): Promise<void> {
        try { await job.run(); }
        finally {
            this.#pending--;
            job.expireAfter(FileTrackerCaptureJobs.retentionMs, this.#jobs);
        }
    }

    revoke(): void {
        for (const job of this.#jobs.values()) job.retire();
        this.#jobs.clear();
    }
}
