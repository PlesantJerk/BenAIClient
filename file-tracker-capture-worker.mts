import { parentPort, workerData } from 'node:worker_threads';
import { FileTrackerBinding, type SelectedTracker } from './file-tracker-binding.mts';
import { FileTrackerCaptureFence } from './file-tracker-capture-fence.mts';
import { FileTrackerCapture, type FileTrackerCaptureReceipt } from './file-tracker-capture.mts';
import { FileTrackerCaptureError, FileTrackerGit, type FileTrackerGitSelection } from './file-tracker-git.mts';
import { FileTrackerError } from './file-tracker-location.mts';
import { FileTrackerStore } from './file-tracker-store.mts';

export type FileTrackerCaptureMetadata = Readonly<{
    conversationId: string; statementId: string | null; description: string; reviewProof?: string;
}>;
export type FileTrackerCaptureFailure = { success: false; msg: string; outcomeUnknown?: true };
export type FileTrackerCaptureResult = (FileTrackerCaptureReceipt & { msg: '' }) | FileTrackerCaptureFailure;
export type FileTrackerWorkerRequest = {
    binding: SelectedTracker; metadata: FileTrackerCaptureMetadata; git: FileTrackerGitSelection; state: Int32Array;
};

class FileTrackerCaptureWorker {
    readonly #binding: SelectedTracker;
    readonly #git: FileTrackerGit;
    readonly #store: FileTrackerStore;
    readonly #fence: FileTrackerCaptureFence;

    constructor(request: FileTrackerWorkerRequest) {
        this.#binding = request.binding;
        this.#git = new FileTrackerGit(request.git);
        this.#store = new FileTrackerStore(this.#git);
        this.#fence = new FileTrackerCaptureFence(request.state);
    }

    async capture(metadata: FileTrackerCaptureMetadata): Promise<FileTrackerCaptureResult> {
        const { location, store } = this.#binding;
        try {
            this.assertCurrent();
            // Refuse a changed binding before taking any path-dependent action, even when a queued job starts late.
            FileTrackerBinding.validate(this.#binding, this.#store);
            const receipt = await this.#store.protectCapture(store.repoPath, async () => {
                this.validateLocation();
                return new FileTrackerCapture().capture({ ...metadata, rootPath: location.project.path, repoPath: store.repoPath,
                    location: { ...location, machine: this.#binding.route.machine }, includes: store.includes,
                    validateLocation: this.validateLocation.bind(this), git: this.#git, publicationFence: this.#fence });
            });
            return { msg: '', ...receipt };
        } catch (error) {
            const known = error instanceof FileTrackerError || error instanceof FileTrackerCaptureError;
            const outcomeUnknown = error instanceof FileTrackerCaptureError ? error.outcomeUnknown : this.#fence.publicationAdmitted;
            return { success: false, msg: known ? error.message : 'The private file tracker capture failed.',
                ...(outcomeUnknown ? { outcomeUnknown: true } : {}) };
        }
    }

    private assertCurrent(): void {
        if (!this.#fence.isCurrent) throw FileTrackerBinding.stale();
    }

    private validateLocation(): void {
        this.assertCurrent();
        FileTrackerBinding.validate(this.#binding, this.#store);
        this.assertCurrent();
    }
}

if (parentPort) {
    const request = workerData as FileTrackerWorkerRequest;
    const worker = new FileTrackerCaptureWorker(request);
    parentPort.postMessage(await worker.capture(request.metadata));
}
