import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Fixture } from './fixture.mjs';
import { PollClient } from './poll-client.mjs';

async function check(f) {
    f.initialize();
    const p = f.primary;
    // Use an intermediate name so the stored spelling changes even on case-insensitive Windows.
    fs.renameSync(path.join(p, '.AIWork'), path.join(p, 'before-case-test'));
    fs.renameSync(path.join(p, 'before-case-test'), path.join(p, '.aiwork'));
    const kept = '.aiwork/private.txt';
    const bytes = fs.readFileSync(path.join(p, kept));
    f.git(p, ['add', '-f', '--', kept]);
    assert.equal(f.gitText(p, ['ls-files', '--', kept]), kept);
    fs.appendFileSync(path.join(p, '.gitignore'), '\n/.aiwork/\n');
    f.baseline.set('.gitignore', fs.readFileSync(path.join(p, '.gitignore')));
    const ordinary = f.realState();

    const client = new PollClient(f.virtual, 'case');
    const target = { virtualRoot: f.virtual, projectPath: f.pathFor(p), codeName: 'quoreai' };
    const ok = response => { assert.equal(response.success, true, response.msg); return response; };
    const open = async () => ok(await client.command('QA_OpenFileTracker', target));
    const capture = async opened => ok(await client.command('QA_CommitFileTracker', {
        trackerId: opened.trackerId, bindingId: opened.bindingId,
        conversationId: '17', statementId: '42', description: 'case test'
    }));
    // Prior interrupted opens can leave the name occupied without a tracker manifest.
    const partialName = 'quoreai-incomplete';
    const partial = path.join(p, '.aiwork', 'tracking', partialName);
    fs.mkdirSync(path.join(partial, 'repo.git'), { recursive: true });
    const openPartial = () => client.command('QA_OpenFileTracker', { ...target, codeName: partialName });
    const missing = await openPartial();
    assert.equal(missing.success, false);
    assert.match(missing.msg, /'quoreai-incomplete' already exists, but tracker\.json is missing/);
    assert.match(missing.msg, /different tracker name/);
    assert.equal(missing.trackerId, undefined);
    assert.deepEqual(fs.readdirSync(partial), ['repo.git']);
    assert.deepEqual(fs.readdirSync(path.join(partial, 'repo.git')), []);
    fs.writeFileSync(path.join(partial, 'TRACKER.JSON'), 'preserve me');
    const wrongCase = await openPartial();
    assert.equal(wrongCase.success, false);
    assert.match(wrongCase.msg, /different capitalization/);
    assert.doesNotMatch(wrongCase.msg, /is missing/);
    assert.equal(fs.readFileSync(path.join(partial, 'TRACKER.JSON'), 'utf8'), 'preserve me');
    const first = await open();
    assert.equal(first.created, true);
    assert.deepEqual(first.warnings, [], 'the project rule covers the existing .aiwork');
    assert.deepEqual(fs.readdirSync(p).filter(n => n.toLowerCase() === '.aiwork'), ['.aiwork']);
    const repo = path.join(p, '.aiwork', 'tracking', target.codeName, 'repo.git');
    const base = await capture(first);
    assert.equal(base.baseline, true);
    f.shadowContents(repo, base.commit, f.baseline); // includes neither tracker internals nor private.txt

    const reopened = await open();
    assert.equal(reopened.created, false);
    assert.equal(reopened.trackerId, first.trackerId);
    f.write(p, 'editing.txt', 'after reopening\n');
    const edited = await capture(reopened);
    const pair = { ...target, trackerId: first.trackerId, startCommit: base.commit, endCommit: edited.commit };
    const manifest = ok(await client.command('QA_FileTrackerReadManifest', { ...pair, cursor: null }));
    assert.deepEqual(manifest.counts, { added: 0, modified: 1, deleted: 0 });
    assert.equal(manifest.entries[0].path, 'editing.txt');
    const file = ok(await client.command('QA_FileTrackerReadFile', { ...pair, ...manifest.entries[0] }));
    assert.deepEqual(Buffer.from(file.original.base64, 'base64'), f.baseline.get('editing.txt'));
    assert.equal(Buffer.from(file.final.base64, 'base64').toString(), 'after reopening\n');
    assert.equal((await capture(reopened)).changed, false);
    assert.deepEqual(fs.readFileSync(path.join(p, kept)), bytes);
    assert.deepEqual(f.realState(), ordinary, 'ordinary Git index, refs or configuration changed');

    const other = { ...target, projectPath: f.pathFor(f.alternate) };
    const work = path.join(f.alternate, '.aIwOrK');
    fs.symlinkSync(f.outside, work, 'junction');
    assert.equal((await client.command('QA_OpenFileTracker', other)).success, false);
    assert.deepEqual(fs.readdirSync(f.outside), ['outside.txt']);
    fs.unlinkSync(work);
    fs.mkdirSync(path.join(work, 'TRACKING'), { recursive: true });
    assert.equal((await client.command('QA_OpenFileTracker', other)).success, false, 'only the outer name may vary');
    fs.rmdirSync(path.join(work, 'TRACKING'));
    assert.equal(ok(await client.command('QA_OpenFileTracker', other)).created, true);
    assert.deepEqual(fs.readdirSync(f.alternate).filter(n => n.toLowerCase() === '.aiwork'), ['.aIwOrK']);
    assert.equal(PollClient.unexpected, 0);
}

const fixture = new Fixture();
try {
    PollClient.install(process.env.FILE_TRACKER_QA_CLIENT ?? path.resolve(fileURLToPath(new URL('../../', import.meta.url))));
    await check(fixture);
    PollClient.log('PASS: work-area casing, baseline/reopen/edit/review, real Git preservation, junction and strict inner names');
} catch (error) { PollClient.log('FAIL', error); process.exitCode = 1; }
finally { fixture.remove(); }
process.exit(process.exitCode ?? 0);
