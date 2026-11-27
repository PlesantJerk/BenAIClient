// Windows / Node 24. Run with `node tests/file-tracking/capture-job-polling.mjs`.
// Same FILE_TRACKER_QA_* settings as acceptance.mjs; scratch must be outside the checkout.
// The fresh test process preloads this file in both itself and any capture worker.
// Optional --legacy-blocking diagnoses the original dispatcher on the pre-feature checkout.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire, registerHooks, syncBuiltinESMExports } from 'node:module';
import { Socket } from 'node:net';
import { PassThrough } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isMainThread, threadId } from 'node:worker_threads';
import { Fixture } from './fixture.mjs';
import { PollClient } from './poll-client.mjs';

class GitPipeGate {
    constructor(directory) { this.directory = directory; }
    file(name) { return path.join(this.directory, name); }

    install() {
        // Decorate the stock executable's pipe, not the launcher, tracker, or worker protocol.
        // update-index is intentionally a streaming Git invocation with no 60s child timeout.
        const processes = createRequire(import.meta.url)('node:child_process');
        const spawn = processes.spawn;
        const gate = this;
        processes.spawn = function (file, args, options) {
            const child = spawn.call(this, file, args, options);
            if (path.basename(file).toLowerCase() === 'git.exe') gate.observe(child, args);
            return child;
        };
        syncBuiltinESMExports();
    }

    observe(child, args) {
        const command = args.find(arg => arg === 'update-index' || arg === 'update-ref');
        const repo = args.find(arg => arg.startsWith('--git-dir='))?.slice(10);
        if (!command || !repo || !repo.startsWith(this.directory + path.sep)) return;
        fs.appendFileSync(this.file('git.jsonl'), JSON.stringify({ command, repo, pid: child.pid, threadId }) + '\n');
        if (command === 'update-index' && fs.existsSync(this.file('armed'))) this.hold(child);
    }

    hold(child) {
        const input = child.stdin;
        const buffered = new PassThrough();
        child.stdin = buffered;
        input.on('error', error => buffered.destroy(error));
        const timer = setInterval(() => {
            if (!fs.existsSync(this.file('release'))) return;
            clearInterval(timer);
            buffered.pipe(input);
        }, 20);
        child.once('close', () => { clearInterval(timer); buffered.destroy(); });
        fs.writeFileSync(this.file('held'), JSON.stringify({ pid: child.pid, threadId }));
    }

    arm() {
        fs.rmSync(this.file('held'), { force:true });
        fs.rmSync(this.file('release'), { force:true });
        fs.writeFileSync(this.file('armed'), 'hold the next private update-index');
    }
    release() { fs.rmSync(this.file('armed'), { force: true }); fs.writeFileSync(this.file('release'), 'release'); }
    events() {
        return fs.readFileSync(this.file('git.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    }
    async waitForHold() {
        const deadline = performance.now() + 20_000;
        while (!fs.existsSync(this.file('held')) && performance.now() < deadline) await delay(30);
        assert.ok(fs.existsSync(this.file('held')), 'capture must reach the real Git update-index stdin gate');
        return JSON.parse(fs.readFileSync(this.file('held'), 'utf8'));
    }
}

class CapturePollClient extends PollClient {
    capture(command, payload, trusted = true, ms = 5_000) {
        // Same synthetic inbox and actual Server.StartPolling as PollClient.command.
        // Use the production reserved private correlation syntax, separate from operationId.
        const id = trusted ? 'filetracker-' + randomUUID().replaceAll('-', '') : 'fixture-untrusted-' + randomUUID();
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                PollClient.pending.delete(id);
                reject(new Error(`No native reply for ${command} within ${ms}ms`));
            }, ms);
            PollClient.pending.set(id, value => { clearTimeout(timer); resolve(value); });
            this.requests.push({ command, id, ...payload });
            this.awake?.();
        });
    }
}

class CaptureJobRegression {
    #start = 'QA_StartFileTrackerCapture';
    #status = 'QA_GetFileTrackerCaptureStatus';
    #commandTimes = [];

