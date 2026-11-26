import { randomUUID } from 'node:crypto';
import { closeSync, mkdtempSync, openSync, readSync, rmSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { FileTrackerError } from './file-tracker-location.mts';
import type { FileTrackerReviewObjects } from './file-tracker-review-objects.mts';

export type VersionSide = 'original' | 'final';
type SavedBlob = { sha: string; size: number; fd?: number };

// Each transfer owns one private disk spool, reused by all chunks. Only it can close its files.
export class FileTrackerVersionReader {
    readonly id = randomUUID();
    readonly #stop = new AbortController();
    readonly #scope: string;
    readonly #blobs: Record<VersionSide, SavedBlob | null>;
    readonly #scratch: string;
    readonly #expire: () => void;
    #timer?: NodeJS.Timeout;
    #phase: 'pending' | 'ready' | 'failed' = 'pending';
    #closed = false;

    constructor(scope: string, repoPath: string, original: SavedBlob | null, final: SavedBlob | null, expire: () => void) {
        this.#scope = scope;
        this.#blobs = { original, final };
        this.#scratch = mkdtempSync(join(dirname(repoPath), '.capture-'));
        this.#expire = expire;
        this.refresh();
    }

    assertScope(scope: string): void {
        if (this.#closed || this.#scope !== scope) throw this.invalid();
    }

    lengths() {
        return { originalSize: this.#blobs.original?.size.toString() ?? null,
            finalSize: this.#blobs.final?.size.toString() ?? null };
    }

    async copy(objects: FileTrackerReviewObjects): Promise<void> {
        for (const side of ['original', 'final'] as const) {
            const blob = this.#blobs[side];
            if (blob) await this.copyOne(objects, side, blob);
        }
    }

    private async copyOne(objects: FileTrackerReviewObjects, side: VersionSide, blob: SavedBlob): Promise<void> {
        if (this.#stop.signal.aborted) throw this.invalid();
        if (!blob.size) return; // The caller validates empty blobs before returning the open receipt.
        const fd = openSync(join(this.#scratch, side), 'wx+');
        blob.fd = fd;
        await objects.copyBlob(blob.sha, blob.size, chunk => {
            for (let index = 0; index < chunk.length;) {
                const written = writeSync(fd, chunk, index, chunk.length - index);
                if (written <= 0) throw this.invalid();
                index += written;
            }
        }, this.#stop.signal);
    }

    settle(verified: boolean): void {
        this.#phase = verified ? 'ready' : 'failed';
        if (!verified || this.#closed) this.cleanup();
    }

    chunk(side: VersionSide, offset: number): { pending: boolean; base64: string | null } {
        const blob = this.#blobs[side];
        if (this.#closed || this.#phase === 'failed' || !blob || offset < 0 || offset >= blob.size) throw this.invalid();
        this.refresh();
        if (this.#phase === 'pending') return { pending: true, base64: null };
        const bytes = Buffer.allocUnsafe(Math.min(65_536, blob.size - offset));
        for (let index = 0; index < bytes.length;) {
            const count = readSync(blob.fd!, bytes, index, bytes.length - index, offset + index);
            if (!count) throw this.invalid();
            index += count;
        }
        return { pending: false, base64: bytes.toString('base64') };
    }

    close(): void {
        if (this.#closed) return;
        this.#closed = true;
        clearTimeout(this.#timer);
        this.#stop.abort();
        if (this.#phase !== 'pending') this.cleanup();
    }

    private cleanup(): void {
        for (const blob of Object.values(this.#blobs)) {
            if (blob?.fd === undefined) continue;
            try { closeSync(blob.fd); } catch { /* private descriptor no longer usable */ }
            blob.fd = undefined;
        }
        try { rmSync(this.#scratch, { recursive: true, force: true }); } catch { /* private orphan, never opened by another reader */ }
    }

    private refresh(): void {
        clearTimeout(this.#timer);
        this.#timer = setTimeout(this.#expire, 120_000).unref();
    }

    private invalid(): FileTrackerError { return new FileTrackerError('The private checkpoint version transfer is no longer available.'); }
}
