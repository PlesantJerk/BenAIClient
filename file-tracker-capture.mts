import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { FileTrackerSource } from './file-tracker-files.mts';
import { FileTrackerCaptureError, FileTrackerGit } from './file-tracker-git.mts';
import { FileTrackerSnapshot } from './file-tracker-snapshot.mts';

export interface FileTrackerCaptureRequest {
    rootPath: string;
    repoPath: string;
    conversationId: string;
    statementId: string | null;
    description: string;
    validateLocation: () => void | Promise<void>;
    git?: FileTrackerGit;
}

export interface FileTrackerChange { path: string; oldSha: string | null; newSha: string | null }
export interface FileTrackerCaptureReceipt {
    success: true;
    changed: boolean;
    baseline: boolean;
    previousCommit: string | null;
    commit: string;
    added: FileTrackerChange[];
    modified: FileTrackerChange[];
    deleted: FileTrackerChange[];
    counts: { added: number; modified: number; deleted: number };
    truncated: boolean;
}

type Diff = Pick<FileTrackerCaptureReceipt, 'added' | 'modified' | 'deleted' | 'counts' | 'truncated'>;

export class FileTrackerCapture {
    private readonly git = new FileTrackerGit();
    private readonly ref = 'refs/heads/tracking';
    private readonly zeroSha = '0'.repeat(40);
    private readonly sha = /^[0-9a-f]{40}$/u;
    private readonly writers = new Map<string, Promise<void>>();

    async capture(request: FileTrackerCaptureRequest): Promise<FileTrackerCaptureReceipt> {
        const { rootPath, repoPath, validateLocation } = request;
        const git = request.git ?? this.git;
        const message = this.message(request);
        const key = repoPath.toLowerCase();
        const previousWriter = this.writers.get(key) ?? Promise.resolve();
        const result = previousWriter.then(() => this.captureLocked(rootPath, repoPath, git, message, validateLocation));
        const writer = result.then(() => {}, () => {});
        this.writers.set(key, writer);
        try { return await result; }
        finally { if (this.writers.get(key) === writer) this.writers.delete(key); }
    }

    private async captureLocked(rootPath: string, repoPath: string, git: FileTrackerGit, message: Buffer,
        validateLocation: () => void | Promise<void>): Promise<FileTrackerCaptureReceipt> {
        await validateLocation();
        this.assertPrivateLocation(rootPath, repoPath);
        const previousCommit = await this.head(git, repoPath);
        const previous = previousCommit ? await this.oldFiles(git, repoPath, previousCommit) : new Map<string, string>();
        const scratch = mkdtempSync(path.join(path.dirname(repoPath), '.capture-'));
        try {
            const snapshot = new FileTrackerSnapshot(git, repoPath, rootPath, scratch, previous);
            const current = await snapshot.capture();
            const diff = this.diff(previous, current);
            const changed = !previousCommit || Object.values(diff.counts).some(Boolean);
            if (!changed) return { success: true, changed, baseline: false, previousCommit, commit: await this.confirmUnchanged(git, repoPath, previousCommit!, validateLocation, snapshot), ...diff };
            const commit = await this.writeCommit(git, repoPath, scratch, previousCommit, current, message);
            await validateLocation();
            snapshot.assertRoot();
            // Compare-and-swap also protects the ref from a second desktop-client process.
            await git.run(repoPath, ['update-ref', '--no-deref', this.ref, commit, previousCommit ?? this.zeroSha]);
            return { success: true, changed, baseline: !previousCommit, previousCommit, commit, ...diff };
        } finally {
            // A scratch cleanup failure must never turn an already published ref into a retry signal.
            try { rmSync(scratch, { recursive: true, force: true }); } catch { /* private orphan, never reused */ }
        }
    }

    private assertPrivateLocation(rootPath: string, repoPath: string): void {
        const relative = path.relative(rootPath, repoPath).split(path.sep);
        if (relative.length !== 4 || relative[0] !== '.AIWork' || relative[1] !== 'tracking' || !FileTrackerSource.safeName(relative[2]) || relative[3] !== 'repo.git') {
            throw new FileTrackerCaptureError('The shadow Git repository must be inside the approved .AIWork/tracking directory.');
        }
    }

