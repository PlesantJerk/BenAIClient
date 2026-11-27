import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { FileTrackerCaptureFence } from '../../file-tracker-capture-fence.mts';
import { FileTrackerCaptureJobs } from '../../file-tracker-capture-jobs.mts';
import { Fixture } from './fixture.mjs';
import { PollClient as Poll } from './poll-client.mjs';

class CaptureJobsChecks {
    f = new Fixture();
    src = fileURLToPath(new URL('../../', import.meta.url));
    start = 'QA_StartFileTrackerCapture';
    status = 'QA_GetFileTrackerCaptureStatus';
    marker = 'SyntheticOpaqueProof_AB12';
    conversation = '9223372036854775807';
    bookmark = '9007199254740993';
    label = 'job-components';
    repo;
    client;
    lease;
    capture;

    async run() {
        try {
            fs.mkdirSync(this.f.outside, { recursive: true });
            this.f.write(this.f.primary, 'member.txt', 'Original 雪\r\n');
            Poll.install(this.src);
            this.client = new Poll(this.f.virtual, this.label);
            this.lease = await this.open();
            this.repo = path.join(this.f.primary, '.AIWork', 'tracking', 'jobs', 'repo.git');
            this.capture = this.arguments();
            await this.preflight();
            await this.workerSuccess();
            await this.workerError();
            await this.expiry();
            await this.generation();
            this.fenceOrder();
            assert.equal(Poll.unexpected, 0);
            assert.ok(!JSON.stringify(Poll.muted).includes(this.marker), 'private proof never appears in transport logs');
        } finally { this.f.remove(); }
    }

    async open() {
        const result = await this.client.command('QA_OpenFileTracker', {
            virtualRoot: this.f.virtual, projectPath: this.f.pathFor(this.f.primary), codeName: 'jobs',
        });
        assert.equal(result.success, true, result.msg);
        return result;
    }

    arguments() {
        return { version: 1, operationId: randomUUID(), trackerId: this.lease.trackerId, bindingId: this.lease.bindingId,
            conversationId: this.conversation, statementId: this.bookmark, description: 'Capture component 雪', reviewProof: this.marker };
    }

    scope(args) {
        const { version, operationId, trackerId, bindingId, conversationId } = args;
        return { version, operationId, trackerId, bindingId, conversationId };
    }

