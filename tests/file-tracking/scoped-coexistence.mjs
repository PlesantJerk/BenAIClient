import assert from 'node:assert/strict';
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

// Run against actual Windows Git and Node worker threads, with no live transport:
//   node --import ./tests/file-tracking/scoped-coexistence.mjs ./tests/file-tracking/scoped-coexistence.mjs
// Set FILE_TRACKER_QA_TMP to an existing external scratch directory. Optionally use
// FILE_TRACKER_QA_CLIENT for an archived client and FILE_TRACKER_QA_DEPENDENCIES for its installed dependencies.
class OfflineWorker {
    static install() {
        const deny = () => {
            fs.appendFileSync(process.env.FILE_TRACKER_COEXIST_NETWORK_LOG, 'denied\n');
            throw new Error('Coexistence test denied worker networking');
        };
        globalThis.fetch = deny;
        Socket.prototype.connect = deny;
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

class Coexistence extends Fixture {
    static clientPath = path.resolve(process.env.FILE_TRACKER_QA_CLIENT ?? fileURLToPath(new URL('../../', import.meta.url)));
    app = path.join(this.primary, 'dotnet', 'App');
    clientRoot = path.join(this.primary, 'Client');
    other = path.join(this.primary, 'dotnet', 'Other');
    roots = [this.app, this.clientRoot, this.other];
    picked = ['Client', 'dotnet/App'];
    file = 'source.txt';
    appFirst = '\uFEFFApp earliest bytes 雪\r\nline 2\r\n';
    appOld = 'App historic edit 🐾\r\nline 2\r\n';
    appNext = 'App combined edit\r\n';
    clientOld = 'Client original\r\n';
    clientNext = 'Client combined edit 雪\r\n';
    proof = 'offline_coexistence_synthetic_proof';
    capture = { conversationId: '9007199254740993', statementId: '9223372036854775806', description: 'Disposable coexistence test' };
    groups = 0;

    static checkEnvironment() {
        assert.equal(process.platform, 'win32', 'Windows path identity and Git required');
        assert.ok(process.execArgv.includes('--import'), 'use the documented --import to guard worker isolates');
        const scratch = path.resolve(process.env.FILE_TRACKER_QA_TMP ?? '');
        const relative = path.relative(this.clientPath, scratch);
        assert.ok(process.env.FILE_TRACKER_QA_TMP && (path.isAbsolute(relative) || relative === '..' || relative.startsWith('..' + path.sep)),
            'FILE_TRACKER_QA_TMP must name an existing external scratch directory');
    }

    async runChecks() {
        try {
            const fingerprints = this.sourceHashes();
            this.setup();
            const ordinary = this.ordinaryState();
            await this.seedHistoricChild();
            await this.checkCombined();
            await this.checkChildAfterCombined();
            await this.checkInvalidIncludes();
            await this.checkWholeTreeAndPartialOverlap();
            await this.checkForeignMetadata();
            assert.deepEqual(this.ordinaryState(), ordinary, 'ordinary source Git metadata/branch/index/config/refs changed');
            assert.deepEqual(this.sourceHashes(), fingerprints, 'client inputs changed during the run');
            assert.equal(Poll.unexpected, 0, 'network use outside offline poll');
            assert.equal(fs.existsSync(process.env.FILE_TRACKER_COEXIST_NETWORK_LOG), false, 'worker attempted network');
            assert.ok(!JSON.stringify(Poll.muted).includes(this.proof), 'private capture proof leaked to client logs');
            this.pass('ordinary Git administration and source hashes unchanged; offline transport only');
            Poll.log(`SUMMARY ${this.groups} groups passed`);
        } finally {
            this.remove();
        }
    }

    setup() {
        Object.assign(this.env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: this.config, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' });
        fs.writeFileSync(this.config, '');
        for (const name of Object.keys(process.env)) if (/^git_/i.test(name)) delete process.env[name];
        Object.assign(process.env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: this.config, GIT_OPTIONAL_LOCKS: '0' });
        for (const [root, initial] of [[this.app, this.appFirst], [this.clientRoot, this.clientOld], [this.other, 'Unselected sibling\r\n']]) {
            this.seedRepo(root, initial);
        }
        this.write(this.primary, 'parent-unselected.txt', 'not a selected root\n');
        this.write(this.app, '.aiwork/private-canary.txt', 'excluded lowercase work area\n');
        assert.ok(fs.readdirSync(this.app).includes('.aiwork'));
        assert.equal(this.git(this.primary, ['rev-parse', '--show-toplevel'], { accepted: [128] }).length, 0);
        process.env.FILE_TRACKER_COEXIST_NETWORK_LOG = path.join(this.run, 'worker-network-attempts');
        Poll.install(Coexistence.clientPath);
        this.route = new Poll(this.virtual, 'scoped-coexistence');
        this.child = this.location(this.app, 'cb', '.aiwork');
        this.combined = this.location(this.primary, 'cb-and-client');
        this.adjacent = this.location(this.other, 'adjacent');
        Poll.log(JSON.stringify({ node: process.version, git: this.gitText(this.run, ['--version']), source: this.sourceHashes() }));
    }

    seedRepo(root, initial) {
        fs.mkdirSync(root, { recursive: true });
        this.git(root, ['init', '--template=', '--initial-branch=source-fixture']);
        this.write(root, this.file, 'ordinary staged bytes untouched\n');
        this.git(root, ['add', '--', this.file]);
        this.write(root, this.file, initial);
        assert.match(this.gitText(root, ['status', '--porcelain=v1', '--', this.file]), /^AM source\.txt$/);
    }

    async seedHistoricChild() {
        this.originalLease = await this.openWhole(this.child);
        assert.equal(this.childManifest().version, 1);
        const seed = this.ok(await this.direct(this.originalLease));
        assert.equal(seed.baseline, true);
        this.write(this.app, this.file, this.appOld);
        const edit = this.ok(await this.direct(this.originalLease));
        assert.equal(edit.previousCommit, seed.commit);
        this.historic = this.pair(this.child, this.originalLease, seed, edit);
        this.historicEvidence = await this.checkpoint(this.historic, [[this.file, this.appFirst, this.appOld]]);
        this.adjacentLease = await this.openWhole(this.adjacent);
        this.adjacentFirst = this.ok(await this.direct(this.adjacentLease));
        this.childBefore = this.storeState(this.child);
        this.adjacentBefore = this.storeState(this.adjacent);
        this.pass('created preexisting v1 cb and a historical child checkpoint; exact immutable evidence before combined open');
    }

    async checkCombined() {
        const opened = await this.openScoped(this.combined, ['dotnet\\app', 'client']);
        if (!opened.success) {
            this.denied(opened, 'combined open');
            assert.equal(fs.existsSync(this.combined.store), false);
            this.assertChildUnchanged();
            Poll.log(`BASELINE REPRO: exact-root scoped open refused: ${opened.msg}`);
        }
        this.combinedLease = this.scoped(opened, this.picked);
        assert.notEqual(this.combinedLease.trackerId, this.originalLease.trackerId);
        assert.equal(this.shadowRefs(this.combined.repo), '', 'combined open is not a capture');
        this.assertChildUnchanged();
        this.combinedFirst = this.ok(await this.worker(this.combinedLease));
        assert.equal(this.combinedFirst.baseline, true);
        this.assertTree(this.combined.repo, this.combinedFirst.commit, this.appOld, this.clientOld);
        this.assertChildUnchanged();
        const reopened = this.scoped(await this.route.command('QA_OpenFileTracker', this.combined.address), this.picked);
        assert.equal(reopened.trackerId, this.combinedLease.trackerId);
        assert.notEqual(reopened.bindingId, this.combinedLease.bindingId);
        this.assertChildUnchanged();
        this.write(this.app, this.file, this.appNext);
        this.write(this.clientRoot, this.file, this.clientNext);
        this.write(this.other, 'only-unselected.txt', 'unselected sibling canary\n');
        const delta = this.ok(await this.worker(reopened));
        assert.deepEqual(delta.counts, { added: 0, modified: 2, deleted: 0 });
        assert.equal(delta.previousCommit, this.combinedFirst.commit);
        this.combinedPair = this.pair(this.combined, reopened, this.combinedFirst, delta);
        this.combinedChanges = [[`Client/${this.file}`, this.clientOld, this.clientNext], [`dotnet/App/${this.file}`, this.appOld, this.appNext]];
        this.combinedEvidence = await this.checkpoint(this.combinedPair, this.combinedChanges);
        this.assertTree(this.combined.repo, delta.commit, this.appNext, this.clientNext);
        assert.equal(this.shadow(this.combined.repo, ['rev-list', '--count', delta.commit]).toString('ascii').trim(), '2');
        this.assertChildUnchanged();
        this.pass('scoped worker baseline and one delta with both prefixes; lower-case .aiwork/.git/unselected sibling absent; child store unchanged');
    }

    async checkChildAfterCombined() {
        const combinedState = this.storeState(this.combined);
        const current = await this.openWhole(this.child);
        assert.equal(current.trackerId, this.originalLease.trackerId);
        assert.notEqual(current.bindingId, this.originalLease.bindingId);
        this.assertChildUnchanged();
        assert.deepEqual(await this.checkpoint(this.historic, [[this.file, this.appFirst, this.appOld]]), this.historicEvidence);
        const catchup = this.ok(await this.worker(current));
        assert.equal(catchup.previousCommit, this.historic.endCommit);
        const catchupPair = this.pair(this.child, current, { commit: this.historic.endCommit }, catchup);
        await this.checkpoint(catchupPair, [[this.file, this.appOld, this.appNext]]);
        this.write(this.app, 'child-only.txt', 'child-only working edit\r\n');
        const only = this.ok(await this.worker(current));
        assert.equal(only.previousCommit, catchup.commit);
        await this.checkpoint(this.pair(this.child, current, catchup, only), [['child-only.txt', null, 'child-only working edit\r\n']]);
        assert.deepEqual(this.storeState(this.combined), combinedState, 'child captures wrote the combined tracker');
        this.denied(await this.privateCommand('QA_FileTrackerReadManifest', { ...this.combinedPair, startCommit: catchup.commit, endCommit: only.commit, cursor: null }),
            'child commit pair cannot be reviewed through combined tracker');
        assert.deepEqual(await this.checkpoint(this.combinedPair, this.combinedChanges), this.combinedEvidence);
        fs.unlinkSync(path.join(this.app, 'child-only.txt'));
        const unchanged = this.ok(await this.worker(this.combinedLease));
        assert.equal(unchanged.changed, false);
        assert.equal(unchanged.commit, this.combinedPair.endCommit);
        assert.deepEqual(this.storeState(this.combined), combinedState, 'combined changed even after child-only working edit was removed');
        assert.deepEqual(await this.checkpoint(this.historic, [[this.file, this.appFirst, this.appOld]]), this.historicEvidence);
        assert.deepEqual(fs.readFileSync(this.child.manifest), this.childBefore.manifest);
        this.pass('existing child reopens and captures with combined present; both histories isolated and original child evidence unchanged');
        await this.checkAdjacent();
    }

    async checkAdjacent() {
        assert.deepEqual(this.storeState(this.adjacent), this.adjacentBefore);
        const combined = this.storeState(this.combined);
        const newLease = await this.openWhole(this.adjacent);
        assert.equal(newLease.trackerId, this.adjacentLease.trackerId);
        const edited = this.ok(await this.worker(newLease));
        assert.equal(edited.previousCommit, this.adjacentFirst.commit);
        assert.deepEqual(edited.counts, { added: 1, modified: 0, deleted: 0 });
        const unchanged = this.ok(await this.worker(this.combinedLease));
        assert.equal(unchanged.changed, false);
        assert.equal(unchanged.commit, this.combinedPair.endCommit);
        assert.deepEqual(this.storeState(this.combined), combined);
        this.pass('unselected adjacent v1 beneath the shared dotnet branch can reopen/capture but remains invisible to combined');
    }

    async checkInvalidIncludes() {
        const before = this.storeState(this.combined);
        for (const include of [undefined, [], ['Client'], ['Client', 'Client'], ['dotnet', 'dotnet/App'], ['Client', '..'], ['Client', 'missing']]) {
            this.denied(await this.openScoped(this.combined, include), 'invalid/replaced scope cannot change an existing tracker');
            const fresh = this.location(this.primary, 'invalid-no-fallback');
            const invalid = include?.length === 1 ? ['Client/missing'] : include;
            this.denied(await this.openScoped(fresh, invalid), 'invalid new scope cannot create a broad tracker');
            assert.equal(fs.existsSync(fresh.store), false);
        }
        this.write(this.app, this.file, 'would partially publish if Client were silently skipped\r\n');
        const parked = path.join(this.run, 'parked-client');
        fs.renameSync(this.clientRoot, parked);
        try {
            await this.checkMissingRoot('missing');
            fs.mkdirSync(this.clientRoot);
            try { await this.checkMissingRoot('replaced'); }
            finally { fs.rmdirSync(this.clientRoot); }
        } finally {
            fs.renameSync(parked, this.clientRoot);
            this.write(this.app, this.file, this.appNext);
        }
        assert.deepEqual(this.storeState(this.combined), before, 'denied live scopes changed private Git or manifest');
        this.pass('invalid, missing and same-path replacement includes deny opens and direct/worker capture; no broad/partial fallback; reviews still work');
    }

    async checkMissingRoot(label) {
        this.denied(await this.openScoped(this.combined, this.picked), `${label} root explicit open`);
        this.denied(await this.route.command('QA_OpenFileTracker', this.combined.address), `${label} root plain reopen`);
        this.denied(await this.direct(this.combinedLease), `${label} root legacy capture`);
        this.denied(await this.worker(this.combinedLease, 'error'), `${label} root worker capture`);
        assert.deepEqual(await this.checkpoint(this.combinedPair, this.combinedChanges), this.combinedEvidence);
    }

    async checkWholeTreeAndPartialOverlap() {
        const wholeAbove = this.location(path.dirname(this.app), 'whole-above-child');
        this.denied(await this.route.command('QA_OpenFileTracker', wholeAbove.address), 'whole-tree parent cannot swallow existing child');
        assert.equal(fs.existsSync(wholeAbove.store), false);
        const nested = path.join(this.app, 'nested');
        fs.mkdirSync(nested);
        const wholeBelow = this.location(nested, 'whole-below-child');
        this.denied(await this.route.command('QA_OpenFileTracker', wholeBelow.address), 'whole-tree child cannot nest below whole tracker');
        assert.equal(fs.existsSync(wholeBelow.store), false);
        for (const scope of [['dotnet', 'Client'], ['dotnet/App/nested', 'Client']]) {
            const partial = this.location(this.primary, 'partial-overlap');
            this.denied(await this.openScoped(partial, scope), 'proper ancestor/descendant overlap is not an exact-root exception');
            assert.equal(fs.existsSync(partial.store), false);
        }
        const root = path.join(this.virtual, 'legacy-boundary');
        const legacyParent = this.location(root, 'whole-parent');
        const legacyChild = this.location(path.join(root, 'child'), 'whole-child');
        fs.mkdirSync(path.join(root, 'child'), { recursive: true });
        const lease = await this.openWhole(legacyParent);
        const before = this.storeState(legacyParent);
        this.denied(await this.route.command('QA_OpenFileTracker', legacyChild.address), 'existing whole parent still forbids ordinary descendant');
        assert.equal(fs.existsSync(legacyChild.store), false);
        assert.deepEqual(this.storeState(legacyParent), before);
        this.ok(await this.direct(lease));
        this.pass('old whole-tree nesting and scoped proper ancestor/descendant overlap still denied, with no private creation');
    }

    async checkForeignMetadata() {
        for (const kind of ['empty', 'malformed']) {
            const parent = path.join(this.virtual, `foreign-${kind}`);
            const root = path.join(parent, 'App');
            this.seedRepo(root, 'ordinary test source\n');
            const tracking = path.join(root, '.aiwork', 'tracking');
            fs.mkdirSync(tracking, { recursive: true });
            if (kind === 'malformed') {
                this.write(tracking, 'foreign/tracker.json', '{"version":1,"trackerId":"wrong"}\n');
                this.write(tracking, 'foreign/sentinel.txt', 'foreign data must stay unchanged\n');
            }
            const fresh = this.location(parent, 'must-not-open');
            const pre = this.fingerprint(path.join(root, '.aiwork'));
            this.denied(await this.openScoped(fresh, ['App']), `${kind} exact-root namespace is not a verified independent v1 tracker`);
            assert.equal(fs.existsSync(fresh.store), false);
            assert.equal(this.fingerprint(path.join(root, '.aiwork')), pre);
        }
        await this.checkForeignMetadataDuringCapture();
        this.pass('empty/malformed private namespaces deny new opens and newly foreign entries prevent capture without changing evidence');
    }

    async checkForeignMetadataDuringCapture() {
        const before = this.storeState(this.combined);
        const unexpected = path.join(path.dirname(this.child.store), 'foreign-entry');
        this.write(unexpected, 'notes.txt', 'not a private store\n');
        const foreignBefore = this.fingerprint(unexpected);
        const childBefore = this.storeState(this.child);
        this.write(this.app, this.file, 'must not capture after foreign metadata appears\r\n');
        try {
            this.denied(await this.openScoped(this.combined, this.picked), 'late foreign metadata: reopen');
            this.denied(await this.direct(this.combinedLease), 'late foreign metadata: direct capture');
            this.denied(await this.worker(this.combinedLease, 'error'), 'late foreign metadata: worker capture');
            assert.deepEqual(await this.checkpoint(this.combinedPair, this.combinedChanges), this.combinedEvidence);
            assert.equal(this.fingerprint(unexpected), foreignBefore);
            assert.deepEqual(this.storeState(this.child), childBefore);
            assert.deepEqual(this.storeState(this.combined), before);
        } finally {
            fs.unlinkSync(path.join(unexpected, 'notes.txt'));
            fs.rmdirSync(unexpected);
            this.write(this.app, this.file, this.appNext);
        }
    }

    openWhole(location) {
        return this.route.command('QA_OpenFileTracker', location.address).then(reply => {
            this.ok(reply);
            assert.equal(Object.hasOwn(reply, 'includeDirectories'), false);
            assert.match(reply.trackerId, /^[a-f0-9-]{36}$/);
            return reply;
        });
    }

    openScoped(location, includeDirectories) {
        return this.route.command('QA_OpenScopedFileTracker', { ...location.address, includeDirectories });
    }

    scoped(reply, includes) {
        this.ok(reply);
        assert.deepEqual(reply.includeDirectories, includes);
        assert.match(reply.trackerId, /^[a-f0-9-]{36}$/);
        return reply;
    }

    direct({ trackerId, bindingId }) {
        return this.route.command('QA_CommitFileTracker', { trackerId, bindingId, ...this.capture });
    }

    async worker({ trackerId, bindingId }, expected = 'completed') {
        const scope = { version: 1, operationId: randomUUID(), trackerId, bindingId, conversationId: this.capture.conversationId };
        const started = await this.privateCommand('QA_StartFileTrackerCapture', { ...scope, ...this.capture, reviewProof: this.proof });
        assert.deepEqual(started, { success: true, msg: '', version: 1, status: 'pending', operationId: scope.operationId });
        const until = Date.now() + 60_000;
        while (Date.now() < until) {
            const response = await this.privateCommand('QA_GetFileTrackerCaptureStatus', scope);
            assert.equal(response.success, true, response.msg);
            assert.equal(response.operationId, scope.operationId);
            if (response.status !== 'pending') {
                assert.equal(response.status, expected, response.result?.msg ?? response.msg);
                return response.result;
            }
            await delay(75);
        }
        assert.fail('actual native capture worker never produced a terminal receipt');
    }

    privateCommand(command, payload) {
        const id = 'filetracker-' + randomUUID().replaceAll('-', '');
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                Poll.pending.delete(id);
                reject(new Error(`No private native reply for ${command}`));
            }, 15_000);
            Poll.pending.set(id, reply => { clearTimeout(timer); resolve(reply); });
            this.route.requests.push({ command, id, ...payload });
            this.route.awake?.();
        });
    }

    async checkpoint(pair, changes) {
        const manifest = this.ok(await this.privateCommand('QA_FileTrackerReadManifest', { ...pair, cursor: null }));
        assert.equal(manifest.nextCursor, null);
        assert.equal(manifest.totalCount, changes.length);
        assert.equal(manifest.startCommit, pair.startCommit);
        assert.equal(manifest.endCommit, pair.endCommit);
        const entries = changes.map(([name, old, next]) => ({ path: name, change: old === null ? 'added' : 'modified', oldSha: this.blob(old), newSha: this.blob(next) }));
        assert.deepEqual(manifest.entries, entries);
        const versions = [];
        for (const [i, entry] of entries.entries()) {
            const { path, oldSha, newSha } = entry;
            const selected = this.ok(await this.privateCommand('QA_FileTrackerReadFile', { ...pair, path, oldSha, newSha }));
            assert.deepEqual([selected.path, selected.oldSha, selected.newSha, selected.startCommit, selected.endCommit], [path, oldSha, newSha, pair.startCommit, pair.endCommit]);
            for (const [side, text] of [['original', changes[i][1]], ['final', changes[i][2]]]) {
                const version = selected[side];
                assert.equal(version.status, text === null ? 'missing' : 'text');
                assert.deepEqual(version.base64 === null ? null : Buffer.from(version.base64, 'base64'), text === null ? null : Buffer.from(text));
            }
            versions.push(selected);
        }
        return { manifest, versions };
    }

    assertTree(repo, commit, app, client) {
        const expected = new Map([[`Client/${this.file}`, Buffer.from(client)], [`dotnet/App/${this.file}`, Buffer.from(app)]]);
        this.shadowContents(repo, commit, expected);
        const records = this.shadow(repo, ['ls-tree', '-rz', commit]).toString('utf8').split('\0').filter(Boolean);
        assert.ok(records.every(line => /^100644 blob /.test(line)), 'combined repo contains a gitlink or unexpected type');
        assert.ok(records.every(line => !/(?:\t|\/)(?:\.git|\.aiwork)(?:\/|$)/i.test(line)), 'combined repo contains private metadata');
    }

    location(directory, codeName, work = '.AIWork') {
        const store = path.join(directory, work, 'tracking', codeName);
        return { address: { virtualRoot: this.virtual, projectPath: this.pathFor(directory), codeName }, store,
            repo: path.join(store, 'repo.git'), manifest: path.join(store, 'tracker.json') };
    }

    pair(location, lease, start, end) {
        return { ...location.address, trackerId: lease.trackerId, startCommit: start.commit, endCommit: end.commit };
    }

    ordinaryState() {
        return this.roots.map(root => ({ raw: this.fingerprint(path.join(root, '.git')),
            branch: this.gitText(root, ['symbolic-ref', 'HEAD']), index: this.gitText(root, ['ls-files', '--stage']),
            refs: this.gitText(root, ['for-each-ref', '--format=%(refname) %(objectname)']) }));
    }

    storeState(location) {
        const ref = path.join(location.repo, 'refs', 'heads', 'tracking');
        return { manifest: fs.readFileSync(location.manifest), rawRef: fs.existsSync(ref) ? fs.readFileSync(ref) : null,
            refs: this.shadowRefs(location.repo), hash: this.fingerprint(location.store) };
    }

    fingerprint(root) {
        const hash = createHash('sha256');
        for (const name of fs.readdirSync(root, { recursive: true }).sort()) {
            const file = path.join(root, name), stat = fs.lstatSync(file, { bigint: true });
            // Directory mtimes can change when an Open creates and removes its warnings scratch.
            hash.update(JSON.stringify([name, String(stat.ino), stat.isDirectory(), String(stat.mode), stat.isFile() ? String(stat.mtimeNs) : null]));
            if (stat.isFile()) hash.update(fs.readFileSync(file));
        }
        return hash.digest('hex');
    }

    sourceHashes() {
        const client = Coexistence.clientPath;
        const files = fs.readdirSync(client).filter(name => name === 'server.js' || /^file-tracker.*\.mts$/.test(name)).sort();
        return Object.fromEntries(files.map(name => [name, createHash('sha256').update(fs.readFileSync(path.join(client, name))).digest('hex')]));
    }

    assertChildUnchanged() {
        assert.deepEqual(this.storeState(this.child), this.childBefore, 'combined operation changed v1 private store bytes, file identity, manifest or raw ref');
        assert.equal(this.childManifest().trackerId, this.originalLease.trackerId);
        assert.deepEqual(this.storeState(this.adjacent), this.adjacentBefore, 'combined operation changed unselected private store');
    }

    childManifest() { return JSON.parse(fs.readFileSync(this.child.manifest, 'utf8')); }
    blob(text) { return text === null ? null : createHash('sha1').update(`blob ${Buffer.byteLength(text)}\0`).update(text).digest('hex'); }
    ok(reply) { assert.equal(reply.success, true, reply.msg); return reply; }
    denied(reply, label) { assert.equal(reply?.success, false, label); assert.ok(reply.msg?.trim(), label); }
    pass(message) { ++this.groups; Poll.log(`PASS ${message}`); }
}

if (!isMainThread) OfflineWorker.install();
else {
    try { Coexistence.checkEnvironment(); await new Coexistence().runChecks(); }
    catch (error) { Poll.log('FAIL', error); process.exitCode = 1; }
    process.exit(process.exitCode ?? 0);
}
