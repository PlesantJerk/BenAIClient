import { createHash, type Hash } from 'node:crypto';
import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { FileTrackerSource, type TrackerDirectoryEntry } from './file-tracker-files.mts';
import { FileTrackerCaptureError, FileTrackerGit } from './file-tracker-git.mts';

interface RuleFile { absolute: string; sha: string; size: number }
interface Candidate { parts: string[]; relative: string; directory: boolean; tracked: boolean; rules?: RuleFile }
interface StagedBlob { name: string; sha: string }

export class FileTrackerSnapshot {
    private readonly source: FileTrackerSource;
    private readonly trackedFiles = new Set<string>();
    private readonly trackedDirectories = new Set<string>();
    private readonly snapshot = new Map<string, string>();
    private readonly stored = new Set<string>();
    private readonly staged: StagedBlob[] = [];
    private readonly workTree: string;
    private stagedBytes = 0;
    private readonly git: FileTrackerGit;
    private readonly repoPath: string;
    private readonly scratchRoot: string;
    private readonly prefix: string;
    private readonly previous: ReadonlyMap<string, string>;

    constructor(git: FileTrackerGit, repoPath: string, rootPath: string, scratchRoot: string, previous: ReadonlyMap<string, string>, prefix = '') {
        this.git = git;
        this.repoPath = repoPath;
        this.scratchRoot = scratchRoot;
        this.previous = previous;
        this.prefix = prefix;
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
            // Real directory stand-ins preserve directory ignores and prevent 'dir/*' matching 'dir/' itself.
            for (const { directory, parts } of candidates) if (directory) mkdirSync(path.join(this.workTree, ...parts));
            const ignored = await this.ignored(candidates.filter(candidate => !candidate.tracked));
            for (const candidate of candidates) {
                if (ignored.has(candidate.relative)) continue;
                if (candidate.directory) directories.push(candidate.parts);
                else {
                    this.captureFile(candidate);
                    // Flush batches to keep temporary disk consumption down, not to limit the capture.
                    if (this.staged.length >= 256 || this.stagedBytes >= 64 * 1024 * 1024) await this.storeBlobs();
                }
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
        let rules: RuleFile | undefined;
        let excluded = false;
        const entries = this.source.directory(parts, listing => {
            excluded = this.isGitDirectory(parts, listing);
            if (!excluded) rules = this.stageIgnoreFile(parts, listing);
        });
        if (excluded && !parts.length) throw new FileTrackerCaptureError('A Git administrative directory cannot be the monitored root.');
        if (excluded && this.trackedDirectories.has(parts.join('/').toLowerCase())) {
            throw new FileTrackerCaptureError('Previously tracked files are now inside a nested Git repository; no snapshot was published.');
        }
        if (excluded) return [];
        const names = new Set<string>();
        return entries.flatMap(entry => this.makeCandidate(parts, entry, names, rules));
    }

    private isGitDirectory(parts: string[], listing: TrackerDirectoryEntry[]): boolean {
        const names = new Set(listing.map(entry => entry.name.toLowerCase().replace(/[. ]+$/u, '')));
        return (parts.length > 0 && names.has('.git')) || (names.has('head') && (
            (names.has('objects') && (names.has('refs') || names.has('reftable') || names.has('packed-refs'))) ||
            (names.has('gitdir') && names.has('commondir'))));
    }

    private stageIgnoreFile(parts: string[], listing: TrackerDirectoryEntry[]): RuleFile | undefined {
        const rules = listing.filter(entry => entry.name.toLowerCase() === '.gitignore');
        if (rules.length === 0) return undefined;
        if (rules.length !== 1 || rules[0].directory || rules[0].unsafe) throw new FileTrackerCaptureError('File tracking found an ambiguous or unsafe .gitignore.');
        const absolute = path.join(this.workTree, ...parts, '.gitignore');
        const blob = this.copyBlob([...parts, rules[0].name], absolute);
        if (!blob) throw new FileTrackerCaptureError('File tracking will not read a linked .gitignore.');
        return blob;
    }

    private makeCandidate(parent: string[], entry: TrackerDirectoryEntry, names: Set<string>, rules?: RuleFile): Candidate[] {
        const name = entry.name.toLowerCase();
        if (name === '.aiwork' || name === '.git' || /^git~[1-9]$/u.test(name)) return [];
        const parts = [...parent, entry.name];
        const relative = parts.join('/');
        const key = relative.toLowerCase();
        if (!FileTrackerSource.safeName(entry.name) || entry.unsafe || this.prefix.length + relative.length > 512) {
            if (this.trackedFiles.has(key) || this.trackedDirectories.has(key)) throw new FileTrackerCaptureError('A tracked path became unsafe; no snapshot was published.');
            return [];
        }
        if (names.has(name)) throw new FileTrackerCaptureError('File tracking does not support case-colliding names within one directory.');
        names.add(name);
        const tracked = (entry.directory ? this.trackedDirectories : this.trackedFiles).has(key);
        return [{ parts, relative, directory: entry.directory, tracked, rules: name === '.gitignore' ? rules : undefined }];
    }

    private async ignored(candidates: Candidate[]): Promise<Set<string>> {
        const ignored = new Set<string>();
        if (!candidates.length) return ignored;
        const input = function* () { for (const entry of candidates) yield entry.relative + '\0'; };
        let field = 0, index = 0, source = false, negated = false;
        await this.git.records(this.repoPath, ['check-ignore', '--no-index', '-z', '-v', '-n', '--stdin'], 0, value => {
            if (field === 0) source = value.length !== 0;
            if (field === 2) negated = value[0] === 33;
            if (field === 3) {
                const name = candidates[index++]?.relative;
                if (name !== value.toString('utf8')) throw new FileTrackerCaptureError('Private Git returned an unexpected ignore pathname.');
                if (source && !negated) ignored.add(name);
            }
            field = (field + 1) % 4;
        }, { input: input(), workTree: this.workTree, scratchRoot: this.scratchRoot, allowExitCodes: [0, 1] });
        if (index !== candidates.length || field !== 0) throw new FileTrackerCaptureError('Private Git returned an invalid ignore result.');
        return ignored;
    }

    private captureFile(candidate: Candidate): void {
        const name = `blobs/${this.staged.length}`;
        const destination = path.join(this.scratchRoot, name);
        const blob = candidate.rules ?? this.copyBlob(candidate.parts, destination);
        if (!blob) {
            if (candidate.tracked) throw new FileTrackerCaptureError('A tracked file became a link or special file; no snapshot was published.');
            return;
        }
        this.snapshot.set(candidate.relative, blob.sha);
        if (this.previous.get(candidate.relative) === blob.sha || this.stored.has(blob.sha)) {
            if (!candidate.rules) rmSync(destination);
            return;
        }
        if (candidate.rules) copyFileSync(blob.absolute, destination);
        this.staged.push({ name, sha: blob.sha });
        this.stored.add(blob.sha);
        this.stagedBytes += blob.size;
    }

    private copyBlob(parts: string[], absolute: string): RuleFile | undefined {
        let hash: Hash | undefined, size = 0;
        const staged = this.source.copyFile(parts, absolute, (length, bytes) => {
            if (!hash) { size = length; hash = createHash('sha1').update(`blob ${length}\0`); }
            hash.update(bytes);
        });
        return staged ? { absolute, size, sha: hash!.digest('hex') } : undefined;
    }

    private async storeBlobs(): Promise<void> {
        if (!this.staged.length) return;
        let index = 0;
        await this.git.records(this.repoPath, ['hash-object', '-w', '--no-filters', '--stdin-paths'], 10, line => {
            if (this.staged[index++]?.sha !== line.toString('ascii').trimEnd()) throw new FileTrackerCaptureError('Private Git did not confirm the exact staged blob bytes.');
        }, { input: Buffer.from(this.staged.map(blob => blob.name + '\n').join('')), scratchRoot: this.scratchRoot });
        if (index !== this.staged.length) throw new FileTrackerCaptureError('Private Git did not confirm the exact staged blob bytes.');
        for (const blob of this.staged) rmSync(path.join(this.scratchRoot, blob.name));
        this.staged.length = 0;
        this.stagedBytes = 0;
    }
}
