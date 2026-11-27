import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PollClient } from './poll-client.mjs';

class GitDiscoveryChecks {
    clientPath = path.resolve(process.env.FILE_TRACKER_QA_CLIENT ?? fileURLToPath(new URL('../../', import.meta.url)));
    scratch = fs.realpathSync(process.env.FILE_TRACKER_QA_TMP ?? os.tmpdir());
    runDirectory;
    virtualRoot;
    client;
    oracle;
    realBin;
    emptyBin;
    workingDirectory = process.cwd();
    originalEnvironment = new Map();
    spawns = [];
    mkdirCalls = [];
    sentinel = Buffer.from('Existing work area: Café\r\n');

    async run() {
        assert.equal(process.platform, 'win32', 'this regression requires Windows');
        const relativeScratch = path.relative(fs.realpathSync(this.clientPath), this.scratch);
        assert.ok(path.isAbsolute(relativeScratch) || relativeScratch === '..' || relativeScratch.startsWith(`..${path.sep}`),
            'FILE_TRACKER_QA_TMP must be outside the tested client');
        this.runDirectory = fs.mkdtempSync(path.join(this.scratch, 'git-path-'));
        const spawn = childProcess.spawn;
        const mkdir = fs.mkdirSync;
        try {
            this.prepare();
            // Observe and forward real process launches and directory creation, including transient attempts.
            childProcess.spawn = (file, args, options) => {
                this.spawns.push({ file, args, options });
                return spawn(file, args, options);
            };
            fs.mkdirSync = (directory, options) => {
                this.mkdirCalls.push(directory);
                return mkdir(directory, options);
            };
            syncBuiltinESMExports();
            PollClient.install(this.clientPath);
            await this.missingGit();
            await this.unusableGit();
            await this.implicitLocations();
            await this.alternateGit();
            assert.equal(PollClient.unexpected, 0, 'offline transport guard');
        } finally {
            childProcess.spawn = spawn;
            fs.mkdirSync = mkdir;
            syncBuiltinESMExports();
            process.chdir(this.workingDirectory);
            this.restoreEnvironment();
            fs.rmSync(this.runDirectory, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 });
        }
    }

    prepare() {
        this.virtualRoot = this.makeDirectory('virtual');
        this.emptyBin = this.makeDirectory('empty bin');
        const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files';
        this.oracle = process.env.FILE_TRACKER_QA_GIT_EXE ?? path.join(programFiles, 'Git', 'cmd', 'git.exe');
        assert.ok(path.isAbsolute(this.oracle), 'the independent Git oracle path must be absolute');
        const installed = path.dirname(path.dirname(this.oracle));
        const source = process.env.FILE_TRACKER_QA_GIT_BIN ?? ['ucrt64', 'mingw64']
            .map(arch => path.join(installed, arch, 'bin')).find(bin => fs.existsSync(path.join(bin, 'git.exe')));
        assert.ok(source && path.isAbsolute(source), 'set FILE_TRACKER_QA_GIT_BIN to the installed Git runtime bin (not the cmd wrapper)');
        this.realBin = this.makeDirectory('relocated Git bin');
        this.copyGit(source, this.realBin);
        const oracleVersion = this.gitVersion(this.oracle);
        const relocatedVersion = this.gitVersion(path.join(this.realBin, 'git.exe'));
        assert.match(oracleVersion, /^git version /);
        assert.match(relocatedVersion, /^git version /, 'the relocated runtime is real Git');
        PollClient.log(`Node ${process.version}; oracle ${oracleVersion}; relocated ${relocatedVersion}`);
        process.chdir(this.runDirectory);
    }

    makeDirectory(name) {
        const directory = path.join(this.runDirectory, name);
        fs.mkdirSync(directory);
        return directory;
    }

    copyGit(source, destination) {
        for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
            if (entry.isFile() && /^(git\.exe|.*\.dll)$/i.test(entry.name)) {
                fs.copyFileSync(path.join(source, entry.name), path.join(destination, entry.name));
            }
        }
    }

    gitArguments(executable, args) {
        const windows = process.env.SystemRoot ?? 'C:\\Windows';
        const env = { SystemRoot: windows, WINDIR: windows, PATH: `${windows}\\System32;${windows}`,
            GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: 'NUL', GIT_TERMINAL_PROMPT: '0', GIT_ALLOW_PROTOCOL: '' };
        const result = childProcess.spawnSync(executable, ['--no-pager', ...args], {
            cwd: this.runDirectory, env, shell: false, windowsHide: true, timeout: 30_000
        });
        assert.equal(result.status, 0, `fixture Git failed: ${result.error?.message ?? result.stderr?.toString() ?? result.status}`);
        return result.stdout;
    }

    gitVersion(executable) { return this.gitArguments(executable, ['--version']).toString().trim(); }

    setEnvironment(name, value) {
        if (!this.originalEnvironment.has(name)) this.originalEnvironment.set(name, process.env[name]);
        process.env[name] = value;
    }

    restoreEnvironment() {
        for (const [name, value] of this.originalEnvironment) {
            if (value === undefined) delete process.env[name];
            else process.env[name] = value;
        }
    }

    project(name, existingWorkArea = false) {
        const directory = path.join(this.virtualRoot, name);
        fs.mkdirSync(directory);
        fs.writeFileSync(path.join(directory, 'source.txt'), 'first\r\nsecond\r\n');
        if (existingWorkArea) {
            fs.mkdirSync(path.join(directory, '.aiwork'));
            fs.writeFileSync(path.join(directory, '.aiwork', 'keep.txt'), this.sentinel);
        }
        return directory;
    }

    openProject(directory) {
        const label = path.basename(directory).replaceAll(' ', '-').toLowerCase();
        this.client = new PollClient(this.virtualRoot, label);
        return this.client.command('QA_OpenFileTracker', {
            virtualRoot: this.virtualRoot, projectPath: path.basename(directory), codeName: 'discovery'
        });
    }

    async missingGit() {
        const fresh = this.project('missing Git');
        await this.denied(fresh, this.emptyBin, 'missing');
        const existing = this.project('existing work area', true);
        await this.denied(existing, this.emptyBin, 'missing');
        assert.deepEqual(fs.readFileSync(path.join(existing, '.aiwork', 'keep.txt')), this.sentinel);
        PollClient.log('PASS: no Program Files fallback; no private directories created; existing .aiwork and sentinel unchanged');
    }

    async unusableGit() {
        const invalidBin = this.makeDirectory('unusable Git bin');
        fs.writeFileSync(path.join(invalidBin, 'git.exe'), 'Not a Windows executable.\r\n');
        await this.denied(this.project('unusable Git'), invalidBin, 'unusable');
        PollClient.log('PASS: unusable git.exe rejected with a safe diagnostic before creating private directories');
    }

    async implicitLocations() {
        process.chdir(this.realBin);
        await this.denied(this.project('CWD not searched'), this.emptyBin, 'missing');
        process.chdir(this.runDirectory);
        await this.denied(this.project('relative PATH not searched'), path.basename(this.realBin), 'missing');
        const project = this.project('project Git not accepted');
        const projectBin = path.join(project, 'bin');
        fs.mkdirSync(projectBin);
        this.copyGit(this.realBin, projectBin); // A trusted copy that would work outside the project.
        await this.denied(project, projectBin, 'missing');
        fs.writeFileSync(path.join(this.emptyBin, 'git.cmd'), ''); // Inert PATHEXT decoy.
        this.setEnvironment('PATHEXT', '.CMD');
        await this.denied(this.project('PATHEXT not searched'), this.emptyBin, 'missing');
        PollClient.log('PASS: no executable search in CWD, relative PATH, monitored project, or PATHEXT');
    }

    async denied(directory, discoveryPath, kind) {
        this.setEnvironment('PATH', discoveryPath);
        this.spawns.length = 0;
        this.mkdirCalls.length = 0;
        const before = fs.readdirSync(this.virtualRoot, { recursive: true }).sort();
        const receipt = await this.openProject(directory);
        const after = fs.readdirSync(this.virtualRoot, { recursive: true }).sort();
        assert.equal(receipt.success, false, `${path.basename(directory)} must fail; mkdir calls: ${this.mkdirCalls.length}`);
        assert.equal(this.mkdirCalls.length, 0, 'denial must precede directory creation, not clean up afterward');
        assert.deepEqual(after, before, `${path.basename(directory)} changed the fixture tree`);
        this.safeDiagnostic(receipt, kind);
        if (kind === 'missing') assert.equal(this.spawns.length, 0, 'no Git process attempted for an ineligible candidate');
    }

    safeDiagnostic(receipt, kind) {
        assert.equal(receipt.trackerId, undefined);
        assert.equal(receipt.bindingId, undefined);
        assert.notEqual(receipt.outcomeUnknown, true);
        assert.match(receipt.msg, /\bgit(?:\.exe)?\b/i, 'a Git-specific diagnostic is required');
        const reason = kind === 'missing' ? /\bPATH\b/i : /git --version/i;
        assert.match(receipt.msg, reason);
        assert.doesNotMatch(receipt.msg, /[a-z]:[\\/]|\\\\|\r|\n|ENOENT|UNKNOWN|EACCES/i, 'no raw process error, filesystem path, or multiline diagnostic');
    }

    async alternateGit() {
        const project = this.project('workspace with spaces');
        this.setEnvironment('PATH', `${this.emptyBin};${this.realBin}`);
        this.setEnvironment('GIT_CONFIG_COUNT', 'not-a-count');
        this.setEnvironment('GIT_DIR', path.join(this.runDirectory, 'wrong repo'));
        this.setEnvironment('GIT_INDEX_FILE', path.join(this.runDirectory, 'wrong index'));
        this.setEnvironment('GIT_AUTHOR_NAME', 'Wrong inherited author');
        this.spawns.length = 0;
        const opened = await this.openProject(project);
        assert.equal(opened.success, true, opened.msg);
        assert.equal(opened.created, true);
        const capture = await this.client.command('QA_CommitFileTracker', {
            trackerId: opened.trackerId, bindingId: opened.bindingId,
            conversationId: '17', statementId: '42', description: 'PATH discovery fixture'
        });
        assert.equal(capture.success, true, capture.msg);
        assert.equal(capture.baseline, true);
        this.verifyLaunches();
        this.verifyCapture(project, capture.commit);
        PollClient.log('PASS: actual relocated Git in a spaced PATH bin; absolute shell-free launch; private capture, hook override and inherited Git environment isolation');
    }

    verifyLaunches() {
        assert.ok(this.spawns.some(call => call.args.includes('commit-tree')), 'observe the actual capture launcher');
        for (const { file, args, options } of this.spawns) {
            assert.equal(path.normalize(file).toLowerCase(), path.join(this.realBin, 'git.exe').toLowerCase());
            assert.ok(!options.shell, 'launch Git directly, without a shell');
            assert.ok(options.env, 'do not inherit the client environment');
            assert.equal(options.env.GIT_CONFIG_COUNT, undefined);
            assert.equal(options.env.GIT_DIR, undefined);
            assert.notEqual(options.env.GIT_INDEX_FILE, process.env.GIT_INDEX_FILE);
            assert.notEqual(options.env.GIT_AUTHOR_NAME, process.env.GIT_AUTHOR_NAME);
            const gitPath = Object.entries(options.env).find(([key]) => key.toUpperCase() === 'PATH')?.[1];
            assert.ok(gitPath && !gitPath.toLowerCase().includes(this.realBin.toLowerCase()), 'inherited executable search path must not reach Git');
            if (args.some(arg => arg.startsWith('--git-dir='))) assert.ok(args.includes('core.hooksPath=NUL'), 'disable hooks on private Git commands');
        }
    }

    verifyCapture(project, commit) {
        const repo = path.join(project, '.AIWork', 'tracking', 'discovery', 'repo.git');
        const git = (...args) => this.gitArguments(this.oracle, [`--git-dir=${repo}`, ...args]);
        assert.equal(git('ls-tree', '-r', '--name-only', commit).toString().trim(), 'source.txt');
        assert.deepEqual(git('cat-file', 'blob', `${commit}:source.txt`), fs.readFileSync(path.join(project, 'source.txt')));
        assert.equal(git('show', '-s', '--format=%an', commit).toString().trim(), 'BenAI File Tracker');
        assert.equal(fs.existsSync(process.env.GIT_INDEX_FILE), false, 'inherited index was not written');
        assert.equal(fs.existsSync(process.env.GIT_DIR), false, 'inherited repo was not written');
    }
}

try { await new GitDiscoveryChecks().run(); }
catch (error) { PollClient.log('FAIL:', error); process.exitCode = 1; }
process.exit(process.exitCode ?? 0); // Server.StartPolling owns a long-lived offline poll loop.
