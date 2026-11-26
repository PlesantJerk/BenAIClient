import { createHash } from 'node:crypto';
import { FileTrackerSource } from './file-tracker-files.mts';
import { FileTrackerGit } from './file-tracker-git.mts';
import { FileTrackerError } from './file-tracker-location.mts';

export type CheckpointPair = Readonly<{ startCommit: string | null; endCommit: string }>;
export type CheckpointProvenance = Readonly<{ conversationId: string; statementId: string | null; description: string; reviewProof: string | null }>;
type Commit = Readonly<{ tree: string; parent: string | null; message: string }>;
type TreeDirectory = Map<string, TreeMember>;
type TreeMember = { name: string; sha: string } | { name: string; directory: TreeDirectory };
export type CheckpointVersion = Readonly<{
    status: 'missing' | 'text' | 'binary' | 'tooLarge' | 'unsupportedEncoding';
    size: number | null; encoding: 'utf8' | 'utf8-bom' | 'utf16le-bom' | 'utf16be-bom' | null; base64: string | null;
}>;

export class FileTrackerReviewObjects {
    static readonly #displayBytes = 65_536;
    static readonly #id = /^[0-9a-f]{40}$/u;
    readonly #git: FileTrackerGit;
    readonly #repo: string;

    constructor(git: FileTrackerGit, repo: string) { this.#git = git; this.#repo = repo; }

    static isSha(value: unknown): value is string { return typeof value === 'string' && value.length === 40 && this.#id.test(value) && value !== '0'.repeat(40); }

    static isPath(value: unknown): value is string {
        return typeof value === 'string' && value.length <= 512 && value.split('/').every(FileTrackerSource.safeName);
    }

    async assertReachable(endCommit: string, head: string, knownHead?: string): Promise<void> {
        if (!FileTrackerReviewObjects.isSha(head)) throw this.invalid();
        if (head === knownHead || head === endCommit) return;
        await this.commit(head);
        const { exitCode } = await this.#git.run(this.#repo, ['merge-base', '--is-ancestor', endCommit, head], { allowExitCodes: [0, 1], longRunning: true });
        if (exitCode !== 0) throw this.invalid();
    }

    async readPair(pair: CheckpointPair): Promise<{ original: Map<string, string>; final: Map<string, string>; provenance: CheckpointProvenance }> {
        const end = await this.commit(pair.endCommit);
        if (end.parent !== pair.startCommit) throw this.invalid();
        const provenance = this.provenance(end.message);
        const start = pair.startCommit === null ? null : await this.commit(pair.startCommit);
        const [original, final] = await this.readBoth(start ? this.tree(start.tree) : new Map<string, string>(), this.tree(end.tree));
        return { original, final, provenance };
    }

    private async commit(sha: string): Promise<Commit> {
        const { stdout } = await this.#git.run(this.#repo, ['cat-file', 'commit', sha], { maxOutputBytes: 24 * 1024 });
        this.assertObject(sha, 'commit', stdout);
        const text = this.utf8(stdout);
        const separator = text.indexOf('\n\n');
        if (separator < 0) throw this.invalid();
        const [treeLine, ...headers] = text.slice(0, separator).split('\n');
        const parents = headers.filter(line => line.startsWith('parent ')).map(line => line.slice(7));
        const tree = treeLine?.slice(5);
        if (!treeLine?.startsWith('tree ') || !FileTrackerReviewObjects.isSha(tree) || parents.length > 1
            || parents.some(parent => !FileTrackerReviewObjects.isSha(parent))) throw this.invalid();
        return { tree, parent: parents[0] ?? null, message: text.slice(separator + 2) };
    }

    private provenance(message: string): CheckpointProvenance {
        const match = /^\{"ConversationID":([1-9][0-9]{0,18}),"StatementID":(null|[1-9][0-9]{0,18}),"Description":("(?:[^"\\]|\\.)*")(?:,"ReviewProof":"([A-Za-z0-9_-]{1,8192})")?\}\n$/u.exec(message);
        if (!match) throw this.invalid();
        const [, conversationId, statement, encoded, reviewProof] = match;
        const statementId = statement === 'null' ? null : statement;
        if ([conversationId, statementId].some(id => id !== null && BigInt(id) > 9223372036854775807n)) throw this.invalid();
        const description: unknown = JSON.parse(encoded);
        if (typeof description !== 'string' || description.length > 2048 || !description.trim() || !description.isWellFormed()
            || description.includes('\0') || JSON.stringify(description) !== encoded) throw this.invalid();
        return { conversationId, statementId, description, reviewProof: reviewProof ?? null };
    }

    private async tree(sha: string): Promise<Map<string, string>> {
        const files = new Map<string, string>();
        const root: TreeDirectory = new Map();
        await this.#git.records(this.#repo, ['ls-tree', '-r', '-z', '--full-tree', sha, '--'], 0, bytes => {
            const match = /^100644 blob ([0-9a-f]{40})\t(.+)$/su.exec(this.utf8(bytes));
            if (!match || !FileTrackerReviewObjects.isSha(match[1]) || !FileTrackerReviewObjects.isPath(match[2])) throw this.invalid();
            this.addPath(match[2], match[1], root);
            files.set(match[2], match[1]);
        });
        // Only canonical captured trees are accepted; Git can parse a substituted loose object without hashing it.
        if (this.treeSha(root) !== sha) throw this.invalid();
        return files;
    }

