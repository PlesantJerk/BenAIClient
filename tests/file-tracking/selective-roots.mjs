import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { registerHooks } from 'node:module';
import { Socket } from 'node:net';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isMainThread } from 'node:worker_threads';
import { Fixture } from './fixture.mjs';
import { PollClient as Poll } from './poll-client.mjs';

// Run from the client checkout with FILE_TRACKER_QA_TMP set to an external scratch directory:
// node --import ./tests/file-tracking/selective-roots.mjs ./tests/file-tracking/selective-roots.mjs
// The preload gives real worker isolates the same offline guard and read-only native dependency fallback.
// Optional: set FILE_TRACKER_SCOPE_OLD_CLIENT to a scratch archive of the predecessor Node source.
// If needed, set FILE_TRACKER_QA_DEPENDENCIES to the source folder with existing node_modules.
class OfflineWorker {
    static install() {
        const rejectNetwork = () => {
            fs.appendFileSync(process.env.FILE_TRACKER_SCOPE_NETWORK_LOG, 'denied\n');
            throw new Error('Selective scope QA denied worker networking');
        };
        globalThis.fetch = rejectNetwork;
        Socket.prototype.connect = rejectNetwork;
        const dependencies = process.env.FILE_TRACKER_QA_DEPENDENCIES;
        if (!dependencies) return;
        const parentURL = pathToFileURL(path.resolve(dependencies, 'server.js')).href;
        registerHooks({ resolve(specifier, context, next) {
            if (specifier !== 'koffi') return next(specifier, context);
            try { return next(specifier, context); }
            catch (error) {
                if (!['ERR_MODULE_NOT_FOUND', 'MODULE_NOT_FOUND'].includes(error.code)) throw error;
                return next(specifier, { ...context, parentURL });
            }
        } });
    }
}

class OldClientProbe {
    static async run(data) {
        const { archive, identity, picked, pair, lease, capture } = data;
        Poll.install(archive);
        const route = new Poll(identity.virtualRoot, 'selective-roots');
        const legacy = await route.command('QA_OpenFileTracker', { ...identity, codeName: 'ordinary-no-capture' }, 10_000);
        assert.equal(legacy.success, true, legacy.msg);
        const command = 'QA_OpenScopedFileTracker';
        const unsupported = assert.rejects(route.command(command, { ...identity, codeName: 'unsupported-never-created', includeDirectories: picked }, 2_000), /No native reply for QA_OpenScopedFileTracker/);
        const ping = await route.command('get_virtual_directory_location', {}, 10_000);
        assert.equal(ping.virtual_directory, identity.virtualRoot, 'old poll dispatch continued through the unsupported command');
        await unsupported;
        await this.denied(route, 'QA_OpenFileTracker', identity, /manifest|private store/i);
        await this.denied(route, 'QA_CommitFileTracker', { ...lease, ...capture });
        await this.denied(route, 'QA_FileTrackerReadManifest', { ...pair, cursor: null });
        assert.equal(Poll.unexpected, 0, 'old client escaped offline transport');
        Poll.log(`Old dispatcher evidence: scoped command unsupported with no reply, v1 ordinary open succeeded; v2 plain open, capture and review denied. server.js SHA256: ${this.serverHash(archive)}`);
    }

    static async denied(route, command, payload, diagnostic) {
        const reply = await route.command(command, payload, 10_000);
        assert.equal(reply.success, false, `${command} was unexpectedly accepted on old client`);
        assert.ok(reply.msg?.trim(), `${command} had no denial message`);
        if (diagnostic) assert.match(reply.msg, diagnostic);
    }

    static serverHash(archive) {
        return createHash('sha256').update(fs.readFileSync(path.join(archive, 'server.js'))).digest('hex');
    }
}

