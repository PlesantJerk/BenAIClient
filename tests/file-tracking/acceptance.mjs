import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {Fixture} from './fixture.mjs';
import {PollClient as Poll} from './poll-client.mjs';

class Acceptance {
    fixture = new Fixture();
    clientPath = this.findClient();
    openCommand = 'QA_OpenFileTracker';
    commitCommand = 'QA_CommitFileTracker';
    a = 'alpha';
    b = 'beta';
    shellId;
    shellRuns = 0;
    client;
    trackerA;
    trackerB;
    shaA;
    shaB;
    real;
    rows = [];
    metadata = {conversationId:'9223372036854775807',statementId:'9007199254740993',description:'QA Ω 🐾 "quotes" \\ newline\nsynthetic description'};

    findClient() {
        if (process.env.FILE_TRACKER_QA_CLIENT) return path.resolve(process.env.FILE_TRACKER_QA_CLIENT);
        const candidates = ['../client-src','../..'].map(p=>path.resolve(this.fixture.scratch,p));
        return candidates.find(p=>fs.existsSync(path.join(p,'server.js'))) ?? candidates[0];
    }

    async run() {
        try {
            await this.hard('setup: linked worktree with staged + unstaged + untracked; real native shell route',() => this.setup());
            if (process.argv.includes('--preflight')) return;
            await this.hard('open two trackers: correct private bare repos and no implicit ref/commit',() => this.openBoth());
            await this.hard('first explicit baseline: current bytes, exact included paths, exclusion rules and metadata',() => this.baseline());
            await this.hard('shell/direct edits: exact Git blob bytes, tree and changed-file receipt',() => this.mutations());
            await this.test('reattach same tracker and no-change yields no new commit',() => this.reopen());
            await this.test('negative opens: missing, invalid, traversal, qualified path/side-effect checks',() => this.negativeOpen());
            await this.test('negative commits: invalid IDs, invalid request/root, unopened native route',() => this.negativeCommit());
            await this.test('mismatched existing manifest rejected both on open and current binding',() => this.invalidManifest());
            await this.test('inherited Git environment ignored and ordinary hooks do not affect capture',() => this.environment());
            await this.test('same-tracker concurrency across two native client contexts',() => this.concurrent());
            await this.test('oversize file rejected without publishing a private ref',() => this.fileCap());
            await this.test('new nested repo cannot silently report present tracked descendants deleted',() => this.newNested());
        } catch (error) {
            this.log({status:'blocked',reason:'A prerequisite group failed; dependent groups not run.'});
        } finally {
            if (this.real) await this.test('unchanged ordinary linked Git HEAD, refs, index, config and ignores; stock git still works',() => this.verifyOrdinary());
            if (this.client) await this.test('offline dispatch: no unmatched networking and no synthetic project contents in logs',() => this.noNetwork());
            if (this.sources && !process.argv.includes('--preflight')) await this.test('released Node source fingerprints unchanged throughout the run',() => assert.deepEqual(this.fingerprint(),this.sources));
            if (this.shellId) await this.test('owned native shell terminated',async () => this.ok(await this.client.command('terminate_shell_session',{session_id:this.shellId}),'terminate shell'));
            await this.test('disposable fixture cleanup',() => this.fixture.remove());
            const counts = {pass:0,fail:0,skip:0};
            for (const r of this.rows) counts[r.status]++;
            this.log({type:'summary',...counts});
            process.exit(counts.fail ? 1 : 0);
        }
    }

    async setup() {
        const f = this.fixture;
        f.initialize();
        assert.ok(fs.lstatSync(path.join(f.primary,'.git')).isFile(),'expected linked-worktree admin pointer file');
        const status = f.gitText(f.primary,['--no-optional-locks','status','--porcelain=v1']);
        assert.match(status,/^MM staged\.txt$/m,'fixture must have distinct staged and unstaged changes to same tracked path');
        assert.match(status,/^ M editing\.txt$/m,'fixture must have preexisting unstaged changes');
        assert.match(status,/^\?\? untracked\.txt$/m,'fixture must have preexisting untracked content');
        const excluded = f.git(f.primary,['check-ignore','--no-index','--stdin','-z'],{input:Buffer.from('ignored.rootignore\0root-hidden/drop.txt\0nested/drop/drop.txt\0root-hidden/keep.txt\0nested/drop/keep.txt\0nested/override.rootignore\0only-dir/discard.txt\0')}).toString('utf8').split('\0').filter(Boolean).sort();
        assert.deepEqual(excluded,['ignored.rootignore','nested/drop/drop.txt','only-dir/discard.txt','root-hidden/drop.txt'],'independent real Git ignore/negation oracle');
        this.installOrdinaryHook();
        for (const key of Object.keys(process.env)) if (/^git_/i.test(key)) delete process.env[key];
        Object.assign(process.env,{GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:f.config,GIT_OPTIONAL_LOCKS:'0'});
        process.env.Path = `${path.dirname(f.gitExe)};${process.env.Path ?? process.env.PATH ?? ''}`;
        this.real = f.realState();
        this.reportProvenance();
        Poll.install(this.clientPath);
        this.client = new Poll(f.virtual,'primary');
        const probe = await this.client.command('get_virtual_directory_location',{},10_000);
        assert.equal(probe.virtual_directory,f.virtual,'actual native route current virtual root');
        this.shellId = await this.client.openShell();
        await this.shellEvidence();
    }

