import { spawn } from 'node:child_process';
import { lstatSync } from 'node:fs';
import path from 'node:path';

export interface FileTrackerGitOptions {
    input?: Buffer;
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
    private readonly executable = 'C:\\Program Files\\Git\\cmd\\git.exe';
    private readonly commands = new Set(['init', 'check-ignore', 'rev-parse', 'ls-tree', 'hash-object', 'update-index', 'write-tree', 'commit-tree', 'update-ref', 'cat-file', 'merge-base']);

    run(repoPath: string, args: readonly string[], options: FileTrackerGitOptions = {}): Promise<{ stdout: Buffer; exitCode: number }> {
        const command = args[0];
        this.validate(repoPath, command, options);
        const env = this.environment();
        if (options.scratchRoot && (command === 'update-index' || command === 'write-tree')) {
            env.GIT_INDEX_FILE = path.join(options.scratchRoot, 'index');
        }
        const cwd = options.workTree ?? (command === 'init' ? path.dirname(repoPath) : command === 'hash-object' ? options.scratchRoot! : repoPath);
        return this.execute(command, this.arguments(repoPath, args, options.workTree), cwd, env, options);
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
        this.assertInstalledGit();
    }

    private isLocalAbsolute(value: string): boolean {
        return /^[A-Za-z]:\\/.test(value) && path.normalize(value) === value && !value.slice(2).includes(':');
    }

    private assertInstalledGit(): void {
        // No PATH lookup, per-user installation, configuration override, shell or executable from the tracked root.
        for (const entry of ['C:\\Program Files', 'C:\\Program Files\\Git', 'C:\\Program Files\\Git\\cmd', this.executable]) {
            const stat = lstatSync(entry, { throwIfNoEntry: false });
            if (!stat || stat.isSymbolicLink() || (entry === this.executable ? !stat.isFile() : !stat.isDirectory())) {
                throw new FileTrackerCaptureError('File tracking requires the machine-installed Git for Windows in C:\\Program Files\\Git.');
            }
        }
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

    private execute(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, options: FileTrackerGitOptions): Promise<{ stdout: Buffer; exitCode: number }> {
        return new Promise((resolve, reject) => {
            const child = spawn(this.executable, args, { cwd, env, shell: false, windowsHide: true, stdio: 'pipe' });
            const chunks: Buffer[] = [];
            let size = 0;
            let failure: Error | undefined;
            const stop = (message: string) => { failure ??= new FileTrackerCaptureError(message); child.kill(); };
            const timeout = setTimeout(() => stop(`Private Git ${command} timed out.`), 60_000);
            child.stdout.on('data', (chunk: Buffer) => {
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
            child.stdin.end(options.input);
        });
    }
}
