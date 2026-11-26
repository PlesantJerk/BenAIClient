import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Fixture } from './fixture.mjs';
import { PollClient } from './poll-client.mjs';

class CheckpointReviewCheck {
    fixture = new Fixture();
    codeName = 'Review';
    proof = 'offline_review_proof_only_Ck013';
    capture = { conversationId: '9223372036854775807', statementId: '9007199254740993', description: 'Review \\"escaped\\" 🐾\nUnicode 雪' };
    label = 'checkpoint';
    extraFiles = 300;
    maxText = Buffer.alloc(65_536, 65);
    rawBinary = Buffer.from([0, 255, 0, 9]);
    rawInvalid = Buffer.from([0xc3, 0x28]);
    utf16le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('雪\r\n', 'utf16le')]);
    utf16be = Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from('羊\r\n', 'utf16le').swap16()]);

    async run() {
        const source = process.env.FILE_TRACKER_QA_CLIENT ?? fileURLToPath(new URL('../../', import.meta.url));
        PollClient.install(source);
        const f = this.fixture;
        try {
            f.initialize();
            this.seed();
            this.client = new PollClient(f.virtual, this.label);
            this.identity = { virtualRoot: f.virtual, codeName: this.codeName, projectPath: f.pathFor(f.primary) };
            this.repo = path.join(f.primary, '.AIWork', 'tracking', this.codeName, 'repo.git');
            this.initial = this.ok(await this.client.command('QA_OpenFileTracker', this.identity));
            this.identity.trackerId = this.initial.trackerId;
            this.lease = { trackerId: this.initial.trackerId, bindingId: this.initial.bindingId };
            this.ordinary = f.realState();
            await this.checkCaptures();
            await this.checkManifest();
            await this.checkVersions();
            await this.checkRejected();
            await this.checkHistoricalAndLeases();
            assert.deepEqual(f.realState(), this.ordinary, 'ordinary Git state was modified');
            assert.equal(PollClient.unexpected, 0, 'real network access attempted');
            const log = JSON.stringify(PollClient.muted);
            for (const privateValue of [this.proof, 'QA_FileTrackerReadManifest', 'QA_FileTrackerReadFile', 'old part only\r\n', this.utf16le.toString('base64')]) {
                assert.ok(!log.includes(privateValue), 'private tracker input or result was logged');
            }
            PollClient.log('PASS: real poll routes, historical Git, exact complete manifests, byte and denial scenarios, read-only/no private logs');
        } finally { f.remove(); }
    }

    seed() {
        const f = this.fixture;
        for (const [p, bytes] of Object.entries({
            'both.txt': 'old part only\r\n', 'gone-empty.txt': Buffer.alloc(0), 'future-delete.txt': 'will be deleted\r\n',
            'utf16.txt': this.utf16le, 'boundary.txt': this.maxText,
        })) f.capture(p, bytes);
        for (let i = 0; i < this.extraFiles; i++) f.capture(this.extraPath(i), `original number ${i}\n`);
        f.changed = new Map(f.baseline);
    }

    async checkCaptures() {
        const f = this.fixture;
        this.baseline = await this.commit();
        assert.equal(this.baseline.baseline, true);
        const staged = this.pair(null, this.baseline.commit);
        const baseline = await this.list(staged);
        assert.deepEqual(baseline.provenance, { ...this.capture, reviewProof: null });
        assert.equal(baseline.entries.length, f.baseline.size);
        assert.deepEqual(baseline.counts, { added: f.baseline.size, modified: 0, deleted: 0 });
        this.sameManifest(baseline.entries, f.baseline, new Map());

        f.edits();
        for (const [p, bytes] of Object.entries({
            'both.txt': 'new part only\n', 'utf16.txt': this.utf16be, 'boundary.txt': Buffer.alloc(65_537, 66),
            'empty.txt': Buffer.alloc(0), 'has-nul.bin': this.rawBinary, 'malformed.txt': this.rawInvalid,
        })) f.capture(p, bytes, f.changed);
        for (const p of ['gone-empty.txt', 'future-delete.txt']) {
            fs.unlinkSync(path.join(f.primary, p));
            f.changed.delete(p);
        }
        for (let i = 0; i < this.extraFiles; i++) f.capture(this.extraPath(i), `final number ${i}\n`, f.changed);
        this.edit = await this.commit({ reviewProof: this.proof, statementId: null });
        assert.equal(this.edit.previousCommit, this.baseline.commit);
        assert.equal(this.edit.truncated, true, 'fixture must exceed capture example cap');
        assert.ok(!JSON.stringify(this.edit).includes(this.proof), 'capture exposed private proof');
        this.currentPair = this.pair(this.baseline.commit, this.edit.commit);
        this.beforeReads = this.storeFingerprint();
        // The current worktree is neither the start nor end checkpoint, and some selected paths no longer exist.
        f.write(f.primary, 'both.txt', 'current workspace text must never be returned\n');
        fs.unlinkSync(path.join(f.primary, 'utf16.txt'));
    }

    async checkManifest() {
        const complete = await this.list(this.currentPair);
        this.entries = new Map(complete.entries.map(entry => [entry.path, entry]));
        this.firstCursor = complete.firstCursor;
        assert.ok(this.firstCursor, 'expected multiple manifest pages');
        assert.ok(complete.entries.length > this.extraFiles);
        assert.deepEqual(complete.counts, this.edit.counts);
        assert.deepEqual(complete.provenance, { ...this.capture, statementId: null, reviewProof: this.proof });
        this.sameManifest(complete.entries, this.fixture.changed, this.fixture.baseline);
        assert.equal(this.storeFingerprint(), this.beforeReads, 'manifest changed private tracker bytes or files');
        PollClient.log(`PASS: ${complete.entries.length} exact manifest changes over ${complete.pages} bounded pages`);
    }

    async checkVersions() {
        const both = await this.read('both.txt');
        this.text(both.original, 'utf8', 'old part only\r\n');
        this.text(both.final, 'utf8', 'new part only\n');
        const bom = await this.read('bytes.crlf');
        this.text(bom.original, 'utf8-bom', this.fixture.baseline.get('bytes.crlf'));
        const utf16 = await this.read('utf16.txt');
        this.text(utf16.original, 'utf16le-bom', this.utf16le);
        this.text(utf16.final, 'utf16be-bom', this.utf16be);
        const empty = await this.read('empty.txt');
        this.omitted(empty.original, 'missing', null);
        this.text(empty.final, 'utf8', Buffer.alloc(0));
        const gone = await this.read('gone-empty.txt');
        this.text(gone.original, 'utf8', Buffer.alloc(0));
        this.omitted(gone.final, 'missing', null);
        const large = await this.read('boundary.txt');
        this.text(large.original, 'utf8', this.maxText);
        this.omitted(large.final, 'tooLarge', 65_537);
        this.omitted((await this.read('has-nul.bin')).final, 'binary', this.rawBinary.length);
        this.omitted((await this.read('malformed.txt')).final, 'unsupportedEncoding', this.rawInvalid.length);
        assert.equal(this.storeFingerprint(), this.beforeReads, 'file review changed private tracker bytes or files');
    }

    async checkRejected() {
        const f = this.fixture;
        const both = this.entries.get('both.txt');
        const unrelated = this.entries.get(this.extraPath(0));
        const file = { path: both.path, oldSha: both.oldSha, newSha: both.newSha };
        const baselineTree = f.shadow(this.repo, ['rev-parse', `${this.baseline.commit}^{tree}`]).toString('ascii').trim();
        const alternateIdentity = { ...this.identity, projectPath: f.pathFor(f.alternate) };
        const alien = new PollClient(f.virtual, 'checkpoint-other-account');
        const freshSameNamed = new PollClient(f.virtual, this.label);
        const alternate = this.ok(await this.client.command('QA_OpenFileTracker', { ...alternateIdentity, codeName: 'Alternate' }));
        assert.notEqual(alternate.trackerId, this.identity.trackerId);
        for (const request of [
            { codeName: 'NeverCreate' }, { trackerId: alternate.trackerId }, { trackerId: randomUUID() }, alternateIdentity,
            { projectPath: this.identity.projectPath.replaceAll('/', '\\') }, { virtualRoot: f.alternate },
            { startCommit: null }, { startCommit: this.edit.commit }, { endCommit: this.baseline.commit },
            { endCommit: baselineTree }, { endCommit: '--all' }, { endCommit: 'f'.repeat(40) },
            { cursor: this.firstCursor.replace(/^\d+/, '1') },
        ]) this.no(await this.client.command('QA_FileTrackerReadManifest', { ...this.currentPair, cursor: null, ...request }));
        this.no(await this.client.command('QA_FileTrackerReadManifest', { ...this.pair(null, this.baseline.commit), cursor: this.firstCursor }));
        for (const request of [
            { path: '../outside.txt' }, { path: 'x:alternate' }, { path: 'BOTH.txt' }, { path: 'nowhere.txt' },
            { oldSha: unrelated.oldSha }, { newSha: unrelated.newSha }, { oldSha: both.newSha, newSha: both.oldSha },
            { oldSha: null }, { path: 'staged.txt', oldSha: null, newSha: null },
        ]) this.no(await this.client.command('QA_FileTrackerReadFile', { ...this.currentPair, ...file, ...request }));
        this.no(await alien.command('QA_FileTrackerReadFile', { ...this.currentPair, ...file, clientName: `qa-${this.label}`, account: `offline-${this.label}@example.invalid` }));
        this.ok(await freshSameNamed.command('QA_FileTrackerReadManifest', { ...this.currentPair, cursor: null }));
        this.no(await freshSameNamed.command('QA_CommitFileTracker', { ...this.lease, ...this.capture }));
        this.no(await freshSameNamed.command('QA_FileTrackerReadManifest', { ...this.currentPair, cursor: this.firstCursor }));
        assert.equal(fs.existsSync(path.join(path.dirname(this.repo), '..', 'NeverCreate')), false);
        assert.equal(this.storeFingerprint(), this.beforeReads, 'rejected reads mutated the existing tracker');
    }

    async checkHistoricalAndLeases() {
        const f = this.fixture;
        this.client.server.root_dir = f.alternate;
        this.no(await this.client.command('QA_FileTrackerReadManifest', { ...this.currentPair, cursor: null }));
        this.client.server.root_dir = f.virtual;
        this.client.server.SetClientName('qa-other-name');
        this.no(await this.client.command('QA_FileTrackerReadManifest', { ...this.currentPair, cursor: null }));
        this.client.server.SetClientName(`qa-${this.label}`);
        this.no(await this.client.command('QA_CommitFileTracker', { ...this.lease, ...this.capture, reviewProof: 'malformed proof' }));
        assert.equal(this.storeFingerprint(), this.beforeReads, 'malformed proof was captured');
        const third = await this.commit({ description: 'Capture after reads with the original binding' });
        assert.equal(third.previousCommit, this.edit.commit, 'review changed existing selection or binding');
        const fingerprint = this.storeFingerprint();
        this.no(await this.client.command('QA_FileTrackerReadManifest', { ...this.pair(this.baseline.commit, third.commit), cursor: null }));
        const old = await this.read('both.txt');
        this.text(old.original, 'utf8', 'old part only\r\n');
        this.text(old.final, 'utf8', 'new part only\n');
        const endPage = this.ok(await this.client.command('QA_FileTrackerReadManifest', { ...this.currentPair, cursor: this.firstCursor }));
        assert.equal(endPage.nextCursor, null, 'old cursor should still work after tracking head advanced');
        assert.equal(this.storeFingerprint(), fingerprint, 'historical reads changed private tracker');
        await this.unreachableRevision();
        await this.rejectSubstitutedTree(third.commit);
    }

    async unreachableRevision() {
        const f = this.fixture;
        const tree = f.shadow(this.repo, ['rev-parse', `${this.edit.commit}^{tree}`]).toString('ascii').trim();
        const fork = f.shadow(this.repo, ['-c', 'user.name=Offline Review', '-c', 'user.email=offline@example.invalid',
            'commit-tree', tree, '-p', this.baseline.commit, '-m', '{"ConversationID":1,"StatementID":null,"Description":"Unpublished synthetic revision"}']).toString('ascii').trim();
        // The exact commit object really exists inside this fixture's private Git repo, but never reached the tracking ref.
        assert.equal(f.shadow(this.repo, ['cat-file', '-t', fork]).toString('ascii').trim(), 'commit');
        const afterCreatingFixture = this.storeFingerprint();
        this.no(await this.client.command('QA_FileTrackerReadManifest', { ...this.pair(this.baseline.commit, fork), cursor: null }));
        assert.equal(this.storeFingerprint(), afterCreatingFixture);
    }

    async rejectSubstitutedTree(newestCommit) {
        const git = this.fixture;
        const treeOf = commit => git.shadow(this.repo, ['rev-parse', `${commit}^{tree}`]).toString('ascii').trim();
        const loose = sha => path.join(this.repo, 'objects', sha.slice(0, 2), sha.slice(2));
        const expected = loose(treeOf(this.edit.commit));
        const source = loose(treeOf(newestCommit));
        assert.notEqual(expected, source);
        const original = fs.readFileSync(expected);
        const mode = fs.statSync(expected).mode;
        fs.chmodSync(expected, 0o666); // Git for Windows creates its loose objects read-only.
        try {
            fs.writeFileSync(expected, fs.readFileSync(source));
            this.no(await this.client.command('QA_FileTrackerReadManifest', { ...this.currentPair, cursor: null }));
        } finally {
            fs.writeFileSync(expected, original);
            fs.chmodSync(expected, mode);
        }
        this.ok(await this.client.command('QA_FileTrackerReadManifest', { ...this.currentPair, cursor: null }));
    }

    async list(pair) {
        const entries = [];
        let cursor = null;
        let firstCursor;
        let counts;
        let provenance;
        let pages = 0;
        do {
            const result = this.ok(await this.client.command('QA_FileTrackerReadManifest', { ...pair, cursor }));
            assert.equal(result.startCommit, pair.startCommit);
            assert.equal(result.endCommit, pair.endCommit);
            assert.ok(result.entries.length <= 256 && Buffer.byteLength(JSON.stringify(result.entries)) <= 56 * 1024);
            counts ??= result.counts;
            provenance ??= result.provenance;
            assert.deepEqual(result.provenance, provenance);
            assert.deepEqual(result.counts, counts);
            assert.equal(result.totalCount, counts.added + counts.modified + counts.deleted);
            entries.push(...result.entries);
            cursor = result.nextCursor;
            firstCursor ??= cursor;
            assert.ok(++pages <= 128, 'cursor cycle');
        } while (cursor !== null);
        assert.equal(entries.length, counts.added + counts.modified + counts.deleted);
        assert.equal(new Set(entries.map(e => e.path)).size, entries.length, 'manifest ambiguously returned a repeated path');
        return { entries, counts, provenance, pages, firstCursor };
    }

    sameManifest(actual, final, original) {
        const expected = [];
        for (const p of [...new Set([...original.keys(), ...final.keys()])].sort()) {
            const oldSha = this.blob(original.get(p));
            const newSha = this.blob(final.get(p));
            if (oldSha !== newSha) expected.push({ path: p, change: oldSha === null ? 'added' : newSha === null ? 'deleted' : 'modified', oldSha, newSha });
        }
        assert.deepEqual(actual, expected, 'complete path/blob tuples differ from byte-preserving fixture oracle');
    }

    storeFingerprint() {
        const root = path.dirname(this.repo);
        const hash = createHash('sha256');
        for (const name of fs.readdirSync(root, { recursive: true }).sort()) {
            const p = path.join(root, name);
            const stat = fs.lstatSync(p);
            hash.update(JSON.stringify([name, stat.isDirectory(), stat.size, stat.mtimeMs]));
            if (stat.isFile()) hash.update(fs.readFileSync(p));
        }
        return hash.digest('hex');
    }

    blob(bytes) { return bytes === undefined ? null : createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'); }
    pair(startCommit, endCommit) { return { ...this.identity, startCommit, endCommit }; }
    extraPath(i) { return `bulk/${String(i).padStart(3, '0')}-雪.txt`; }
    async commit(overrides = {}) { return this.ok(await this.client.command('QA_CommitFileTracker', { ...this.lease, ...this.capture, ...overrides })); }

    async read(p) {
        const { path, oldSha, newSha } = this.entries.get(p);
        const reply = this.ok(await this.client.command('QA_FileTrackerReadFile', { ...this.currentPair, path, oldSha, newSha }));
        assert.equal(reply.path, path);
        assert.equal(reply.oldSha, oldSha);
        assert.equal(reply.newSha, newSha);
        assert.equal(reply.startCommit, this.currentPair.startCommit);
        assert.equal(reply.endCommit, this.currentPair.endCommit);
        assert.equal(Object.hasOwn(reply, 'provenance'), false);
        return reply;
    }

    ok(reply) { assert.equal(reply.success, true, reply.msg); return reply; }
    no(reply) {
        assert.equal(reply.success, false);
        assert.deepEqual(Object.keys(reply).sort(), ['msg', 'success']);
    }

    text(version, encoding, expected) {
        const bytes = Buffer.from(expected);
        assert.deepEqual(version, { status: 'text', size: bytes.length, encoding, base64: bytes.toString('base64') });
    }

    omitted(version, status, size) { assert.deepEqual(version, { status, size, encoding: null, base64: null }); }
}

try { await new CheckpointReviewCheck().run(); }
catch (error) { PollClient.log('FAIL', error); process.exitCode = 1; }

// The production poll server deliberately has no stop API; this offline process owns it.
process.exit(process.exitCode ?? 0);