    installOrdinaryHook() {
        const f = this.fixture;
        const hooks = path.join(f.run,'hooks');
        f.write(hooks,'reference-transaction','#!/bin/sh\nexit 93\n');
        const hookPath = hooks.replaceAll('\\','/');
        f.git(f.primary,['config','core.hooksPath',hookPath]);
        f.git(f.primary,['hook','run','reference-transaction','--','prepared'],{accepted:[93]});
        this.hookPath = hookPath;
    }

    async shellEvidence() {
        const sentinel = `QA_GIT_COMPLETE_${++this.shellRuns}`;
        const cmd = `cd /d "${this.fixture.primary}" && git --no-pager rev-parse HEAD && git --no-pager --no-optional-locks status --porcelain=v1 --untracked-files=no && echo ${sentinel}`;
        const stdout = await this.client.shell(this.shellId,cmd,sentinel);
        assert.ok(stdout.split(/\r?\n/).includes(this.real.head),'ordinary git via actual native shell returns the original linked worktree HEAD');
        assert.match(stdout,/^MM staged\.txt\r?$/m,'native shell ordinary Git sees real staging');
        assert.ok(stdout.split(/\r?\n/).includes(sentinel),'native shell Git chain finished');
    }

    reportProvenance() {
        this.sources=this.fingerprint();
        const git = this.fixture.gitText(this.fixture.scratch,['--version']);
        this.log({type:'environment',node:process.version,git,sources:this.sources});
    }

    fingerprint() {
        const sources = fs.readdirSync(this.clientPath).filter(n => n==='server.js'||/^file-track.*\.mts$/.test(n)).sort();
        return Object.fromEntries(sources.map(n => [n,createHash('sha256').update(fs.readFileSync(path.join(this.clientPath,n))).digest('hex')]));
    }

    async openBoth() {
        const f = this.fixture;
        this.trackerA = this.ok(await this.open(f.primary,this.a),'open primary tracker');
        this.trackerB = this.ok(await this.open(f.alternate,this.b),'open alternate tracker');
        this.openShape(this.trackerA,f.primary,this.a);
        this.openShape(this.trackerB,f.alternate,this.b);
        assert.notEqual(this.trackerA.trackerId,this.trackerB.trackerId,'different trackers must not share binding');
        for (const [root,code] of [[f.primary,this.a],[f.alternate,this.b]]) {
            const repo = this.repo(root,code);
            assert.ok(fs.existsSync(this.manifest(root,code)),'open created manifest');
            assert.equal(f.shadow(repo,['rev-parse','--is-bare-repository']).toString('utf8').trim(),'true','private repo is actually bare');
            assert.equal(f.shadowRefs(repo),'','open must not create a ref or a commit');
            assert.equal(fs.readdirSync(path.join(repo,'objects')).filter(n => n!=='info' && n!=='pack').length,0,'open wrote no loose objects');
        }
        assert.deepEqual(f.realState(),this.real,'open left ordinary Git and project ignore unchanged');
    }

    openShape(receipt, root, code) {
        assert.equal(typeof receipt.trackerId,'string');
        assert.ok(receipt.trackerId.length>0);
        assert.equal(typeof receipt.bindingId,'string');
        assert.ok(receipt.bindingId.length>0,'native open returned ephemeral client lease');
        assert.equal(receipt.codeName,code);
        assert.equal(receipt.projectPath,this.fixture.pathFor(root));
        assert.ok(Array.isArray(receipt.warnings));
    }