    private message(request: FileTrackerCaptureRequest): Buffer {
        const { conversationId, statementId, description } = request;
        if (!this.isId(conversationId) || (statementId !== null && !this.isId(statementId))) throw new FileTrackerCaptureError('File tracking requires trusted decimal conversation and statement IDs.');
        if (typeof description !== 'string' || !description.trim() || !description.isWellFormed() || description.length > 2048) {
            throw new FileTrackerCaptureError('File tracking requires a description of 1 to 2048 characters.');
        }
        // Keep Int64 digits intact, even above Number.MAX_SAFE_INTEGER. Only the description needs JSON escaping.
        return Buffer.from(`{"ConversationID":${conversationId},"StatementID":${statementId},"Description":${JSON.stringify(description)}}\n`, 'utf8');
    }

    private isId(value: unknown): value is string {
        return typeof value === 'string' && /^[1-9][0-9]{0,18}$/u.test(value) && BigInt(value) <= 9223372036854775807n;
    }

    private async head(git: FileTrackerGit, repoPath: string): Promise<string | null> {
        const result = await git.run(repoPath, ['rev-parse', '--verify', '--quiet', `${this.ref}^{commit}`], { allowExitCodes: [0, 1] });
        return result.exitCode === 1 ? null : this.parseSha(result.stdout);
    }

    private async confirmUnchanged(git: FileTrackerGit, repoPath: string, previous: string,
        validateLocation: () => void | Promise<void>, snapshot: FileTrackerSnapshot): Promise<string> {
        await validateLocation();
        snapshot.assertRoot();
        if (await this.head(git, repoPath) !== previous) throw new FileTrackerCaptureError('The private tracker changed during capture; no snapshot was published by this request.');
        return previous;
    }

    private async oldFiles(git: FileTrackerGit, repoPath: string, commit: string): Promise<Map<string, string>> {
        const { stdout } = await git.run(repoPath, ['ls-tree', '-r', '-z', '--full-tree', commit], { maxOutputBytes: 5 * 1024 * 1024 });
        const records = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(stdout).split('\0');
        if (records.pop() !== '' || records.length > 8_000) throw new FileTrackerCaptureError('The previous private tracker tree is unsupported.');
        const files = new Map<string, string>();
        for (const record of records) {
            const match = /^100644 blob ([0-9a-f]{40})\t(.+)$/su.exec(record);
            if (!match || match[2].length > 512 || !match[2].split('/').every(FileTrackerSource.safeName) || files.has(match[2])) {
                throw new FileTrackerCaptureError('The previous private tracker tree contains an unsupported path or object.');
            }
            files.set(match[2], match[1]);
        }
        return files;
    }

    private diff(previous: ReadonlyMap<string, string>, current: ReadonlyMap<string, string>): Diff {
        const result: Diff = { added: [], modified: [], deleted: [], counts: { added: 0, modified: 0, deleted: 0 }, truncated: false };
        let bytes = 0;
        for (const name of [...new Set([...previous.keys(), ...current.keys()])].sort()) {
            const oldSha = previous.get(name) ?? null;
            const newSha = current.get(name) ?? null;
            if (oldSha === newSha) continue;
            const type = !oldSha ? 'added' : !newSha ? 'deleted' : 'modified';
            const entry = { path: name, oldSha, newSha };
            result.counts[type]++;
            bytes += Buffer.byteLength(JSON.stringify(entry)) + 1;
            if (bytes > 12_000 || result.added.length + result.modified.length + result.deleted.length >= 60) result.truncated = true;
            else result[type].push(entry);
        }
        return result;
    }

    private async writeCommit(git: FileTrackerGit, repoPath: string, scratchRoot: string, parent: string | null,
        current: ReadonlyMap<string, string>, message: Buffer): Promise<string> {
        const entries = Array.from(current, ([file, sha]) => `100644 ${sha}\t${file}\0`).join('');
        await git.run(repoPath, ['update-index', '-z', '--index-info'], { input: Buffer.from(entries), scratchRoot });
        const tree = this.parseSha((await git.run(repoPath, ['write-tree'], { scratchRoot })).stdout);
        const args = ['commit-tree', tree, ...(parent ? ['-p', parent] : []), '-F', '-'];
        return this.parseSha((await git.run(repoPath, args, { input: message })).stdout);
    }

    private parseSha(bytes: Buffer): string {
        const value = bytes.toString('ascii').trimEnd();
        if (!this.sha.test(value)) throw new FileTrackerCaptureError('Private Git returned an invalid object ID.');
        return value;
    }
}
