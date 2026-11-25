import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { FileTrackerSource, type TrackerDirectoryEntry } from './file-tracker-files.mts';
import { FileTrackerCaptureError, FileTrackerGit } from './file-tracker-git.mts';

interface Candidate { parts: string[]; relative: string; directory: boolean; tracked: boolean; ruleBytes?: Buffer }
interface StagedBlob { name: string; sha: string }

export class FileTrackerSnapshot {
    private readonly source: FileTrackerSource;
    private readonly trackedFiles = new Set<string>();
    private readonly trackedDirectories = new Set<string>();
    private readonly snapshot = new Map<string, string>();
    private readonly staged = new Map<string, StagedBlob>();
    private readonly workTree: string;
    private rulesBytes = 0;
    private bytes = 0;
    private entryCount = 0;
    private fileCount = 0;
    private readonly maxEntries = 30_000;
    private readonly maxFiles = 8_000;
    private readonly maxDepth = 48;
    private readonly maxBytes = 256 * 1024 * 1024;
    private readonly maxFileBytes = 16 * 1024 * 1024;

    private readonly git: FileTrackerGit;
    private readonly repoPath: string;
    private readonly scratchRoot: string;
    private readonly previous: ReadonlyMap<string, string>;

    constructor(git: FileTrackerGit, repoPath: string, rootPath: string, scratchRoot: string, previous: ReadonlyMap<string, string>) {
        this.git = git;
        this.repoPath = repoPath;
        this.scratchRoot = scratchRoot;
        this.previous = previous;
        this.source = new FileTrackerSource(rootPath);
        this.workTree = path.join(scratchRoot, 'rules');
        for (const name of previous.keys()) this.rememberTrackedPath(name);
    }

    assertRoot(): void { this.source.assertRoot(); }

    async capture(): Promise<Map<string, string>> {
        mkdirSync(this.workTree);
        mkdirSync(path.join(this.scratchRoot, 'blobs'));
        let directories = [[]] as string[][];
        while (directories.length) {
            const candidates = directories.flatMap(parts => this.enumerate(parts));
            directories = [];
            // Let Git determine directory type from empty private stand-ins. Appending '/' would
            // wrongly let 'dir/*' match 'dir/' itself and hide explicitly re-included children.
            for (const candidate of candidates) {
                if (candidate.directory) mkdirSync(path.join(this.workTree, ...candidate.parts));
            }
            const ignored = await this.ignored(candidates.filter(candidate => !candidate.tracked));
            for (const candidate of candidates) {
                if (ignored.has(candidate.relative)) continue;
                if (candidate.directory) directories.push(candidate.parts);
                else this.captureFile(candidate);
            }
        }
        this.source.assertRoot();
        await this.storeBlobs();
        return this.snapshot;
    }

    private rememberTrackedPath(name: string): void {
        const parts = name.toLowerCase().split('/');
        this.trackedFiles.add(parts.join('/'));
        while (parts.length > 1) {
            parts.pop();
            this.trackedDirectories.add(parts.join('/'));
        }
    }

    private enumerate(parts: string[]): Candidate[] {
        if (parts.length > this.maxDepth) throw new FileTrackerCaptureError('File tracking exceeded its directory depth limit.');
        let ruleBytes: Buffer | undefined;
        let excluded = false;
        const entries = this.source.directory(parts, this.maxEntries - this.entryCount, listing => {
            excluded = this.isGitDirectory(parts, listing);
            if (!excluded) ruleBytes = this.stageIgnoreFile(parts, listing);
        });
        this.entryCount += entries.length;
        if (excluded && !parts.length) throw new FileTrackerCaptureError('A Git administrative directory cannot be the monitored root.');
        if (excluded && this.trackedDirectories.has(parts.join('/').toLowerCase())) {
            throw new FileTrackerCaptureError('Previously tracked files are now inside a nested Git repository; no snapshot was published.');
        }
        if (excluded) return [];
        const names = new Set<string>();
        return entries.flatMap(entry => this.makeCandidate(parts, entry, names, ruleBytes));
    }

    private isGitDirectory(parts: string[], listing: TrackerDirectoryEntry[]): boolean {
        const names = new Set(listing.map(entry => entry.name.toLowerCase().replace(/[. ]+$/u, '')));
        return (parts.length > 0 && names.has('.git')) || (names.has('head') && (
            (names.has('objects') && (names.has('refs') || names.has('reftable') || names.has('packed-refs'))) ||
            (names.has('gitdir') && names.has('commondir'))));
    }