    async baseline() {
        const f = this.fixture;
        f.capture('after-open.txt','added after open, before explicit baseline\r\n');
        f.changed.set('after-open.txt',f.baseline.get('after-open.txt'));
        const a = this.ok(await this.commit(this.trackerA),'baseline primary');
        this.shaA = this.newCommit(a,null);
        this.assertBaselineReceipt(a, f.baseline);
        const aRepo = this.repo(f.primary,this.a);
        f.shadowContents(aRepo,this.shaA,f.baseline);
        assert.deepEqual(f.metadata(aRepo,this.shaA), this.expectedMeta());
        const b = this.ok(await this.commit(this.trackerB,{statementId:null}),'baseline alternate');
        this.shaB = this.newCommit(b,null);
        const bRepo = this.repo(f.alternate,this.b);
        const bFiles = new Map([['other.txt',fs.readFileSync(path.join(f.alternate,'other.txt'))]]);
        f.shadowContents(bRepo,this.shaB,bFiles);
        this.assertBaselineReceipt(b,bFiles);
        assert.deepEqual(f.metadata(bRepo,this.shaB),this.expectedMeta({statementId:null}));
        assert.notEqual(this.shaA,this.shaB);
        assert.deepEqual(f.realState(),this.real,'baseline left ordinary Git and project ignore unchanged');
    }

    assertBaselineReceipt(receipt, files) {
        assert.equal(receipt.baseline,true,'first snapshot marked baseline');
        assert.equal(receipt.truncated,false);
        const paths=receipt.added.map(x=>x.path).sort();
        const missing=[...files.keys()].filter(p=>!paths.includes(p)), unexpected=paths.filter(p=>!files.has(p));
        assert.equal(missing.length+unexpected.length,0,`synthetic baseline paths: missing=${JSON.stringify(missing)}, unexpected=${JSON.stringify(unexpected)}`);
        assert.deepEqual(receipt.counts,{added:files.size,modified:0,deleted:0});
    }

    async mutations() {
        const f = this.fixture;
        const shellOutput = await this.client.shell(this.shellId,'echo(shell edit via native console>shell-made.txt');
        assert.ok(shellOutput,'native shell returned');
        const bytes = fs.readFileSync(path.join(f.primary,'shell-made.txt'));
        assert.equal(bytes.toString('utf8'),'shell edit via native console\r\n','CMD produced expected CRLF bytes');
        f.changed.set('shell-made.txt',bytes);
        f.edits();
        const previous = this.shaA;
        const m = {description:'Second synthetic snapshot'};
        const changed = this.ok(await this.commit(this.trackerA,m),'second primary commit');
        this.shaA = this.newCommit(changed,previous);
        assert.equal(changed.baseline,false);
        assert.equal(changed.truncated,false);
        assert.deepEqual(changed.counts,{added:2,modified:3,deleted:1});
        const repo = this.repo(f.primary,this.a);
        this.compareChanges(changed,repo);
        assert.deepEqual(f.metadata(repo,this.shaA),this.expectedMeta(m));
        f.shadowContents(repo,this.shaA,f.changed);
        assert.equal(f.shadowRefs(this.repo(f.alternate,this.b)),`refs/heads/tracking ${this.shaB}`,'second tracker ref unchanged');
        assert.deepEqual(f.realState(),this.real,'incremental capture left ordinary Git and project ignore unchanged');
    }

    compareChanges(r, repo) {
        this.checkPaths(r,'added',['new-direct.txt','shell-made.txt'],repo);
        this.checkPaths(r,'modified',['binary.dat','bytes.crlf','editing.txt'],repo);
        this.checkPaths(r,'deleted',['delete-me.txt'],repo);
    }

    checkPaths(r,kind,paths,repo) {
        assert.deepEqual(r[kind].map(x=>x.path).sort(),paths,`exact ${kind} path list`);
        for (const change of r[kind]) {
            const read = rev => this.fixture.shadow(repo,['rev-parse',`${rev}:${change.path}`]).toString('utf8').trim();
            assert.equal(change.oldSha,kind==='added'?null:read(r.previousCommit),`receipt old blob ${change.path}`);
            assert.equal(change.newSha,kind==='deleted'?null:read(r.commit),`receipt new blob ${change.path}`);
        }
    }