class SelectiveRoots extends Fixture {
    roots = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];
    picked = ['C', 'F'];
    scopeClient = path.resolve(process.env.FILE_TRACKER_QA_CLIENT ?? fileURLToPath(new URL('../../', import.meta.url)));
    code = 'selected-siblings';
    store = path.join(this.primary, '.AIWork', 'tracking');
    repo = path.join(this.store, this.code, 'repo.git');
    manifest = path.join(this.store, this.code, 'tracker.json');
    proof = 'offline_scope_only_AB1289';
    capture = { conversationId: '9223372036854775807', statementId: '9007199254740993', description: 'Scoped QA 雪\r\n' };
    skips = [];
    groups = 0;

    static checkEnvironment() {
        assert.equal(process.platform, 'win32', 'test requires actual Windows file identity and Git');
        assert.equal(process.versions.node.split('.')[0], '24');
        assert.ok(process.execArgv.includes('--import'), 'use the documented --import to guard real worker isolates');
        const tmp = path.resolve(process.env.FILE_TRACKER_QA_TMP ?? '');
        const client = path.resolve(process.env.FILE_TRACKER_QA_CLIENT ?? fileURLToPath(new URL('../../', import.meta.url)));
        const relative = path.relative(client, tmp);
        assert.ok(process.env.FILE_TRACKER_QA_TMP && (path.isAbsolute(relative) || relative === '..' || relative.startsWith('..' + path.sep)),
            'set FILE_TRACKER_QA_TMP to an existing external scratch directory');
    }

    async runChecks() {
        try {
            const provenance = this.sourceFingerprint();
            this.setup();
            await this.openChecks();
            await this.baselineCheck();
            await this.reopenChecks();
            await this.incrementalCheck();
            await this.reviewCheck();
            await this.refusalChecks();
            await this.nestedCheck();
            await this.reviewWithoutRoot();
            this.oldClientCheck();
            this.pass('all seven ordinary Git indexes, config, refs, loose objects and history unchanged',
                () => assert.deepEqual(this.sourceGit(), this.ordinary));
            this.pass('released Node source unchanged; no network, proof or file bodies in transport logs', () => this.provenanceCheck(provenance));
            Poll.log(JSON.stringify({ type: 'summary', passed: this.groups, skipped: this.skips }));
        } finally {
            this.remove();
        }
    }

    setup() {
        this.configureGit();
        this.write(this.primary, '.gitignore', 'C/\r\nF/\r\n');
        this.write(this.primary, 'outside-scope.txt', 'common parent not a repo or selected source\n');
        for (const name of this.roots) this.seedGitRoot(name);
        this.seedRulesAndBytes();
        this.ordinary = this.sourceGit();
        const dirs = this.roots.map(name => fs.realpathSync.native(this.source(name, '.git')));
        assert.equal(new Set(dirs).size, 7);
        assert.equal(new Set(dirs.map(dir => fs.statSync(dir, { bigint: true }).ino)).size, 7);
        assert.equal(fs.existsSync(path.join(this.primary, '.git')), false);
        assert.equal(this.git(this.primary, ['rev-parse', '--show-toplevel'], { accepted: [128] }).length, 0);
        this.oracleRules();
        process.env.FILE_TRACKER_SCOPE_NETWORK_LOG = path.join(this.run, 'worker-network-attempts');
        Poll.install(this.scopeClient);
        this.client = new Poll(this.virtual, 'selective-roots');
        this.identity = { virtualRoot: this.virtual, projectPath: this.pathFor(this.primary), codeName: this.code };
        this.pass('non-Git common parent, seven distinct Git roots, staged vs working bytes and Git ignore oracle');
    }

    configureGit() {
        Object.assign(this.env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: this.config, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' });
        fs.writeFileSync(this.config, '');
        for (const key of Object.keys(process.env)) if (/^git_/i.test(key)) delete process.env[key];
        Object.assign(process.env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: this.config, GIT_OPTIONAL_LOCKS: '0' });
        Poll.log(JSON.stringify({ type: 'environment', node: process.version, git: this.gitText(this.run, ['--version']), sources: this.sourceFingerprint() }));
    }

    seedGitRoot(name) {
        const root = this.source(name);
        fs.mkdirSync(root, { recursive: true });
        this.git(root, ['init', `--initial-branch=source-${name}`]);
        this.git(root, ['config', 'core.autocrlf', 'true']);
        this.write(root, 'same.txt', `index version ${name}\n`);
        this.write(root, 'remove.txt', `to delete ${name}\r\n`);
        this.write(root, 'tracked.own', `index tracked even if rule later ignores ${name}\n`);
        this.git(root, ['add', '--', 'same.txt', 'remove.txt', 'tracked.own']);
        this.write(root, 'same.txt', `\uFEFFworking version ${name} 雪\r\nsecond line\r\n`);
        this.write(root, 'untracked.bin', Buffer.from([0, 255, name.charCodeAt(0), 13, 10, 26, 0, 128]));
        const staged = this.git(root, ['show', ':same.txt']);
        assert.notDeepEqual(staged, fs.readFileSync(this.source(name, 'same.txt')));
        assert.match(this.gitText(root, ['--no-optional-locks', 'status', '--porcelain=v1']), /^AM same\.txt$/m);
        assert.match(this.gitText(root, ['--no-optional-locks', 'status', '--porcelain=v1']), /^\?\? untracked\.bin$/m);
    }

    seedRulesAndBytes() {
        this.write(this.source('C'), '.gitignore', '*.own\r\nonly-c.txt\r\nlogs/*\r\n!logs/keep.txt\r\n');
        this.write(this.source('F'), '.gitignore', 'only-f.txt\nlogs/keep.txt\n');
        this.write(this.source('C'), 'nested/.gitignore', 'drop.txt\n!restore.own\n');
        this.write(this.source('C'), 'nested/drop.txt', 'C-discard\n');
        this.write(this.source('C'), 'nested/restore.own', 'C-negation\n');
        this.write(this.source('C'), 'nested/visible.txt', 'C-visible\n');
        for (const name of this.picked) this.seedCommonRules(name);
        this.baseline = new Map();
        const visible = ['.gitignore', 'same.txt', 'remove.txt', 'untracked.bin'];
        this.keep('C', [...visible, 'only-f.txt', 'logs/keep.txt', 'nested/.gitignore', 'nested/visible.txt', 'nested/restore.own']);
        this.keep('F', [...visible, 'only-c.txt', 'logs/drop.txt', 'tracked.own']);
    }

    seedCommonRules(name) {
        for (const file of ['only-c.txt', 'only-f.txt', 'logs/keep.txt', 'logs/drop.txt', '.AIWork/sentinel.txt']) {
            this.write(this.source(name), file, `${name} content at ${file}\r\n`);
        }
    }

    oracleRules() {
        const candidates = ['tracked.own', 'only-c.txt', 'only-f.txt', 'logs/keep.txt', 'logs/drop.txt'];
        this.assertIgnored('C', [...candidates, 'nested/drop.txt', 'nested/restore.own'], ['tracked.own', 'only-c.txt', 'logs/drop.txt', 'nested/drop.txt']);
        this.assertIgnored('F', candidates, ['only-f.txt', 'logs/keep.txt']);
        assert.match(this.gitText(this.source('C'), ['ls-files', '--stage', '--', 'tracked.own']), /\ttracked\.own$/);
    }

    assertIgnored(name, candidates, expected) {
        const reply = this.git(this.source(name), ['check-ignore', '--no-index', '-z', '--stdin'], { input: Buffer.from(candidates.join('\0') + '\0') });
        assert.deepEqual(reply.toString('utf8').split('\0').filter(Boolean).sort(), expected.sort());
    }

    async openChecks() {
        for (const scope of [undefined, null, [], '["C","F"]', ['C', 1], ['C', 'c'], ['C', 'C/nested'], ['C', '..'],
            ['.'], ['C/../F'], [this.source('C')], ['C/.git'], ['C/.AIWork'], ['C/missing'], ['C/same.txt']]) {
            this.denied(await this.open(scope), `invalid new scope: ${JSON.stringify(scope)}`);
            assert.equal(fs.existsSync(this.store), false, 'a refused scope created private tracker state');
        }
        this.lease = this.openShape(await this.open(['F', 'C']));
        assert.equal(this.shadowRefs(this.repo), '', 'open must not capture');
        const data = JSON.parse(fs.readFileSync(this.manifest, 'utf8'));
        assert.equal(data.version, 2);
        assert.deepEqual(data.includeDirectories, this.picked);
        this.pass('new explicit scope fails closed; successful open persisted canonical C/F with no capture');
    }

    async baselineCheck() {
        const run = () => this.direct();
        const result = await this.replaced('E', 'junction', run);
        if (!result) {
            this.skip('unselected E junction unsupported on this Windows session');
            this.first = this.ok(await run());
        } else {
            this.first = this.ok(result);
            this.pass('entire unselected sibling E replaced by a junction to disposable G without affecting capture');
        }
        assert.equal(this.first.baseline, true);
        assert.equal(this.first.previousCommit, null);
        assert.deepEqual(this.first.counts, { added: this.baseline.size, modified: 0, deleted: 0 });
        this.assertCommit(this.first, this.baseline, new Map());
        this.pass('direct native baseline: exact selected paths, real blob bytes, no metadata or gitlinks');
    }

    async reopenChecks() {
        const prior = this.storeFingerprint();
        const legacy = this.openShape(await this.client.command('QA_OpenFileTracker', this.identity));
        const explicit = this.openShape(await this.open(['f', 'C']));
        assert.equal(legacy.trackerId, this.lease.trackerId);
        assert.equal(explicit.trackerId, this.lease.trackerId);
        assert.notEqual(legacy.bindingId, explicit.bindingId);
        for (const scope of [undefined, [], ['C'], ['F', 'D'], ['C', 'F', 'G'], ['C', 'F', 'f']]) {
            this.denied(await this.open(scope), `changed or empty explicit scope: ${JSON.stringify(scope)}`);
        }
        assert.equal(this.storeFingerprint(), prior, 'refused or equivalent reopens mutated existing private disk state');
        this.lease = explicit;
        this.assertNoop(this.ok(await this.direct()), this.first.commit);
        this.pass('legacy no-list reopen and reordered/case-varied reopen same tracker; wrong/empty denied; capture unchanged');
    }

    async incrementalCheck() {
        this.changed = new Map(this.baseline);
        this.update('C/same.txt', 'new staged-path working content\r\n');
        this.update('F/untracked.bin', Buffer.from([0, 128, 1, 13, 10, 26, 255]));
        this.update('F/new-雪.txt', 'new Unicode path bytes\n');
        fs.unlinkSync(this.source('F', 'remove.txt'));
        this.changed.delete('F/remove.txt');
        for (const name of ['A', 'B', 'D', 'E', 'G']) this.write(this.source(name), 'mutation.txt', `${name} not a scope member\n`);
        this.write(this.source('C'), 'another.own', 'new ignored C file\n');
        const { args, reply } = await this.worker('completed');
        this.second = this.ok(reply.result);
        assert.equal(this.second.baseline, false);
        assert.equal(this.second.previousCommit, this.first.commit);
        assert.deepEqual(this.second.counts, { added: 1, modified: 2, deleted: 1 });
        this.assertCommit(this.second, this.changed, this.baseline);
        assert.deepEqual(await this.privateCommand('QA_StartFileTrackerCapture', args), reply);
        assert.equal(this.shadow(this.repo, ['rev-list', '--count', 'refs/heads/tracking']).toString('ascii').trim(), '2');
        this.pass('native start/status and actual capture worker: two modifications, one add/delete, replay no extra ref');
    }

    async reviewCheck() {
        const pair = { ...this.identity, trackerId: this.lease.trackerId, startCommit: this.first.commit, endCommit: this.second.commit };
        const before = this.storeFingerprint();
        this.write(this.source('C'), 'same.txt', 'live workspace bytes not committed\r\n');
        fs.unlinkSync(this.source('F', 'new-雪.txt'));
        const list = this.ok(await this.privateCommand('QA_FileTrackerReadManifest', { ...pair, cursor: null }));
        assert.deepEqual(list.entries, this.changes(this.changed, this.baseline));
        assert.equal(list.nextCursor, null);
        assert.equal(list.totalCount, 4);
        assert.deepEqual(list.counts, this.second.counts);
        assert.deepEqual(list.provenance, { ...this.capture, reviewProof: this.proof });
        await this.reviewFiles(pair, list.entries);
        assert.equal(this.storeFingerprint(), before, 'review mutated native private disk state');
        this.write(this.source('C'), 'same.txt', this.changed.get('C/same.txt'));
        this.write(this.source('F'), 'new-雪.txt', this.changed.get('F/new-雪.txt'));
        this.pass('immutable native manifest/file review after live edits; original/modified/deleted/add bytes and denied sibling');
    }

    async reviewFiles(pair, entries) {
        for (const { path: name, oldSha, newSha } of entries) {
            const view = this.ok(await this.privateCommand('QA_FileTrackerReadFile', { ...pair, path: name, oldSha, newSha }));
            assert.equal(view.path, name);
            assert.equal(view.startCommit, pair.startCommit);
            assert.equal(view.endCommit, pair.endCommit);
            assert.equal(view.oldSha, oldSha);
            assert.equal(view.newSha, newSha);
            assert.deepEqual(view.original, this.version(name, this.baseline));
            assert.deepEqual(view.final, this.version(name, this.changed));
        }
        const c = entries.find(entry => entry.path === 'C/same.txt');
        this.denied(await this.privateCommand('QA_FileTrackerReadFile', { ...pair, path: 'A/same.txt', oldSha: c.oldSha, newSha: c.newSha }), 'sibling review');
    }

    async refusalChecks() {
        const head = this.shadowRefs(this.repo);
        this.write(this.source('C'), 'same.txt', 'uncommitted canary, must not partially publish\r\n');
        await this.replaced('F', 'missing', () => this.refusesCapture(head, 'missing F'));
        await this.replaced('F', 'empty replacement', () => this.refusesCapture(head, 'empty replacement F of different directory identity'));
        const junction = await this.replaced('F', 'junction', () => this.refusesCapture(head, 'selected F junction'));
        if (junction === undefined) this.skip('selected F junction unsupported on this Windows session');
        this.write(this.source('C'), 'same.txt', this.changed.get('C/same.txt'));
        assert.equal(this.shadowRefs(this.repo), head);
        this.lease = this.openShape(await this.open(['C', 'F']));
        this.assertNoop(this.ok(await this.direct()), this.second.commit);
        this.pass('missing, replaced-empty and (when available) unsafe selected root never partly advanced; restored scope unchanged');
    }

    async refusesCapture(head, label) {
        this.denied(await this.open(['C', 'F']), `${label} explicit re-open`);
        this.denied(await this.direct(), `${label} direct capture`);
        assert.equal(this.shadowRefs(this.repo), head);
        const { reply } = await this.worker('error');
        assert.equal(reply.success, true);
        this.denied(reply.result, `${label} worker capture`);
        assert.equal(Object.hasOwn(reply.result, 'outcomeUnknown'), false);
        assert.equal(this.shadowRefs(this.repo), head, `${label} advanced the private ref`);
        return true;
    }

    async nestedCheck() {
        const codeName = 'nested-explicit';
        const reply = this.openShape(await this.open(['f', 'c\\nested'], codeName), ['C/nested', 'F']);
        const repo = path.join(this.store, codeName, 'repo.git');
        const capture = this.ok(await this.direct(reply));
        const included = new Map([...this.changed].filter(([name]) => name.startsWith('F/') || name.startsWith('C/nested/')));
        const restored = 'C/nested/drop.txt';
        assert.equal(included.has(restored), false);
        this.assertCommit(capture, included, new Map(), repo);
        await this.emptyNested(reply, capture, included, repo);
        const legacyCode = 'ordinary-no-capture';
        const ordinary = this.ok(await this.client.command('QA_OpenFileTracker', { ...this.identity, codeName: legacyCode }));
        assert.equal(Object.hasOwn(ordinary, 'includeDirectories'), false);
        this.denied(await this.open(['C', 'F'], legacyCode), 'explicit scope cannot silently convert an existing ordinary tracker');
        const legacyManifest = path.join(this.store, legacyCode, 'tracker.json');
        assert.equal(JSON.parse(fs.readFileSync(legacyManifest, 'utf8')).version, 1);
        this.pass('nested relative spelling canonicalized; scoped capture still exact; ordinary manifest never converted');
    }

    async emptyNested(lease, previous, included, repo) {
        const root = this.source('C', 'nested'), parked = path.join(this.run, 'parked-contents');
        const names = fs.readdirSync(root);
        const inode = fs.statSync(root, { bigint: true }).ino;
        fs.mkdirSync(parked);
        for (const name of names) fs.renameSync(path.join(root, name), path.join(parked, name));
        try {
            assert.deepEqual(fs.readdirSync(root), []);
            assert.equal(fs.statSync(root, { bigint: true }).ino, inode);
            const capture = this.ok(await this.direct(lease));
            assert.equal(capture.previousCommit, previous.commit);
            const onlyF = new Map([...included].filter(([name]) => name.startsWith('F/')));
            assert.deepEqual(capture.counts, { added: 0, modified: 0, deleted: included.size - onlyF.size });
            this.assertCommit(capture, onlyF, included, repo);
            this.pass('same-identity selected directory genuinely emptied: published only its actual deletions');
        } finally {
            for (const name of names) fs.renameSync(path.join(parked, name), path.join(root, name));
            fs.rmdirSync(parked);
        }
    }

    async reviewWithoutRoot() {
        const pair = { ...this.identity, trackerId: this.lease.trackerId, startCommit: this.first.commit, endCommit: this.second.commit };
        const before = this.storeFingerprint();
        for (const kind of ['missing', 'empty replacement', 'junction']) {
            const checked = await this.replaced('F', kind, async () => {
                const response = this.ok(await this.privateCommand('QA_FileTrackerReadManifest', { ...pair, cursor: null }));
                assert.deepEqual(response.entries, this.changes(this.changed, this.baseline));
                await this.reviewFiles(pair, response.entries);
                return true;
            });
            if (checked === undefined) this.skip('immutable review with selected F junction unsupported');
        }
        assert.equal(this.storeFingerprint(), before, 'missing/replaced source review mutated native private disk state');
        this.pass('saved native manifest and exact files remain readable with F missing, replaced-empty or a junction');
    }

    oldClientCheck() {
        const archiveInput = process.env.FILE_TRACKER_SCOPE_OLD_CLIENT;
        if (!archiveInput) return this.skip('old native runtime not supplied via FILE_TRACKER_SCOPE_OLD_CLIENT');
        const archive = path.resolve(archiveInput);
        const { trackerId, bindingId } = this.lease;
        const pair = { ...this.identity, trackerId, startCommit: this.first.commit, endCommit: this.second.commit };
        const input = { archive, pair, identity: this.identity, picked: this.picked, lease: { trackerId, bindingId }, capture: this.capture };
        // Successful v1 Open creates/removes its own warnings scratch directory. Only exclude that
        // positive control's outer directory mtime, never a file, entry, v2 timestamp or ref.
        const control = 'ordinary-no-capture';
        const controlPath = path.join(this.store, control);
        const controlMtime = fs.statSync(controlPath).mtimeMs;
        const before = this.directoryFingerprint(this.store, control);
        const refs = this.shadowRefs(this.repo);
        const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
            cwd: this.run, env: { ...process.env, FILE_TRACKER_SCOPE_OLD_REQUEST: JSON.stringify(input) },
            encoding: 'utf8', timeout: 35_000, windowsHide: true,
        });
        if (result.error) throw result.error;
        assert.equal(result.status, 0, result.stdout + result.stderr);
        assert.equal(this.directoryFingerprint(this.store, control), before, 'old native commands changed persistent private tracker disk state');
        assert.equal(this.shadowRefs(this.repo), refs);
        if (fs.statSync(controlPath).mtimeMs !== controlMtime) Poll.log('Observed expected v1 positive control scratch-directory mtime change only.');
        assert.equal(fs.existsSync(path.join(this.store, 'unsupported-never-created')), false);
        Poll.log(result.stdout.trim());
        this.pass('actual previous native accepts v1 but neither unsupported scoped command nor old open can broaden v2');
    }

    async replaced(name, kind, operation) {
        const root = this.source(name);
        const parked = path.join(this.run, `parked-${name}`);
        fs.renameSync(root, parked);
        try {
            if (kind === 'empty replacement') fs.mkdirSync(root);
            if (kind === 'junction' && !this.junction(root)) return undefined;
            return await operation();
        } finally {
            if (kind === 'junction' && fs.existsSync(root)) fs.unlinkSync(root);
            if (kind === 'empty replacement') fs.rmdirSync(root);
            fs.renameSync(parked, root);
        }
    }

    junction(root) {
        try { fs.symlinkSync(this.source('G'), root, 'junction'); }
        catch (error) {
            if (['EACCES', 'EPERM', 'ENOTSUP'].includes(error.code)) return false;
            throw error;
        }
        assert.ok(fs.lstatSync(root).isSymbolicLink());
        assert.equal(fs.realpathSync.native(root), fs.realpathSync.native(this.source('G')));
        return true;
    }

    open(scope, codeName = this.code) {
        const request = { ...this.identity, codeName, ...(scope === undefined ? {} : { includeDirectories: scope }) };
        return this.client.command('QA_OpenScopedFileTracker', request);
    }

    openShape(reply, includes = this.picked) {
        this.ok(reply);
        assert.deepEqual(reply.includeDirectories, includes);
        assert.match(reply.trackerId, /^[0-9a-f-]{36}$/i);
        assert.ok(reply.bindingId);
        assert.equal(reply.projectPath, this.identity.projectPath);
        return reply;
    }

    direct(lease = this.lease) {
        const { trackerId, bindingId } = lease;
        return this.client.command('QA_CommitFileTracker', { trackerId, bindingId, ...this.capture });
    }

    async worker(expected) {
        const { trackerId, bindingId } = this.lease;
        const scope = { version: 1, operationId: randomUUID(), trackerId, bindingId, conversationId: this.capture.conversationId };
        const args = { ...scope, ...this.capture, reviewProof: this.proof };
        const started = await this.privateCommand('QA_StartFileTrackerCapture', args);
        assert.deepEqual(started, { success: true, msg: '', version: 1, status: 'pending', operationId: scope.operationId });
        for (const at = Date.now(); Date.now() - at < 30_000;) {
            const reply = await this.privateCommand('QA_GetFileTrackerCaptureStatus', scope);
            if (reply.status !== 'pending') {
                assert.equal(reply.status, expected, reply.result?.msg ?? reply.msg);
                return { args, reply };
            }
            await delay(75);
        }
        assert.fail('Timed out waiting for actual capture worker');
    }

    privateCommand(command, payload) {
        const id = 'filetracker-' + randomUUID().replaceAll('-', '');
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                Poll.pending.delete(id);
                reject(new Error(`No private native reply for ${command}`));
            }, 15_000);
            Poll.pending.set(id, reply => { clearTimeout(timer); resolve(reply); });
            this.client.requests.push({ command, id, ...payload });
            this.client.awake?.();
        });
    }

    assertCommit(reply, files, prior, repo = this.repo) {
        assert.equal(reply.changed, true);
        assert.equal(reply.truncated, false);
        assert.match(reply.commit, /^[a-f0-9]{40}$/);
        this.shadowContents(repo, reply.commit, files);
        const tree = this.shadow(repo, ['ls-tree', '-rz', reply.commit]).toString('utf8').split('\0').filter(Boolean);
        assert.equal(tree.length, files.size);
        assert.ok(tree.every(entry => /^100[67][45][45] blob /.test(entry)), 'unexpected non-blob tree entry/gitlink');
        for (const entry of tree) assert.doesNotMatch(entry.split('\t')[1], /(?:^|\/)(?:\.git|\.aiwork)(?:\/|$)/i);
        const changes = this.changes(files, prior);
        for (const kind of ['added', 'modified', 'deleted']) {
            assert.deepEqual(reply[kind], changes.filter(entry => entry.change === kind).map(({ change, ...entry }) => entry));
        }
    }

    changes(files, prior) {
        const result = [];
        for (const name of [...new Set([...files.keys(), ...prior.keys()])].sort()) {
            const oldSha = this.blob(prior.get(name)), newSha = this.blob(files.get(name));
            if (oldSha === newSha) continue;
            result.push({ path: name, oldSha, newSha, change: oldSha === null ? 'added' : newSha === null ? 'deleted' : 'modified' });
        }
        return result;
    }

    blob(bytes) { return bytes === undefined ? null : createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'); }
    version(name, files) {
        const bytes = files.get(name);
        if (!bytes) return { status: 'missing', size: null, encoding: null, base64: null };
        if (name.endsWith('.bin')) return { status: 'binary', size: bytes.length, encoding: null, base64: null };
        const encoding = bytes.subarray(0, 3).toString('hex') === 'efbbbf' ? 'utf8-bom' : 'utf8';
        return { status: 'text', size: bytes.length, encoding, base64: bytes.toString('base64') };
    }

    sourceGit() {
        const snapshots = {};
        for (const name of this.roots) {
            const cwd = this.source(name);
            snapshots[name] = { top: this.gitText(cwd, ['rev-parse', '--show-toplevel']), head: this.gitText(cwd, ['symbolic-ref', 'HEAD']),
                commit: this.git(cwd, ['rev-parse', '--verify', 'HEAD'], { accepted: [128] }).toString('utf8'),
                refs: this.gitText(cwd, ['for-each-ref', '--format=%(refname) %(objectname)']),
                index: this.gitText(cwd, ['ls-files', '--stage']), admin: this.directoryFingerprint(this.source(name, '.git')) };
        }
        return snapshots;
    }

    directoryFingerprint(root, controlDirectory = null) {
        const hash = createHash('sha256');
        for (const name of fs.readdirSync(root, { recursive: true }).sort()) {
            const file = path.join(root, name);
            const st = fs.lstatSync(file);
            const mtime = st.isDirectory() && name === controlDirectory ? null : st.mtimeMs;
            hash.update(JSON.stringify([name, st.isDirectory(), st.size, mtime, st.mode]));
            if (st.isFile()) hash.update(fs.readFileSync(file));
        }
        return hash.digest('hex');
    }

    sourceFingerprint() {
        const files = fs.readdirSync(this.scopeClient).filter(name => name === 'server.js' || /^file-track.*\.mts$/.test(name)).sort();
        return Object.fromEntries(files.map(name => [name, createHash('sha256').update(fs.readFileSync(path.join(this.scopeClient, name))).digest('hex')]));
    }

    provenanceCheck(before) {
        assert.deepEqual(this.sourceFingerprint(), before);
        assert.equal(Poll.unexpected, 0);
        assert.equal(fs.existsSync(process.env.FILE_TRACKER_SCOPE_NETWORK_LOG), false);
        const logs = JSON.stringify(Poll.muted);
        assert.ok(!logs.includes(this.proof));
        assert.ok(!logs.includes('live workspace bytes not committed'));
    }

    source(name, file = '') { return path.join(this.primary, name, file); }
    storeFingerprint() { return this.directoryFingerprint(path.dirname(this.repo)); }
    keep(name, files) { for (const file of files) this.baseline.set(`${name}/${file}`, fs.readFileSync(this.source(name, file))); }
    update(relative, bytes) { this.write(this.primary, relative, bytes); this.changed.set(relative, Buffer.from(bytes)); }
    ok(reply) { assert.equal(reply.success, true, reply.msg); return reply; }
    denied(reply, label) { assert.equal(reply.success, false, label); assert.ok(reply.msg?.trim(), label); }
    assertNoop(reply, sha) {
        assert.equal(reply.changed, false);
        assert.equal(reply.commit, sha);
        assert.equal(reply.previousCommit, sha);
        assert.deepEqual(reply.counts, { added: 0, modified: 0, deleted: 0 });
    }
    pass(group, assertion) { assertion?.(); this.groups++; Poll.log(`PASS ${group}`); }
    skip(group) { this.skips.push(group); Poll.log(`SKIP ${group}`); }
}

if (!isMainThread) OfflineWorker.install();
else {
    try {
        const old = process.env.FILE_TRACKER_SCOPE_OLD_REQUEST;
        if (old) await OldClientProbe.run(JSON.parse(old));
        else {
            SelectiveRoots.checkEnvironment();
            await new SelectiveRoots().runChecks();
        }
    }
    catch (error) { Poll.log('FAIL', error); process.exitCode = 1; }
    process.exit(process.exitCode ?? 0);
}
