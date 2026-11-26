import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { PollClient } from './poll-client.mjs';
import { Fixture } from './fixture.mjs';

class LargeCaptures {
    static MiB = 1024 ** 2;

    async run() {
        const temp = process.env.FILE_TRACKER_QA_TMP ?? os.tmpdir();
        const disk = fs.statfsSync(temp, { bigint: true });
        assert.ok(disk.bavail * disk.bsize >= 2n * 1024n ** 3n, 'Fixture needs at least 2 GiB free for disposable data and Git staging.');
        const clientPath = process.env.FILE_TRACKER_QA_CLIENT ?? fileURLToPath(new URL('../../', import.meta.url));
        PollClient.install(path.normalize(clientPath).replace(/[\\/]$/, ''));
        this.fixture = new Fixture();
        try {
            this.fixture.initialize();
            this.client = new PollClient(this.fixture.virtual, 'large-captures');
            this.target = { virtualRoot: this.fixture.virtual, projectPath: this.fixture.pathFor(this.fixture.alternate), codeName: 'ScaleTracker' };
            this.lease = this.ok(await this.client.command('QA_OpenFileTracker', this.target));
            this.repo = path.join(this.fixture.alternate, '.AIWork', 'tracking', this.target.codeName, 'repo.git');
            const expected = this.largeFiles();
            const baseline = await this.capture('Aggregate synthetic capture larger than 256 MiB');
            assert.equal(baseline.baseline, true);
            for (const member of expected) this.assertStored(baseline.commit, member);
            PollClient.log(`PASS aggregate capture ${expected.reduce((n, item) => n + item.size, 0)} raw bytes across ${expected.length} files, exact stock Git hashes`);
            await this.fullVersion(baseline, expected[0]);
            if (process.argv.includes('--files')) await this.manyFiles(baseline);
            assert.equal(PollClient.unexpected, 0);
        } finally { this.fixture.remove(); }
    }

    largeFiles() {
        const files = [];
        fs.appendFileSync(path.join(this.fixture.alternate, '.gitignore'), '\nignored-scale/\n');
        for (let i = 0; i < 9; i++) {
            const relative = `large-${i}.txt`, size = 30 * LargeCaptures.MiB + i;
            const full = path.join(this.fixture.alternate, relative);
            const fd = fs.openSync(full, 'wx');
            const text = Buffer.alloc(LargeCaptures.MiB, 65 + i);
            // Include Unicode and CRLF split across native 64 KiB reply boundaries.
            Buffer.from('𐐷\r\n', 'utf8').copy(text, 65_534);
            try {
                for (let j = 0; j < 30; j++) fs.writeSync(fd, text);
                if (i) fs.writeSync(fd, Buffer.alloc(i, 90));
            } finally { fs.closeSync(fd); }
            files.push({ relative, size, sha: this.gitText(['hash-object', '--no-filters', '--', full]) });
        }
        return files;
    }

    async fullVersion(baseline, member) {
        const args = { ...this.target, trackerId: this.lease.trackerId, startCommit: null, endCommit: baseline.commit,
            path: member.relative, oldSha: null, newSha: member.sha };
        fs.writeFileSync(path.join(this.fixture.alternate, member.relative), 'not part of the immutable version');
        const preview = this.ok(await this.file(args));
        assert.equal(preview.final.status, 'tooLarge');
        const opened = this.ok(await this.file({ ...args, transfer: 'open' }));
        const reader = { ...args, readerId: opened.readerId };
        assert.equal(opened.originalSize, null);
        assert.equal(opened.finalSize, String(member.size));
        try {
            this.denied(await this.file({ ...reader, transfer: 'chunk', side: 'final', offset: '000' }));
            this.denied(await this.file({ ...reader, transfer: 'chunk', side: 'final', offset: String(member.size) }));
            this.denied(await this.file({ ...reader, transfer: 'chunk', side: 'original', offset: '0' }));
            this.denied(await this.file({ ...reader, transfer: 'chunk', side: 'final', offset: '0', path: 'foreign.txt' }));
            this.denied(await this.file({ ...reader, transfer: 'close', codeName: 'Foreign' }));
            this.client.server.SetClientName('qa-wrong-route');
            this.denied(await this.file({ ...reader, transfer: 'chunk', side: 'final', offset: '0' }));
            this.client.server.SetClientName('qa-large-captures');
            await this.assertTransferred(reader, member);
        } finally {
            this.ok(await this.file({ ...reader, transfer: 'close' }));
        }
        this.denied(await this.file({ ...reader, transfer: 'chunk', side: 'final', offset: '0' }));
        assert.equal(fs.readdirSync(path.dirname(this.repo)).some(name => name.startsWith('.capture-')), false);
        PollClient.log(`PASS real native transfer ${member.size} historical bytes; exact Git hash; tuple, side, offset, route and closed-reader denials`);
    }