    private addPath(path: string, sha: string, root: TreeDirectory): void {
        const parts = path.split('/');
        let directory = root;
        for (const [i, name] of parts.entries()) {
            const key = name.toLowerCase();
            const member = directory.get(key);
            if (i === parts.length - 1) {
                if (member) throw this.invalid();
                directory.set(key, { name, sha });
            } else if (!member) {
                const child: TreeDirectory = new Map();
                directory.set(key, { name, directory: child });
                directory = child;
            } else {
                if (member.name !== name || !('directory' in member)) throw this.invalid();
                directory = member.directory;
            }
        }
    }

    private treeSha(directory: TreeDirectory): string {
        const sorted = Array.from(directory.values(), member => ({ member,
            sortKey: Buffer.from(member.name + ('directory' in member ? '/' : '')) }));
        sorted.sort((a, b) => Buffer.compare(a.sortKey, b.sortKey));
        const length = sorted.reduce((sum, { member, sortKey }) => sum + sortKey.length + ('directory' in member ? 26 : 28), 0);
        const hash = createHash('sha1').update(`tree ${length}\0`);
        for (const { member } of sorted) hash.update(this.treeMemberBytes(member));
        return hash.digest('hex');
    }

    private treeMemberBytes(member: TreeMember): Buffer {
        const isDirectory = 'directory' in member;
        const sha = isDirectory ? this.treeSha(member.directory) : member.sha;
        return Buffer.concat([Buffer.from(`${isDirectory ? '40000' : '100644'} ${member.name}\0`), Buffer.from(sha, 'hex')]);
    }

    versions(oldSha: string | null, newSha: string | null): Promise<[CheckpointVersion, CheckpointVersion]> {
        return this.readBoth(this.version(oldSha), this.version(newSha));
    }

    private async readBoth<T>(first: T | Promise<T>, second: T | Promise<T>): Promise<[T, T]> {
        // A failed peer must not release the repository pins before both launched Git reads have settled.
        const [left, right] = await Promise.allSettled([first, second]);
        if (left.status === 'rejected') throw left.reason;
        if (right.status === 'rejected') throw right.reason;
        return [left.value, right.value];
    }

    private async version(sha: string | null): Promise<CheckpointVersion> {
        if (sha === null) return this.unshown('missing', null);
        const size = await this.blobSize(sha);
        if (size > FileTrackerReviewObjects.#displayBytes) return this.unshown('tooLarge', size);
        const { stdout } = await this.#git.run(this.#repo, ['cat-file', 'blob', sha], { maxOutputBytes: FileTrackerReviewObjects.#displayBytes });
        if (stdout.length !== size) throw this.invalid();
        this.assertObject(sha, 'blob', stdout);
        return this.classify(stdout);
    }

    async copyBlob(sha: string, size: number, consume: (chunk: Buffer) => void, signal?: AbortSignal): Promise<void> {
        const hash = createHash('sha1').update(`blob ${size}\0`);
        let actual = 0;
        await this.#git.run(this.#repo, ['cat-file', 'blob', sha], { longRunning: true, signal, output: chunk => {
            actual += chunk.length;
            if (actual > size) throw this.invalid();
            hash.update(chunk);
            consume(chunk);
        } });
        if (size !== actual || hash.digest('hex') !== sha) throw this.invalid();
    }

    async blobSize(sha: string): Promise<number> {
        const { stdout } = await this.#git.run(this.#repo, ['cat-file', '--batch-check'], { input: Buffer.from(`${sha}\n`), maxOutputBytes: 96 });
        const match = /^([0-9a-f]{40}) blob (0|[1-9][0-9]{0,15})\n$/u.exec(stdout.toString('latin1'));
        const size = Number(match?.[2]);
        if (match?.[1] !== sha || !Number.isSafeInteger(size)) throw this.invalid();
        return size;
    }

    private classify(bytes: Buffer): CheckpointVersion {
        const prefix = bytes.subarray(0, 4).toString('hex');
        if (prefix === 'fffe0000' || prefix === '0000feff') return this.unshown('unsupportedEncoding', bytes.length);
        const format = prefix.startsWith('fffe') ? ['utf16le-bom', 'utf-16le'] as const
            : prefix.startsWith('feff') ? ['utf16be-bom', 'utf-16be'] as const
            : prefix.startsWith('efbbbf') ? ['utf8-bom', 'utf-8'] as const : ['utf8', 'utf-8'] as const;
        if (format[1] === 'utf-8' && bytes.includes(0)) return this.unshown('binary', bytes.length);
        let text: string;
        try { text = new TextDecoder(format[1], { fatal: true }).decode(bytes); }
        catch { return this.unshown('unsupportedEncoding', bytes.length); }
        if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(text)) return this.unshown('binary', bytes.length);
        return { status: 'text', size: bytes.length, encoding: format[0], base64: bytes.toString('base64') };
    }

    private unshown(status: Exclude<CheckpointVersion['status'], 'text'>, size: number | null): CheckpointVersion {
        return { status, size, encoding: null, base64: null };
    }

    private assertObject(sha: string, kind: 'commit' | 'blob', bytes: Buffer): void {
        if (this.objectSha(kind, bytes) !== sha) throw this.invalid();
    }

    private objectSha(kind: 'commit' | 'tree' | 'blob', bytes: Buffer): string {
        return createHash('sha1').update(`${kind} ${bytes.length}\0`).update(bytes).digest('hex');
    }

    private utf8(value: Buffer): string { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(value); }

    private invalid(): FileTrackerError { return new FileTrackerError('The checkpoint objects are missing, invalid or not part of this private tracker.'); }
}
