import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export class Fixture {
    scratch = path.dirname(fileURLToPath(import.meta.url));
    gitExe = process.env.FILE_TRACKER_QA_GIT_EXE ?? path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'cmd', 'git.exe');
    run = fs.mkdtempSync(path.join(process.env.FILE_TRACKER_QA_TMP ?? os.tmpdir(), 'file-tracker-qa-'));
    virtual = path.join(this.run, 'virtual');
    original = path.join(this.run, 'ordinary');
    primary = path.join(this.virtual, 'workspace', 'sample project');
    alternate = path.join(this.virtual, 'alternate', 'sample project');
    outside = path.join(this.run, 'outside');
    config = path.join(this.run, 'empty.gitconfig');
    env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^git_/i.test(k)));
    baseline = new Map();
    changed = new Map();

    initialize() {
        Object.assign(this.env, {GIT_CONFIG_NOSYSTEM:'1', GIT_CONFIG_GLOBAL:this.config, GIT_TERMINAL_PROMPT:'0'});
        fs.writeFileSync(this.config, '');
        for (const p of [this.original, path.dirname(this.primary), this.alternate, this.outside]) fs.mkdirSync(p, {recursive:true});
        this.git(this.original, ['init','--initial-branch=fixture']);
        this.git(this.original, ['config','core.autocrlf','true']);
        this.seedOriginal();
        this.git(this.original, ['worktree','add','-b','tracked-project',this.primary]);
        this.seedWorking();
        this.seedExcluded();
        this.changed = new Map(this.baseline);
        this.write(this.alternate, 'other.txt', 'alternate tracker\n');
        this.write(this.outside, 'outside.txt', 'not in virtual root\n');
    }

    seedOriginal() {
        this.write(this.original, '.gitignore', '*.rootignore\r\nroot-hidden/*\r\n!root-hidden/keep.txt\r\nonly-dir/\r\n');
        this.write(this.original, '.gitattributes', '*.crlf text eol=lf\n');
        this.write(this.original, 'staged.txt', 'original staged target\n');
        this.write(this.original, 'editing.txt', 'original edit target\n');
        this.write(this.original, 'delete-me.txt', 'to be removed\n');
        this.git(this.original, ['add','.']);
        this.git(this.original, ['-c','user.name=Offline QA','-c','user.email=qa@example.invalid','commit','-m','Ordinary fixture seed']);
    }

    seedWorking() {
        this.write(this.primary, 'staged.txt', 'staged index bytes\n');
        this.git(this.primary, ['add','--','staged.txt']);
        this.capture('staged.txt','working bytes distinct from staged bytes\n');
        this.capture('editing.txt','preexisting unstaged bytes\n');
        this.capture('untracked.txt','preexisting untracked bytes\n');
        this.capture('later-nested/retained.txt','still present after the directory becomes a nested repository\n');
        this.capture('bytes.crlf',Buffer.from('\uFEFFfirst\r\nsecond\r\n','utf8'));
        this.capture('café 雪 🐾.txt','Unicode: café, 雪, 🐾\r\n');
        this.capture('binary.dat', Buffer.from([0,255,254,1,13,10,0,128,192,10,13,4]));
        this.capture('root-hidden/keep.txt','root negation restores this\r\n');
        this.capture('nested/.gitignore','drop/*\n!drop/keep.txt\n!override.rootignore\n');
        this.capture('nested/drop/keep.txt','nested negation restores this\n');
        this.capture('nested/override.rootignore','nested negation overrides root pattern\n');
        for (const name of ['.gitignore','.gitattributes','delete-me.txt']) this.baseline.set(name,fs.readFileSync(path.join(this.primary,name)));
    }

    seedExcluded() {
        for (const name of ['ignored.rootignore','root-hidden/drop.txt','nested/drop/drop.txt','only-dir/discard.txt','.AIWork/private.txt']) {
            this.write(this.primary,name,'excluded synthetic data\n');
        }
        const nested = path.join(this.primary,'nested-repo');
        fs.mkdirSync(nested);
        this.git(nested, ['init','--initial-branch=fixture']);
        this.write(nested, 'nested-source.txt', 'inside nested repository\n');
    }

    capture(name, contents, target = this.baseline) {
        const bytes = Buffer.from(contents);
        this.write(this.primary,name,bytes);
        target.set(name,bytes);
    }

    edits() {
        this.capture('editing.txt', 'second version via direct file write\r\n', this.changed);
        this.capture('binary.dat', Buffer.from([0,1,255,13,10,0,254,61,128]),this.changed);
        this.capture('bytes.crlf','changed first\r\nchanged second\r\n',this.changed);
        this.capture('new-direct.txt','new file via direct write\n',this.changed);
        this.write(this.primary,'after.rootignore','ignored newly written\n');
        fs.unlinkSync(path.join(this.primary,'delete-me.txt'));
        this.changed.delete('delete-me.txt');
    }

    git(cwd, args, opts = {}) {
        return this.exec(this.gitExe,['--no-pager',...args],cwd,opts);
    }

    exec(file, args, cwd, opts = {}) {
        const result = spawnSync(file,args,{cwd,env:this.env,timeout:30_000,maxBuffer:16*1024*1024,windowsHide:true,...opts});
        const accepted = opts.accepted ?? [0];
        assert.ok(accepted.includes(result.status), `${path.basename(file)} ${args.find(a => !a.startsWith('-'))} failed (exit ${result.status}, ${result.error?.code ?? 'no spawn error'})`);
        return result.stdout;
    }

    gitText(cwd,args) {
        return this.git(cwd,args).toString('utf8').trimEnd();
    }

    shadow(repo,args) {
        assert.ok(path.relative(this.virtual,repo) && !path.relative(this.virtual,repo).startsWith('..'),'shadow Git stays inside disposable virtual root');
        return this.git(this.virtual,[`--git-dir=${repo}`,...args]);
    }

    shadowRefs(repo) {
        return this.shadow(repo,['for-each-ref','--format=%(refname) %(objectname)']).toString('utf8').trimEnd();
    }

    shadowContents(repo,sha,expected) {
        const actual = this.shadow(repo,['ls-tree','-rz','--name-only',sha]).toString('utf8').split('\0').filter(Boolean).sort();
        assert.deepEqual(actual,[...expected.keys()].sort(),'tracked paths must exactly match expected inclusion set');
        for (const [name,bytes] of expected) {
            const blob = this.shadow(repo,['cat-file','blob',`${sha}:${name}`]);
            assert.ok(blob.equals(bytes),`exact blob bytes differ: ${name}`);
        }
    }

    realState() {
        const p = this.primary;
        const files = [path.join(p,'.git'),path.join(p,'.gitignore'),path.join(p,'nested','.gitignore'),path.join(p,'.gitattributes')];
        for (const name of ['index','HEAD','config','info/exclude','packed-refs']) {
            files.push(this.gitText(p,['rev-parse','--path-format=absolute','--git-path',name]));
        }
        return {top:this.gitText(p,['rev-parse','--show-toplevel']),head:this.gitText(p,['rev-parse','HEAD']),
            refs:this.gitText(p,['for-each-ref','--format=%(refname) %(objectname)']),
            bytes:Object.fromEntries(files.map(p => [p,fs.existsSync(p) ? fs.readFileSync(p).toString('hex') : null]))};
    }

    write(dir, name, bytes) {
        const full=path.join(dir,name);
        fs.mkdirSync(path.dirname(full),{recursive:true});
        fs.writeFileSync(full,bytes);
    }

    pathFor(dir) { return path.relative(this.virtual,dir).replaceAll('\\','/'); }

    metadata(repo,sha) {
        const raw = this.shadow(repo,['cat-file','commit',sha]).toString('utf8');
        const sep = raw.indexOf('\n\n');
        assert.ok(sep >= 0, 'commit contains message');
        const message = raw.slice(sep+2).trimEnd();
        const data = JSON.parse(message, (key,value,context) => ['ConversationID','StatementID'].includes(key) && typeof value === 'number' ? BigInt(context.source) : value);
        assert.deepEqual(Object.keys(data).sort(),['ConversationID','Description','StatementID']);
        return data;
    }

    remove() { fs.rmSync(this.run,{recursive:true,force:true,maxRetries:3,retryDelay:150}); }
}