    async assertTransferred(reader, member) {
        const hash = createHash('sha1').update(`blob ${member.size}\0`);
        for (let offset = 0; offset < member.size;) {
            const args = { ...reader, transfer: 'chunk', side: 'final', offset: String(offset) };
            const reply = this.ok(await this.file(args));
            assert.equal(reply.offset, args.offset);
            assert.equal(reply.newSha, member.sha);
            if (reply.pending) {
                assert.equal(reply.base64, null);
                await wait(50);
                continue;
            }
            const bytes = Buffer.from(reply.base64, 'base64');
            assert.equal(bytes.length, Math.min(65_536, member.size - offset));
            hash.update(bytes);
            offset += bytes.length;
        }
        assert.equal(hash.digest('hex'), member.sha);
    }

    async manyFiles(baseline) {
        const root = this.fixture.alternate;
        const dir = path.join(root, 'many');
        const ignored = path.join(root, 'ignored-scale');
        fs.mkdirSync(dir);
        fs.mkdirSync(ignored);
        for (let i = 0; i < 8_001; i++) fs.writeFileSync(path.join(dir, `${i}.txt`), 'equal bytes\r\n');
        for (let i = 0; i < 30_001; i++) fs.closeSync(fs.openSync(path.join(ignored, `${i}.tmp`), 'wx'));
        // Enumerate >30,000 names in a single included directory, while Git filters the ignored children.
        fs.writeFileSync(path.join(root, '.gitignore'), 'ignored-scale/*.tmp\n');
        const next = await this.capture('Capture over old file and directory-entry counts');
        assert.equal(next.previousCommit, baseline.commit);
        assert.equal(next.counts.added, 8_001);
        assert.equal(next.truncated, true);
        const found = await this.manifest(baseline.commit, next.commit);
        assert.equal(found.size, 8_003); // new entries + .gitignore and live large-0 edits
        assert.equal(found.get('many/8000.txt').newSha, this.gitText(['hash-object', '--no-filters', '--', path.join(dir, '8000.txt')]));
        assert.ok(![...found.keys()].some(name => name.startsWith('ignored-scale/')));
        const unchanged = await this.capture('Read and compare prior private tree with more than 8,000 files');
        assert.equal(unchanged.changed, false);
        assert.equal(unchanged.commit, next.commit);
        PollClient.log('PASS 8,001 file additions + complete registration manifest, >30,000 enumerated ignored entries and prior-large-tree no-change semantics');
    }

    async manifest(startCommit, endCommit) {
        const result = new Map();
        let cursor = null;
        do {
            const page = this.ok(await this.client.command('QA_FileTrackerReadManifest', {
                ...this.target, trackerId: this.lease.trackerId, startCommit, endCommit, cursor,
            }));
            for (const entry of page.entries) {
                assert.ok(!result.has(entry.path));
                result.set(entry.path, entry);
            }
            cursor = page.nextCursor;
            if (cursor) assert.ok(page.entries.length > 0);
            else assert.equal(result.size, page.totalCount);
        } while (cursor);
        return result;
    }

    assertStored(commit, member) {
        assert.equal(this.gitText(['rev-parse', `${commit}:${member.relative}`]), member.sha);
        assert.equal(this.gitText(['cat-file', '-s', member.sha]), String(member.size));
    }

    capture(description) {
        return this.client.command('QA_CommitFileTracker', { trackerId: this.lease.trackerId, bindingId: this.lease.bindingId,
            conversationId: '9007199254740993', statementId: null, description }, 240_000).then(result => this.ok(result));
    }
    file(args) { return this.client.command('QA_FileTrackerReadFile', args); }
    gitText(args) { return this.fixture.shadow(this.repo, args).toString('ascii').trim(); }
    ok(reply) { assert.equal(reply.success, true, reply.msg); return reply; }
    denied(reply) { assert.equal(reply.success, false); assert.ok(reply.msg); }
}

await new LargeCaptures().run();
// The isolated production poll server has no stop API; its fixtures are already closed and removed.
process.exit(0);