    constructor(fixture, gate, dependencies) {
        this.fixture = fixture;
        this.gate = gate;
        this.dependencies = dependencies;
    }

    async run() {
        await this.prepare();
        const result = await this.longCapture();
        await this.testTerminalFailureAndReplay(result);
        await this.testWrongLiveRoute(result);
        this.checkOrdinary();
        assert.equal(PollClient.unexpected, 0, 'all transport remained in memory; no unexpected fetch/socket');
        PollClient.log('PASS: capture-job polling regression', { worstQuickMs: Math.round(Math.max(...this.#commandTimes)), networkAttempts: 0 });
    }

    async demonstrateLegacyBlocking() {
        await this.prepare();
        this.gate.arm();
        const capture = this.legacy(this.job(this.primary));
        const held = await this.gate.waitForHold();
        assert.ok(held.pid > 0 && held.threadId === 0);
        const unrelated = this.client.command('get_virtual_directory_location', {}, 15_000);
        let replied;
        try { replied = await Promise.race([unrelated.then(() => true), delay(1_500, false)]); }
        finally { this.gate.release(); }
        assert.equal((await capture).success, true);
        assert.equal((await unrelated).virtual_directory, this.fixture.virtual);
        assert.equal(replied, false, 'legacy capture held the actual desktop poll dispatcher');
        this.assertOnePublication();
        this.checkOrdinary();
        assert.equal(PollClient.unexpected, 0);
        PollClient.log('PASS: legacy command blocked the unrelated native reply until actual Git stdin was released');
    }

    async prepare() {
        const f = this.fixture;
        f.initialize();
        fs.appendFileSync(path.join(f.primary, '.gitignore'), '\r\n/.AIWork/\r\n');
        const baselineIgnore = fs.readFileSync(path.join(f.primary, '.gitignore'));
        f.baseline.set('.gitignore', baselineIgnore);
        this.client = new CapturePollClient(f.virtual, 'capture-job');
        this.foreign = new CapturePollClient(f.virtual, 'foreign-capture-job');
        this.primary = await this.open(f.primary, 'job-test');
        this.other = await this.open(f.alternate, 'other-tracker');
        this.repo = path.join(f.primary, '.AIWork', 'tracking', 'job-test', 'repo.git');
        this.otherRepo = path.join(f.alternate, '.AIWork', 'tracking', 'other-tracker', 'repo.git');
        const baseline = await this.legacy({ ...this.job(this.primary), statementId: null });
        assert.equal(baseline.success, true, baseline.msg);
        assert.equal(baseline.baseline, true);
        assert.equal(baseline.previousCommit, null);
        this.base = baseline.commit;
        this.oldBlob = f.shadow(this.repo, ['rev-parse', `${this.base}:editing.txt`]).toString().trim();
        f.write(f.primary, 'editing.txt', Buffer.from('async capture: \u96ea\r\nnext line\r\n'));
        this.bytes = fs.readFileSync(path.join(f.primary, 'editing.txt'));
        this.ordinary = f.realState();
        this.dirty = this.ordinaryStatus();
        assert.match(this.dirty, /^MM staged\.txt$/m);
        assert.match(this.dirty, /^ M editing\.txt$/m);
        assert.match(this.dirty, /^\?\? untracked\.txt$/m);
        assert.equal(this.refs(), `refs/heads/tracking ${this.base}`);
        assert.equal(this.otherRefs(), '');
        this.baselineEventCount = this.gate.events().length;
    }

    async open(root, codeName) {
        const f = this.fixture;
        const result = await this.client.command('QA_OpenFileTracker', { virtualRoot:f.virtual, projectPath:f.pathFor(root), codeName });
        assert.equal(result.success, true, result.msg);
        assert.equal(result.created, true);
        return result;
    }

    job(binding) {
        return { version:1, trackerId:binding.trackerId, bindingId:binding.bindingId, operationId:randomUUID(),
            conversationId:'9007199254740997', statementId:'9223372036854775806', description:'synthetic capture job \u96ea', reviewProof:'synthetic_proof' };
    }

    scope(job) {
        const { version, trackerId, bindingId, operationId, conversationId } = job;
        return { version, trackerId, bindingId, operationId, conversationId };
    }

    legacy({ version, operationId, ...args }) { return this.client.command('QA_CommitFileTracker', args); }
    start(job, trusted = true) { return this.quick(this.client, this.#start, job, trusted); }
    status(job, client = this.client, trusted = true) { return this.quick(client, this.#status, this.scope(job), trusted); }

    async quick(client, command, payload, trusted) {
        const started = performance.now();
        const value = await client.capture(command, payload, trusted);
        const elapsed = performance.now() - started;
        this.#commandTimes.push(elapsed);
        assert.ok(elapsed < 5_000, `${command} took ${Math.round(elapsed)}ms`);
        return value;
    }

    assertPending(job, reply) {
        assert.deepEqual(reply, { success:true, msg:'', version:1, status:'pending', operationId:job.operationId });
    }

    assertDenied(reply, context) {
        assert.equal(reply.success, false, `${context} must deny admission`);
        assert.ok(!Object.hasOwn(reply, 'result'), `${context} must not expose any receipt`);
        assert.notEqual(reply.status, 'pending', context);
    }

    async longCapture() {
        const job = this.job(this.primary);
        this.gate.arm();
        const startTime = performance.now();
        this.assertPending(job, await this.start(job));
        const ackMs = Math.round(performance.now() - startTime);
        const held = await this.gate.waitForHold();
        assert.ok(held.pid > 0 && held.threadId > 0, 'stock Git must have been spawned from the capture worker');
        process.kill(held.pid, 0); // Read-only liveness check, not the gate itself.
        const heldAt = performance.now();
        await this.testPendingScope(job);
        PollClient.log('Observed stock Git waiting on stdin and responsive native dispatch', { ackMs, gitWorkerThread:held.threadId });
        let pendingReplies = 0;
        while (performance.now() - heldAt <= 61_500) {
            this.assertPending(job, await this.status(job));
            pendingReplies++;
            await delay(3_000);
        }
        this.assertPending(job, await this.status(job));
        pendingReplies++;
        await this.unrelated();
        process.kill(held.pid, 0);
        assert.equal(this.refs(), `refs/heads/tracking ${this.base}`, 'no publication while actual Git stdin is held');
        const heldMs = Math.round(performance.now() - heldAt);
        assert.ok(heldMs > 60_000 && pendingReplies >= 3);
        this.gate.release();
        const releasedAt = performance.now();
        const terminal = await this.terminal(job);
        assert.equal(terminal.status, 'completed');
        this.checkSuccessfulReceipt(job, terminal.result);
        PollClient.log('PASS: live gated Git and responsive polling', {
            ackMs, heldMs, pendingReplies, releaseToTerminalMs:Math.round(performance.now() - releasedAt), gitWorkerThread:held.threadId
        });
        this.completedJob = job;
        this.completedReply = terminal;
        return terminal.result;
    }

    async testPendingScope(job) {
        this.assertPending(job, await this.start(job));
        this.assertDenied(await this.start({ ...job, description:'different immutable arguments' }), 'mismatched duplicate start');
        this.assertDenied(await this.status({ ...job, conversationId:'9007199254740998' }), 'wrong saved conversation');
        this.assertDenied(await this.status({ ...job, trackerId:this.other.trackerId, bindingId:this.other.bindingId }), 'other valid tracker');
        this.assertDenied(await this.status({ ...job, bindingId:randomUUID() }), 'wrong binding');
        this.assertDenied(await this.status(job, this.foreign), 'different desktop/account route');
        this.assertDenied(await this.status(job, this.client, false), 'untrusted transport status');
        this.assertDenied(await this.start({ ...job, operationId:randomUUID() }, false), 'untrusted transport start');
        await this.unrelated();
    }

    async unrelated() {
        const start = performance.now();
        const result = await this.client.command('get_virtual_directory_location', {}, 5_000);
        const elapsed = performance.now() - start;
        this.#commandTimes.push(elapsed);
        assert.ok(elapsed < 5_000);
        assert.equal(result.virtual_directory, this.fixture.virtual);
        assert.equal(result.supports_append_text_file, true);
    }

    async terminal(job) {
        const deadline = performance.now() + 25_000;
        do {
            const reply = await this.status(job);
            assert.equal(reply.success, true, JSON.stringify(reply));
            assert.equal(reply.version, 1);
            assert.equal(reply.operationId, job.operationId);
            if (reply.status === 'completed' || reply.status === 'error') return reply;
            this.assertPending(job, reply);
            await delay(100);
        } while (performance.now() < deadline);
        assert.fail('capture did not settle after releasing actual Git');
    }

    checkSuccessfulReceipt(job, result) {
        const f = this.fixture;
        const commit = f.shadow(this.repo, ['rev-parse', 'refs/heads/tracking']).toString().trim();
        const newSha = createHash('sha1').update(`blob ${this.bytes.length}\0`).update(this.bytes).digest('hex');
        assert.notEqual(commit, this.base);
        assert.deepEqual(result, {
            success:true, msg:'', changed:true, baseline:false, previousCommit:this.base, commit, added:[], deleted:[],
            modified:[{ path:'editing.txt', oldSha:this.oldBlob, newSha }], counts:{ added:0, modified:1, deleted:0 }, truncated:false
        }, 'terminal result must be the entire legacy receipt, including exact pair and blob IDs');
        assert.equal(this.refs(), `refs/heads/tracking ${commit}`);
        assert.equal(f.shadow(this.repo, ['rev-list', '--parents', `${this.base}..${commit}`]).toString().trim(), `${commit} ${this.base}`);
        assert.deepEqual(f.shadow(this.repo, ['cat-file', 'blob', `${commit}:editing.txt`]), this.bytes);
        const raw = f.shadow(this.repo, ['cat-file', 'commit', commit]).toString('utf8');
        assert.equal(raw.split('\n\n', 2)[1], `{"ConversationID":${job.conversationId},"StatementID":${job.statementId},"Description":${JSON.stringify(job.description)},"ReviewProof":${JSON.stringify(job.reviewProof)}}\n`);
        this.assertOnePublication();
        assert.deepEqual(this.commitObjects(this.repo), [this.base, commit].sort());
        this.checkOrdinary();
        PollClient.log('PASS: exact legacy receipt and one real private ref advance', { previous:result.previousCommit, current:result.commit });
    }

    async testTerminalFailureAndReplay(result) {
        const f = this.fixture;
        const job = this.job(this.primary);
        const problem = path.join(f.primary, 'editing.txt');
        const unlock = this.holdExclusiveRead(problem);
        try {
            this.assertPending(job, await this.start(job));
            const terminal = await this.terminal(job);
            assert.equal(terminal.status, 'error');
            const { version, operationId, ...legacyArgs } = job;
            const legacy = await this.client.command('QA_CommitFileTracker', legacyArgs);
            assert.equal(legacy.success, false);
            assert.match(legacy.msg, /could not safely open a listed path.*Windows error/i);
            assert.deepEqual(terminal.result, legacy, 'terminal error must retain the exact desktop legacy result');
            this.failedReply = terminal;
        } finally { unlock(); }

        // A rerun after unlock would now capture another real change; never rely on Git no-change deduplication.
        f.write(f.primary, 'editing.txt', 'never publish this third version\r\n');
        for (const [request, expected] of [[job,this.failedReply], [this.completedJob,this.completedReply]]) {
            assert.deepEqual(await this.status(request), expected);
            assert.deepEqual(await this.start(request), expected);
            assert.deepEqual(await this.status(request), expected);
        }
        const unknownJob = { ...job, operationId:randomUUID() };
        const unknown = await this.status(unknownJob);
        assert.deepEqual(unknown, { success:false, msg:'', version:1, status:'unknown', operationId:unknownJob.operationId });
        assert.notDeepEqual(unknown, this.failedReply);
        assert.equal(this.refs(), `refs/heads/tracking ${result.commit}`);
        assert.equal(this.otherRefs(), '');
        this.assertOnePublication();
        assert.deepEqual(this.commitObjects(this.repo), [this.base, result.commit].sort());
        assert.deepEqual(this.commitObjects(this.otherRepo), []);
        assert.equal(fs.readFileSync(path.join(f.primary, 'editing.txt'), 'utf8'), 'never publish this third version\r\n');
        PollClient.log('PASS: exact terminal error vs unknown; duplicate START and STATUS did not rerun Git after the working bytes changed');
    }

    holdExclusiveRead(filename) {
        const require = createRequire(path.join(this.dependencies, 'server.js'));
        const api = require('koffi').load('C:\\Windows\\System32\\kernel32.dll');
        const open = api.func('intptr_t __stdcall CreateFileW(str16 name, uint32_t access, uint32_t share, void *sec, uint32_t disposition, uint32_t flags, intptr_t templateFile)');
        const close = api.func('int __stdcall CloseHandle(intptr_t handle)');
        const handle = open(filename, 0x80000000, 0, null, 3, 0x80, 0);
        assert.ok(handle !== -1 && handle !== -1n, 'real synthetic file sharing violation fixture');
        return () => assert.equal(close(handle), 1);
    }

    async testWrongLiveRoute(result) {
        const job = this.job(this.primary);
        const startEvent = this.gate.events().length;
        this.gate.arm();
        this.assertPending(job, await this.start(job));
        await this.gate.waitForHold();
        const server = this.client.server;
        const original = server.client_name;
        server.SetClientName('switched-synthetic-route');
        try {
            await this.unrelated();
            this.assertDenied(await this.status(this.completedJob), 'changed named route on the same dispatcher');
            this.assertDenied(await this.start(this.completedJob), 'start under changed named route');
        } finally { server.SetClientName(original); }
        this.assertDenied(await this.status(job), 'restoring the name does not reopen an admitted job');
        this.assertDenied(await this.start(this.job(this.primary)), 'new handle using retired binding');
        this.gate.release();
        await this.waitForPrivateScratchCleanup();
        assert.equal(this.refs(), `refs/heads/tracking ${result.commit}`);
        assert.deepEqual(this.gate.events().slice(startEvent).map(event => event.command), ['update-index'], 'a retired capture cannot reach update-ref');
        PollClient.log('PASS: wrong caller, tracker, binding and route received no receipt; changing live route prevented publication of gated work');
    }

    async waitForPrivateScratchCleanup() {
        const directory = path.dirname(this.repo);
        const hasScratch = () => fs.readdirSync(directory).some(name => name.startsWith('.capture-'));
        const deadline = performance.now() + 20_000;
        while (hasScratch() && performance.now() < deadline) await delay(50);
        assert.equal(hasScratch(), false, 'worker cleaned private staging after release');
    }

    assertOnePublication() {
        const events = this.gate.events().slice(this.baselineEventCount);
        assert.deepEqual(events.map(({ command, repo }) => [command, repo]), [['update-index',this.repo], ['update-ref',this.repo]], 'one real private index update and one real private ref call, no repeat');
    }

    commitObjects(repo) {
        const entries = this.fixture.shadow(repo, ['cat-file', '--batch-all-objects', '--batch-check=%(objectname) %(objecttype)']);
        return entries.toString().split('\n').filter(line => line.endsWith(' commit')).map(line => line.slice(0, 40)).sort();
    }

    refs() { return this.fixture.shadowRefs(this.repo); }
    otherRefs() { return this.fixture.shadowRefs(this.otherRepo); }
    ordinaryStatus() { return this.fixture.gitText(this.fixture.primary, ['--no-optional-locks', 'status', '--porcelain=v1', '--untracked-files=all']); }
    checkOrdinary() {
        assert.deepEqual(this.fixture.realState(), this.ordinary, 'ordinary linked index, HEAD, refs, config and ignore bytes must be exact');
        assert.equal(this.ordinaryStatus(), this.dirty, 'staged, unstaged and untracked status must be preserved');
    }
}

class CaptureJobProcess {
    static client = path.resolve(process.env.FILE_TRACKER_QA_CLIENT ?? fileURLToPath(new URL('../../', import.meta.url)));
    static dependencies = path.resolve(process.env.FILE_TRACKER_QA_DEPENDENCIES ?? this.client);
    static directory = process.env.FILE_TRACKER_JOB_TEST_DIR;
    static gate;

    static fingerprint() {
        const files = ['server.js', ...fs.readdirSync(this.client).filter(name => /^file-tracker-.*\.mts$/.test(name)).sort()];
        const hash = createHash('sha256');
        for (const file of files) hash.update(file + '\0').update(fs.readFileSync(path.join(this.client, file)));
        return hash.digest('hex');
    }

    static launch() {
        assert.equal(process.platform, 'win32');
        assert.equal(process.versions.node.split('.')[0], '24');
        const tmp = path.resolve(process.env.FILE_TRACKER_QA_TMP ?? os.tmpdir());
        const relative = path.relative(this.client, tmp);
        assert.ok(path.isAbsolute(relative) || relative === '..' || relative.startsWith('..' + path.sep), 'scratch must be outside the client checkout');
        const directory = fs.mkdtempSync(path.join(tmp, 'capture-job-regression-'));
        const gitBin = process.env.FILE_TRACKER_QA_GIT_BIN ?? path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'ucrt64', 'bin');
        try {
            const main = fileURLToPath(import.meta.url);
            const env = { ...process.env, FILE_TRACKER_JOB_TEST_DIR:directory, FILE_TRACKER_QA_TMP:directory,
                FILE_TRACKER_QA_CLIENT:this.client, FILE_TRACKER_QA_DEPENDENCIES:this.dependencies, PATH:gitBin + path.delimiter + process.env.PATH };
            delete env.NODE_OPTIONS;
            const result = spawnSync(process.execPath, ['--import', import.meta.url, main, ...process.argv.slice(2)], {
                cwd:directory, env, stdio:'inherit', timeout:180_000, windowsHide:true
            });
            if (result.error) throw result.error;
            return result.status ?? 1;
        } finally { fs.rmSync(directory, { recursive:true, force:true, maxRetries:10, retryDelay:150 }); }
    }

    static preload() {
        this.gate = new GitPipeGate(this.directory);
        this.gate.install();
        if (isMainThread) return;
        const guard = () => { fs.appendFileSync(this.gate.file('worker-network-attempts'), 'denied\n'); throw new Error('QA denied worker network'); };
        globalThis.fetch = guard;
        Socket.prototype.connect = guard;
        // Module resolution hooks are per isolate; resolve the same installed native package read-only.
        const parentURL = pathToFileURL(path.join(this.dependencies, 'server.js')).href;
        registerHooks({ resolve(specifier, context, next) {
            if (specifier !== 'koffi') return next(specifier, context);
            try { return next(specifier, context); }
            catch (error) {
                if (!['ERR_MODULE_NOT_FOUND', 'MODULE_NOT_FOUND'].includes(error.code)) throw error;
                return next(specifier, { ...context, parentURL });
            }
        } });
    }

    static async run() {
        const f = new Fixture();
        try {
            const before = this.fingerprint();
            PollClient.log('Environment', { node:process.version, git:f.gitText(this.directory, ['--version']), sourceSha256:before });
            PollClient.install(this.client);
            const check = new CaptureJobRegression(f, this.gate, this.dependencies);
            if (process.argv.includes('--legacy-blocking')) await check.demonstrateLegacyBlocking();
            else await check.run();
            assert.equal(fs.existsSync(this.gate.file('worker-network-attempts')), false);
            assert.equal(this.fingerprint(), before, 'production source changed during the run');
        } catch (error) {
            PollClient.log('FAIL', error);
            process.exitCode = 1;
        } finally {
            this.gate.release();
            f.remove();
        }
        // Server.StartPolling intentionally has no test shutdown path.
        process.exit(process.exitCode ?? 0);
    }
}

if (!CaptureJobProcess.directory) process.exitCode = CaptureJobProcess.launch();
else {
    CaptureJobProcess.preload();
    if (isMainThread) await CaptureJobProcess.run();
}