    private stageIgnoreFile(parts: string[], listing: TrackerDirectoryEntry[]): Buffer | undefined {
        const rules = listing.filter(entry => entry.name.toLowerCase() === '.gitignore');
        if (rules.length === 0) return undefined;
        if (rules.length !== 1 || rules[0].directory || rules[0].unsafe) throw new FileTrackerCaptureError('File tracking found an ambiguous or unsafe .gitignore.');
        const file = this.source.readFile([...parts, rules[0].name], Math.min(256 * 1024, 4 * 1024 * 1024 - this.rulesBytes));
        if (file.link) throw new FileTrackerCaptureError('File tracking will not read a linked .gitignore.');
        const location = path.join(this.workTree, ...parts);
        mkdirSync(location, { recursive: true });
        writeFileSync(path.join(location, '.gitignore'), file.bytes, { flag: 'wx' });
        this.rulesBytes += file.bytes.length;
        return file.bytes;
    }

    private makeCandidate(parent: string[], entry: TrackerDirectoryEntry, names: Set<string>, ruleBytes?: Buffer): Candidate[] {
        const name = entry.name.toLowerCase();
        if (name === '.aiwork' || name === '.git' || /^git~[1-9]$/u.test(name)) return [];
        const parts = [...parent, entry.name];
        const relative = parts.join('/');
        const key = relative.toLowerCase();
        if (!FileTrackerSource.safeName(entry.name) || entry.unsafe || relative.length > 512) {
            if (this.trackedFiles.has(key) || this.trackedDirectories.has(key)) throw new FileTrackerCaptureError('A tracked path became unsafe; no snapshot was published.');
            return [];
        }
        if (names.has(name)) throw new FileTrackerCaptureError('File tracking does not support case-colliding names within one directory.');
        names.add(name);
        const tracked = (entry.directory ? this.trackedDirectories : this.trackedFiles).has(key);
        return [{ parts, relative, directory: entry.directory, tracked, ruleBytes: name === '.gitignore' ? ruleBytes : undefined }];
    }

    private async ignored(candidates: Candidate[]): Promise<Set<string>> {
        const ignored = new Set<string>();
        if (!candidates.length) return ignored;
        const names = candidates.map(entry => entry.relative);
        const { stdout } = await this.git.run(this.repoPath, ['check-ignore', '--no-index', '-z', '-v', '-n', '--stdin'], {
            input: Buffer.from(names.join('\0') + '\0'), workTree: this.workTree, scratchRoot: this.scratchRoot,
            allowExitCodes: [0, 1], maxOutputBytes: 24 * 1024 * 1024,
        });
        const fields = stdout.toString('utf8').split('\0');
        if (fields.length !== names.length * 4 + 1 || fields.at(-1) !== '') throw new FileTrackerCaptureError('Private Git returned an invalid ignore result.');
        for (let i = 0; i < names.length; i++) {
            const [source, , pattern, name] = fields.slice(i * 4, i * 4 + 4);
            if (name !== names[i]) throw new FileTrackerCaptureError('Private Git returned an unexpected ignore pathname.');
            if (source && !pattern.startsWith('!')) ignored.add(candidates[i].relative);
        }
        return ignored;
    }

    private captureFile(candidate: Candidate): void {
        if (++this.fileCount > this.maxFiles) throw new FileTrackerCaptureError('File tracking exceeded its file count limit.');
        const limit = Math.min(this.maxFileBytes, this.maxBytes - this.bytes);
        const file = candidate.ruleBytes !== undefined ? { bytes: candidate.ruleBytes, link: false } : this.source.readFile(candidate.parts, limit);
        if (file.link) {
            if (candidate.tracked) throw new FileTrackerCaptureError('A tracked file became a link or special file; no snapshot was published.');
            return;
        }
        const bytes = file.bytes;
        if (bytes.length > limit) throw new FileTrackerCaptureError('File tracking exceeded its total byte limit.');
        const sha = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
        this.snapshot.set(candidate.relative, sha);
        this.bytes += bytes.length;
        if (this.previous.get(candidate.relative) !== sha && !this.staged.has(sha)) this.stageBlob(sha, bytes);
    }

    private stageBlob(sha: string, bytes: Buffer): void {
        const name = `blobs/${this.staged.size}`;
        writeFileSync(path.join(this.scratchRoot, name), bytes, { flag: 'wx' });
        this.staged.set(sha, { name, sha });
    }

    private async storeBlobs(): Promise<void> {
        if (!this.staged.size) return;
        const blobs = [...this.staged.values()];
        const { stdout } = await this.git.run(this.repoPath, ['hash-object', '-w', '--no-filters', '--stdin-paths'], {
            input: Buffer.from(blobs.map(blob => blob.name + '\n').join('')), scratchRoot: this.scratchRoot,
            maxOutputBytes: this.maxFiles * 42,
        });
        const output = stdout.toString('ascii').trimEnd().split(/\r?\n/u);
        if (output.length !== blobs.length || blobs.some((blob, i) => blob.sha !== output[i])) throw new FileTrackerCaptureError('Private Git did not confirm the exact staged blob bytes.');
    }
}