    async reopen() {
        const f = this.fixture, repo = this.repo(f.primary,this.a);
        const oldRefs = f.shadowRefs(repo);
        const reattached = this.ok(await this.open(f.primary,this.a),'reopen same tracker');
        this.openShape(reattached,f.primary,this.a);
        assert.equal(reattached.trackerId,this.trackerA.trackerId,'same context reopened same tracker ID');
        const noop = this.ok(await this.commit(reattached,{description:'No-change receipt test'}),'no-change capture');
        this.assertNoop(noop,this.shaA);
        assert.notEqual(reattached.bindingId,this.trackerA.bindingId,'opening a new lease yields a different binding');
        this.assertNoop(this.ok(await this.commit(this.trackerA),'independent old lease remains valid'),this.shaA);
        assert.equal(f.shadowRefs(repo),oldRefs);
        assert.equal(f.shadow(repo,['rev-list','--count','refs/heads/tracking']).toString('utf8').trim(),'2');
        assert.equal(f.metadata(repo,this.shaA).Description,'Second synthetic snapshot','no-change did not overwrite prior metadata');
    }

    assertNoop(r,sha) {
        assert.equal(r.changed,false);
        assert.equal(r.commit,sha);
        assert.equal(r.previousCommit,sha);
        assert.deepEqual(r.counts,{added:0,modified:0,deleted:0});
        assert.deepEqual([r.added,r.modified,r.deleted],[[],[],[]]);
    }

    async negativeOpen() {
        const f = this.fixture;
        const denied = [
            [{codeName:'neg-missing'},'missing path'],
            [{projectPath:'workspace/does-not-exist',codeName:'neg-missing'},'nonexistent path'],
            [{projectPath:`${f.pathFor(f.primary)}/editing.txt`,codeName:'neg-file'},'project path is a file'],
            [{projectPath:'sample project',codeName:'neg-ambiguous'},'bare path with two matching directory names'],
            [{projectPath:'../outside',codeName:'neg-parent'},'parent traversal'],
            [{projectPath:'workspace/../alternate/sample project',codeName:'neg-inner'},'interior traversal'],
            [{projectPath:f.outside,codeName:'neg-absolute'},'absolute outside path'],
            [{projectPath:f.pathFor(f.primary),codeName:'../invalid'},'invalid code name'],
            [{projectPath:f.pathFor(f.primary),codeName:''},'missing code name']
        ];
        for (const [payload,label] of denied) this.denied(await this.openWire(payload),label);
        this.denied(await this.openWire({virtualRoot:f.outside,projectPath:f.pathFor(f.primary),codeName:'neg-root'}),'unexpected virtualRoot');
        this.denied(await this.openWire({virtualRoot:undefined,projectPath:f.pathFor(f.primary),codeName:'neg-root'}),'omitted virtualRoot');
        assert.ok(!fs.existsSync(path.join(f.outside,'.AIWork')),'rejected paths caused no outside tracker writes');
        assert.deepEqual(fs.readdirSync(path.join(f.primary,'.AIWork','tracking')),[this.a],'invalid requests created no extra primary tracker state');
    }

    async negativeCommit() {
        const f = this.fixture, before = f.shadowRefs(this.repo(f.primary,this.a));
        for (const [over,label] of [[{conversationId:'0'},'zero conversation ID'],[{conversationId:'9223372036854775808'},'ID beyond Int64'],[{statementId:'-1'},'negative statement ID'],[{description:123},'nontext desc'],[{trackerId:''},'missing binding'],[{trackerId:'00000000-0000-4000-8000-000000000000'},'unknown binding']]) {
            this.denied(await this.commit(this.trackerA,over),label);
        }
        this.denied(await this.commit(this.trackerA,{bindingId:this.trackerB.bindingId}),'mismatched tracker and binding pair');
        const fresh = new Poll(f.virtual,'primary');
        this.denied(await this.commit(this.trackerA,{},fresh),'same actor and virtual root but another unopened client Server');
        const reattached=this.ok(await this.open(f.primary,this.a,fresh),'same actor opens in a fresh native session');
        assert.equal(reattached.trackerId,this.trackerA.trackerId,'persisted identity survives independently held sessions');
        this.denied(await this.commit(this.trackerA,{},fresh),'old namespace binding still denied after fresh reattach');
        this.client.server.root_dir = f.outside;
        try { this.denied(await this.commit(this.trackerA),'stale active virtual root'); }
        finally { this.client.server.root_dir = f.virtual; }
        assert.equal(f.shadowRefs(this.repo(f.primary,this.a)),before,'rejected commits did not change private tracker ref');
    }