    command(command, payload, route = this.client, privateId = true) {
        const id = privateId ? 'filetracker-' + randomUUID().replaceAll('-', '') : String(++Poll.nextId);
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                Poll.pending.delete(id);
                reject(new Error(`No reply for ${command}`));
            }, 10_000);
            Poll.pending.set(id, result => { clearTimeout(timer); resolve(result); });
            route.requests.push({ command, id, ...payload });
            route.awake?.();
        });
    }

    pending(result, operationId) {
        assert.deepEqual(result, { msg: '', success: true, version: 1, status: 'pending', operationId });
    }

    unknown(result) {
        assert.equal(result.success, false);
        assert.equal(result.version, 1);
        assert.equal(result.status, 'unknown');
        assert.equal(Object.hasOwn(result, 'result'), false);
    }

    async terminal(args) {
        for (const start = Date.now(); Date.now() - start < 15_000;) {
            const result = await this.command(this.status, this.scope(args));
            if (result.status !== 'pending') return result;
            await delay(25);
        }
        assert.fail('Capture never returned a terminal receipt');
    }

    async preflight() {
        const args = this.capture;
        assert.equal(this.head(), '');
        this.unknown(await this.command(this.status, this.scope(args)));
        this.unknown(await this.command(this.start, { ...args, version: 2 }));
        this.unknown(await this.command(this.start, { ...args, operationId: '01234567-89AB-4DEF-8ABC-0123456789AB' }));
        this.unknown(await this.command(this.start, { ...args, conversationId: '092' }));
        this.unknown(await this.command(this.start, { ...args, reviewProof: 'not a proof!' }));
        this.unknown(await this.command(this.start, args, this.client, false));
        assert.equal(this.head(), '');
        Poll.log('PASS version, native-only correlation, safe metadata and unknown status');
    }

    async workerSuccess() {
        const args = this.capture;
        this.pending(await this.command(this.start, args), args.operationId);
        const queuedOpen = this.open();
        this.pending(await this.command(this.status, this.scope(args)), args.operationId);
        this.pending(await this.command(this.start, args), args.operationId);
        const complete = await this.terminal(args);
        assert.equal(complete.status, 'completed', complete.result?.msg);
        const receipt = complete.result;
        assert.equal(receipt.success, true);
        assert.equal(receipt.previousCommit, null);
        assert.equal(receipt.baseline, true);
        assert.deepEqual(receipt.counts, { added: 1, modified: 0, deleted: 0 });
        const metadata = this.f.shadow(this.repo, ['cat-file', 'commit', receipt.commit]).toString('utf8').split('\n\n')[1];
        assert.equal(metadata, `{"ConversationID":${this.conversation},"StatementID":${this.bookmark},"Description":"Capture component 雪","ReviewProof":"${this.marker}"}\n`);
        assert.equal(this.f.shadow(this.repo, ['cat-file', 'blob', `${receipt.commit}:member.txt`]).toString('utf8'), 'Original 雪\r\n');
        assert.deepEqual(await this.command(this.start, args), complete);
        for (const different of [{ description: 'changed' }, { statementId: null }, { reviewProof: 'changed' }, { conversationId: '12' },
            { bindingId: randomUUID() }, { trackerId: randomUUID() }]) {
            this.unknown(await this.command(this.start, { ...args, ...different }));
        }
        this.unknown(await this.command(this.status, { ...this.scope(args), conversationId: '12' }));
        await delay(5); // Server's legacy poll-session key uses Date.now.
        const foreign = new Poll(this.f.virtual, 'foreign-components');
        this.unknown(await this.command(this.status, this.scope(args), foreign));
        const reopened = await queuedOpen;
        this.unknown(await this.command(this.start, { ...args, bindingId: reopened.bindingId }));
        assert.equal(this.head(), `refs/heads/tracking ${receipt.commit}`);
        Poll.log('PASS once-only actual worker/Git, exact metadata and bytes, duplicate and mismatched scopes');
    }

    async workerError() {
        const args = this.arguments();
        const head = this.head();
        const file = path.join(path.dirname(this.repo), 'tracker.json');
        const saved = fs.readFileSync(file);
        const poisoned = { ...JSON.parse(saved.toString('utf8')), machine: 'different-route' };
        fs.writeFileSync(file, JSON.stringify(poisoned));
        try {
            this.pending(await this.command(this.start, args), args.operationId);
            const failure = await this.terminal(args);
            assert.equal(failure.success, true);
            assert.equal(failure.status, 'error');
            assert.equal(failure.result?.success, false);
            assert.match(failure.result.msg, /does not match this private store/);
            assert.equal(Object.hasOwn(failure.result, 'outcomeUnknown'), false);
            assert.deepEqual(await this.command(this.start, args), failure);
            assert.equal(this.head(), head);
        } finally { fs.writeFileSync(file, saved); }
        Poll.log('PASS worker rejects changed manifest at startup, exact held terminal error, no ref change');
    }

    async expiry() {
        assert.equal(FileTrackerCaptureJobs.retentionMs, 20 * 60 * 1000);
        FileTrackerCaptureJobs.retentionMs = 750;
        try {
            const args = this.arguments();
            const head = this.head();
            this.pending(await this.command(this.start, args), args.operationId);
            const complete = await this.terminal(args);
            assert.equal(complete.status, 'completed', complete.result?.msg);
            assert.equal(complete.result.changed, false);
            await delay(425);
            assert.deepEqual(await this.command(this.status, this.scope(args)), complete);
            await delay(425);
            assert.deepEqual(await this.command(this.status, this.scope(args)), complete, 'authorized status extended inactivity window');
            await delay(850);
            this.unknown(await this.command(this.status, this.scope(args)));
            this.unknown(await this.command(this.start, args));
            const reopened = await this.open();
            this.unknown(await this.command(this.start, { ...args, bindingId: reopened.bindingId }));
            const { version, operationId, ...legacyArgs } = args;
            const legacy = await this.client.command('QA_CommitFileTracker', legacyArgs);
            assert.deepEqual(legacy, complete.result, 'worker receipt is the exact legacy no-change receipt');
            assert.equal(this.head(), head);
        } finally { FileTrackerCaptureJobs.retentionMs = 20 * 60 * 1000; }
        Poll.log('PASS sliding expiry, no expired-UUID replay, and byte-equivalent legacy no-change receipt');
    }

    async generation() {
        const args = this.capture;
        this.client.server.root_dir = this.f.outside;
        this.client.server.root_dir = this.f.virtual;
        this.unknown(await this.command(this.status, this.scope(args)));
        this.unknown(await this.command(this.start, { ...args, operationId: randomUUID() }));
        this.lease = await this.open();
        const replacement = this.arguments();
        this.pending(await this.command(this.start, replacement), replacement.operationId);
        assert.equal((await this.terminal(replacement)).status, 'completed');
        const originalName = this.client.server.client_name;
        this.client.server.SetClientName('different-name');
        this.client.server.SetClientName(originalName);
        this.unknown(await this.command(this.status, this.scope(replacement)));
        Poll.log('PASS real root/name round-trip invalidates old job and lease without a status on the intermediate route');
    }

    fenceOrder() {
        const active = new FileTrackerCaptureFence();
        assert.ok(active.admitPublication());
        active.revoke();
        assert.ok(active.publicationAdmitted, 'a later route transition cannot undo an admitted atomic update');
        const retired = new FileTrackerCaptureFence();
        retired.revoke();
        assert.equal(retired.admitPublication(), false);
        assert.equal(retired.publicationAdmitted, false);
        Poll.log('PASS atomic update-ref ordering in both directions');
    }

    head() { return this.f.shadowRefs(this.repo); }
}

try { await new CaptureJobsChecks().run(); }
catch (error) { Poll.log('FAIL:', error); process.exitCode = 1; }
process.exit(process.exitCode ?? 0); // The offline Server owns a long-lived poll loop.
