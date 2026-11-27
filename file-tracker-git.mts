import { spawn } from 'node:child_process';
import { Readable, pipeline } from 'node:stream';
import { lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';

import type { FileTrackerCaptureFence } from './file-tracker-capture-fence.mts';

export type FileTrackerGitSelection = Readonly<{ searchPath: string; executable?: string }>;

export interface FileTrackerGitOptions {
    publicationFence?: FileTrackerCaptureFence;
    input?: Buffer | Iterable<string | Buffer>;
    output?: (chunk: Buffer) => void;
    longRunning?: boolean;
    signal?: AbortSignal;
    workTree?: string;
    scratchRoot?: string;
    allowExitCodes?: readonly number[];
    maxOutputBytes?: number;
}

// Only path-free, intentional engine failures may be returned through the client route.
export class FileTrackerCaptureError extends Error {
    readonly outcomeUnknown: boolean;

    constructor(message: string, outcomeUnknown = false) {
        super(message);
        this.outcomeUnknown = outcomeUnknown;
    }
}

export class FileTrackerGit {
    private readonly searchPath: string;
    private executable?: string;
    private readonly commands = new Set(['init', 'check-ignore', 'rev-parse', 'ls-tree', 'hash-object', 'update-index', 'write-tree', 'commit-tree', 'update-ref', 'cat-file', 'merge-base']);

    constructor(selection?: FileTrackerGitSelection) {
        this.searchPath = selection?.searchPath ?? process.env.PATH ?? '';
        this.executable = selection?.executable;
    }

    captureSelection(): FileTrackerGitSelection { return { searchPath: this.searchPath, executable: this.executable }; }

    run(repoPath: string, args: readonly string[], options: FileTrackerGitOptions = {}): Promise<{ stdout: Buffer; exitCode: number }> {
        const command = args[0];
        this.validate(repoPath, command, options);
        const env = this.environment();
        if (options.scratchRoot && (command === 'update-index' || command === 'write-tree')) {
            env.GIT_INDEX_FILE = path.join(options.scratchRoot, 'index');
        }
        const cwd = options.workTree ?? (command === 'init' ? path.dirname(repoPath) : command === 'hash-object' ? options.scratchRoot! : repoPath);
        // All callers use <project>/.AIWork/tracking/<codeName>/repo.git, including cold checkpoint review.
        const executable = this.executableFor(path.resolve(repoPath, '../../../..'));
        return this.execute(executable, command, this.arguments(repoPath, args, options.workTree), cwd, env, options);
    }

    async records(repoPath: string, args: readonly string[], delimiter: number, consume: (line: Buffer) => void,
        options: FileTrackerGitOptions = {}): Promise<void> {
        let pieces: Buffer[] = [];
        await this.run(repoPath, args, { ...options, longRunning: true, output: chunk => {
            let start = 0;
            for (let end = chunk.indexOf(delimiter); end >= 0; end = chunk.indexOf(delimiter, start)) {
                const part = chunk.subarray(start, end);
                consume(pieces.length ? Buffer.concat([...pieces, part]) : part);
                pieces = [];
                start = end + 1;
            }
            if (start < chunk.length) pieces.push(chunk.subarray(start));
        } });
        if (pieces.length) throw new FileTrackerCaptureError('Private Git returned an incomplete record.');
    }

    private validate(repoPath: string, command: string, options: FileTrackerGitOptions): void {
        if (process.platform !== 'win32' || !this.commands.has(command) || !this.isLocalAbsolute(repoPath) || path.basename(repoPath) !== 'repo.git') {
            throw new FileTrackerCaptureError('File tracking requires an explicit private Windows repo.git and a supported Git command.');
        }
        const scratch = options.scratchRoot;
        if (scratch && (!this.isLocalAbsolute(scratch) || path.dirname(scratch) !== path.dirname(repoPath) || !/^\.capture-[A-Za-z0-9]+$/.test(path.basename(scratch)))) {
            throw new FileTrackerCaptureError('File tracking Git scratch path is invalid.');
        }
        if ((command === 'hash-object' || command === 'update-index' || command === 'write-tree' || command === 'check-ignore') && !scratch) {
            throw new FileTrackerCaptureError('File tracking Git command requires private scratch.');
        }
        if (command === 'check-ignore' ? options.workTree !== path.join(scratch!, 'rules') : options.workTree !== undefined) {
            throw new FileTrackerCaptureError('File tracking Git cannot use the monitored worktree.');
        }
    }

    private isLocalAbsolute(value: string): boolean {
        return /^[A-Za-z]:\\/.test(value) && path.normalize(value) === value && !value.slice(2).includes(':');
    }

    async checkAvailable(projectPath: string): Promise<void> {
        const executable = this.executableFor(projectPath);
        try {
            const result = await this.execute(executable, '--version', ['--version'], path.dirname(executable), this.environment(), {});
            if (/^git version [0-9]/.test(result.stdout.toString('utf8'))) return;
        } catch {
            // A non-runnable executable may fail synchronously in spawn or asynchronously in the child.
            // Report the same actionable preflight error without exposing the local executable path.
        }
        throw new FileTrackerCaptureError('BenAIClient found git.exe on its PATH but could not run git --version. Check the Git installation and restart BenAIClient.');
    }

    private executableFor(projectPath: string): string {
        const root = realpathSync.native(projectPath);
        if (this.executable) {
            if (this.safeExecutable(this.executable, root) === this.executable) return this.executable;
            throw new FileTrackerCaptureError('The selected Git executable is no longer available outside the tracked project. Check PATH and restart BenAIClient.');
        }
        for (const entry of this.searchPath.split(path.delimiter)) {
            const directory = path.normalize(entry.trim().replace(/^"(.*)"$/, '$1'));
            if (!this.isLocalAbsolute(directory)) continue; // Never infer the current directory, use PATHEXT, or ask a shell.
            const found = this.safeExecutable(path.join(directory, 'git.exe'), root);
            if (found) return this.executable = found;
        }
        throw new FileTrackerCaptureError('Could not find a usable git.exe on BenAIClient\'s PATH outside the tracked project. Add its installation directory to PATH and restart BenAIClient.');
    }

    private safeExecutable(candidate: string, projectRoot: string): string | undefined {
        // Keep the existing no-link rule for both the executable and its parent directories.
        try {
            if (!lstatSync(candidate).isFile()) return undefined;
            for (let p = path.dirname(candidate); p !== path.dirname(p); p = path.dirname(p)) {
                if (!lstatSync(p).isDirectory()) return undefined;
            }
            const actual = realpathSync.native(candidate);
            const fromProject = path.relative(projectRoot, actual);
            if (this.isLocalAbsolute(actual) && (path.isAbsolute(fromProject) || fromProject === '..' || fromProject.startsWith('..' + path.sep))) return actual;
        } catch (error) {
            if (!['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'EINVAL'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
        }
        return undefined;
    }

    private environment(): NodeJS.ProcessEnv {
        // Deliberately construct a new environment rather than attempting to blacklist inherited GIT_* variables.
        return {
            SystemRoot: 'C:\\Windows', WINDIR: 'C:\\Windows', PATH: 'C:\\Windows\\System32;C:\\Windows',
            LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: 'NUL', GIT_CONFIG_GLOBAL: 'NUL',
            GIT_ATTR_NOSYSTEM: '1', GIT_ALLOW_PROTOCOL: '', GIT_PROTOCOL_FROM_USER: '0', GIT_TERMINAL_PROMPT: '0',
            GIT_NO_LAZY_FETCH: '1', GIT_NO_REPLACE_OBJECTS: '1', GIT_OPTIONAL_LOCKS: '0',
            GIT_AUTHOR_NAME: 'BenAI File Tracker', GIT_AUTHOR_EMAIL: 'file-tracker@localhost',
            GIT_COMMITTER_NAME: 'BenAI File Tracker', GIT_COMMITTER_EMAIL: 'file-tracker@localhost',
        };
    }

    private arguments(repoPath: string, args: readonly string[], workTree?: string): string[] {
        return [
            '--no-pager', '--no-replace-objects', `--git-dir=${repoPath}`,
            '-c', `core.bare=${workTree ? 'false' : 'true'}`, '-c', 'core.hooksPath=NUL',
            '-c', 'core.excludesFile=NUL', '-c', 'core.attributesFile=NUL', '-c', 'core.fsmonitor=false',
            '-c', 'core.autocrlf=false', '-c', 'core.ignoreCase=true', '-c', 'core.protectNTFS=true',
            '-c', 'commit.gpgSign=false', '-c', 'maintenance.auto=false', '-c', 'gc.auto=0',
            ...(workTree ? [`--work-tree=${workTree}`] : []), ...args,
        ];
    }

    private execute(executable: string, command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, options: FileTrackerGitOptions): Promise<{ stdout: Buffer; exitCode: number }> {
        return new Promise((resolve, reject) => {
            if (command === 'update-ref' && options.publicationFence && !options.publicationFence.admitPublication()) {
                throw new FileTrackerCaptureError('The file tracker route changed before Git publication; no snapshot was published.');
            }
            const child = spawn(executable, args, { cwd, env, shell: false, windowsHide: true, stdio: 'pipe', signal: options.signal });
            const chunks: Buffer[] = [];
            let size = 0;
            let failure: Error | undefined;
            const stop = (message: string) => { failure ??= new FileTrackerCaptureError(message); child.kill(); };
            const timeout = options.longRunning ? undefined : setTimeout(() => stop(`Private Git ${command} timed out.`), 60_000);
            child.stdout.on('data', (chunk: Buffer) => {
                if (failure) return;
                if (options.output) {
                    try { options.output(chunk); }
                    catch (error) {
                        failure = error instanceof FileTrackerCaptureError ? error : new FileTrackerCaptureError(`Private Git ${command} output could not be used.`);
                        child.kill();
                    }
                    return;
                }
                size += chunk.length;
                if (size > (options.maxOutputBytes ?? 65_536)) stop(`Private Git ${command} exceeded its output limit.`);
                else chunks.push(chunk);
            });
            child.stderr.resume(); // Do not surface Git's raw paths, hooks, configuration or environment.
            child.stdin.on('error', (error: NodeJS.ErrnoException) => { if (error.code !== 'EPIPE') stop(`Private Git ${command} input failed.`); });
            child.once('error', () => { failure ??= new FileTrackerCaptureError(`Private Git ${command} could not start.`); });
            child.once('close', code => {
                clearTimeout(timeout);
                if (failure || code === null || !(options.allowExitCodes ?? [0]).includes(code)) {
                    const outcomeUnknown = command === 'update-ref' && child.pid !== undefined && (failure !== undefined || code === null);
                    const message = outcomeUnknown ? 'Private Git publication outcome is unknown; check the tracker before retrying.'
                        : failure?.message ?? (command === 'update-ref' ? 'Private Git could not publish this snapshot; the tracker may have changed or be locked.' : `Private Git ${command} failed (exit ${code}).`);
                    reject(new FileTrackerCaptureError(message, outcomeUnknown));
                } else resolve({ stdout: Buffer.concat(chunks), exitCode: code });
            });
            if (options.input === undefined || Buffer.isBuffer(options.input)) child.stdin.end(options.input);
            else pipeline(Readable.from(options.input), child.stdin, error => {
                if (error && !['EPIPE', 'ERR_STREAM_PREMATURE_CLOSE'].includes((error as NodeJS.ErrnoException).code ?? '')) {
                    stop(`Private Git ${command} input failed.`);
                }
            });
        });
    }
}