    async invalidManifest() {
        const f = this.fixture, manifest = this.manifest(f.primary,this.a);
        const selected=this.ok(await this.open(f.primary,this.a),'renew binding before manifest test');
        const original = fs.readFileSync(manifest);
        const invalid = JSON.parse(original);
        const key = Object.keys(invalid).find(k=>/^code_?name$/i.test(k));
        assert.ok(key,'manifest has a codeName identity field to mismatch');
        invalid[key] = 'different';
        const before = f.shadowRefs(this.repo(f.primary,this.a));
        fs.writeFileSync(manifest,JSON.stringify(invalid));
        try {
            this.denied(await this.open(f.primary,this.a),'same tracker folder with different manifest name');
            this.denied(await this.commit(selected),'pinned tracker whose manifest no longer matches');
        } finally { fs.writeFileSync(manifest,original); }
        assert.equal(f.shadowRefs(this.repo(f.primary,this.a)),before);
    }

    async environment() {
        const f = this.fixture, baitIndex=path.join(f.run,'foreign-index');
        const selected=this.ok(await this.open(f.alternate,this.b),'renew alternate binding before Git environment test');
        const canary = Buffer.from('synthetic caller index sentinel');
        fs.writeFileSync(baitIndex,canary);
        const hostile = {GIT_DIR:path.join(f.run,'nonexistent-repo'),GIT_WORK_TREE:f.alternate,GIT_INDEX_FILE:baitIndex,GIT_CONFIG_COUNT:'1',GIT_CONFIG_KEY_0:'core.hooksPath',GIT_CONFIG_VALUE_0:this.hookPath};
        const prior = Object.fromEntries(Object.keys(hostile).map(k=>[k,process.env[k]]));
        const receipt = await (async () => {
            Object.assign(process.env,hostile);
            f.write(f.alternate,'env-check.txt','synthetic tracked result under mismatched env\n');
            try { return this.ok(await this.commit(selected,{description:'Environment isolation'}),'capture with inherited Git overrides'); }
            finally { for (const [k,v] of Object.entries(prior)) v===undefined?delete process.env[k]:process.env[k]=v; }
        })();
        this.shaB=this.newCommit(receipt,this.shaB);
        const repo = this.repo(f.alternate,this.b);
        const expected = new Map(['other.txt','env-check.txt'].map(n=>[n,fs.readFileSync(path.join(f.alternate,n))]));
        f.shadowContents(repo,this.shaB,expected);
        assert.ok(fs.readFileSync(baitIndex).equals(canary),'foreign alternate index preserved');
        assert.ok(!fs.existsSync(hostile.GIT_DIR),'bad inherited Git location not used nor created');
    }

    async concurrent() {
        const f = this.fixture, repo=this.repo(f.primary,this.a);
        // Root-change denial may intentionally invalidate all bindings, so explicitly reopen.
        const first = this.ok(await this.open(f.primary,this.a),'open first concurrency context');
        const peer = new Poll(f.virtual,'primary');
        const second = this.ok(await this.open(f.primary,this.a,peer),'open second concurrency context');
        f.write(f.primary,'concurrent.txt','one consistent new tree\n');
        f.changed.set('concurrent.txt',fs.readFileSync(path.join(f.primary,'concurrent.txt')));
        const results = await Promise.all([this.commit(first,{},this.client),this.commit(second,{},peer)]);
        const changed = results.filter(r=>r.success && r.changed);
        assert.equal(changed.length,1,'at most and at least one commit for simultaneous same-tree capture');
        this.shaA=this.newCommit(changed[0],this.shaA);
        const other = results.find(r=>r!==changed[0]);
        if (other.success) this.assertNoop(other,this.shaA);
        else assert.match(other.msg,/lock|busy|progress|concurren/i,'second operation must fail specifically for concurrent writer or return no-change');
        assert.equal(f.shadow(repo,['rev-list','--count','refs/heads/tracking']).toString('utf8').trim(),'3');
        f.shadowContents(repo,this.shaA,f.changed);
    }

    async fileCap() {
        const f=this.fixture, repo=this.repo(f.alternate,this.b);
        const tracker=this.ok(await this.open(f.alternate,this.b),'open cap fixture tracker');
        const before=f.shadowRefs(repo);
        const file=path.join(f.alternate,'file-too-large.bin');
        fs.closeSync(fs.openSync(file,'wx'));
        fs.truncateSync(file,16*1024*1024+1);
        try {
            const result=await this.commit(tracker);
            this.denied(result,'file cap');
            assert.match(result.msg,/exceed|limit|size|large|cap/i,'file-cap failure should identify the constraint');
            assert.equal(f.shadowRefs(repo),before,'file cap did not advance private tracker ref');
        } finally { fs.unlinkSync(file); }
    }

    async newNested() {
        const f=this.fixture, parent=path.join(f.primary,'later-nested'), repo=this.repo(f.primary,this.a);
        const tracker=this.ok(await this.open(f.primary,this.a),'reopen before nested boundary change');
        const before=f.shadowRefs(repo);
        f.git(parent,['init','--initial-branch=fixture']);
        try {
            this.denied(await this.commit(tracker),'new nested repo covering present tracked file');
            assert.equal(f.shadowRefs(repo),before,'nested boundary could not advance private tracker ref');
            assert.ok(fs.existsSync(path.join(parent,'retained.txt')),'tracked source still exists');
        } finally { fs.rmSync(path.join(parent,'.git'),{recursive:true,force:true}); }
    }

    async verifyOrdinary() {
        if (this.shellId) await this.shellEvidence();
        assert.deepEqual(this.fixture.realState(),this.real);
    }

    noNetwork() {
        assert.equal(Poll.unexpected,0,'unmatched parent Node socket/fetch attempts');
        const raw = Poll.muted.flat().filter(x=>typeof x==='string').join('\n');
        assert.ok(!raw.includes(this.metadata.description),'tracker raw description not emitted as a console string');
        assert.ok(!raw.includes('working bytes distinct from staged bytes'),'no file body in logs');
        const structured = Poll.muted.flat().filter(x=>x && typeof x==='object');
        assert.ok(!structured.some(x=>x.command===this.commitCommand && x.description===this.metadata.description),'no raw tracker request in logs');
    }

    open(root,codeName,client=this.client) {
        return this.openWire({projectPath:this.fixture.pathFor(root),codeName},client);
    }
    openWire(payload,client=this.client) {
        return client.command(this.openCommand,{virtualRoot:this.fixture.virtual,...payload});
    }
    async commit(tracker, fields={}, client=this.client) {
        const started = performance.now();
        const r = await client.command(this.commitCommand,{trackerId:tracker.trackerId,bindingId:tracker.bindingId,...this.metadata,...fields});
        if (r.success) this.log({type:'capture',changed:r.changed,baseline:r.baseline,counts:r.counts,truncated:r.truncated,elapsedMs:Math.round(performance.now()-started)});
        return r;
    }
    dir(root,code) { return path.join(root,'.AIWork','tracking',code); }
    repo(root,code) { return path.join(this.dir(root,code),'repo.git'); }
    manifest(root,code) { return path.join(this.dir(root,code),'tracker.json'); }

    expectedMeta(fields={}) {
        const p={...this.metadata,...fields};
        return {ConversationID:BigInt(p.conversationId),StatementID:p.statementId===null?null:BigInt(p.statementId),Description:p.description};
    }

    newCommit(r,previous) {
        assert.equal(r.changed,true);
        assert.equal(r.previousCommit,previous);
        assert.match(r.commit,/^[0-9a-f]{40}$/);
        assert.notEqual(r.commit,previous);
        return r.commit;
    }

    ok(receipt,label) {
        assert.equal(receipt.success,true,`${label}: ${String(receipt.msg??'no msg').replace(/[\r\n]+/g,' ').slice(0,280)}`);
        return receipt;
    }

    denied(receipt,label) {
        assert.equal(receipt.success,false,`${label}: native command unexpectedly accepted`);
        assert.equal(typeof receipt.msg,'string');
        assert.ok(receipt.msg.trim(),`${label}: returned a meaningful native error envelope`);
    }

    async hard(name,action) { if (!await this.test(name,action)) throw new Error('Blocked'); }

    async test(name,action) {
        try { await action(); this.record({status:'pass',group:name}); return true; }
        catch (error) {
            const detail=String(error.message).split(/\r?\n/).find(s=>s.trim())?.slice(0,350);
            const at=String(error.stack).split(/\r?\n/).find(s=>s.includes('acceptance.mjs:')||s.includes('fixture.mjs:'))?.trim();
            this.record({status:'fail',group:name,detail,at});
            return false;
        }
    }

    record(row) { this.rows.push(row); this.log(row); }
    log(row) { Poll.log(JSON.stringify(row)); }
}

await new Acceptance().run();
