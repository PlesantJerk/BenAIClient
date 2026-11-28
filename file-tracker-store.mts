import { randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { FileTrackerError, FileTrackerLocation, type TrackerDirectory, type TrackerLocation } from './file-tracker-location.mts';
import { FileTrackerGit } from './file-tracker-git.mts';
import { FileTrackerSource } from './file-tracker-files.mts';
import { FileTrackerScope, type TrackerInclude } from './file-tracker-scope.mts';

type TrackerManifestBase = Readonly<{
    trackerId: string; codeName: string; root: string; virtualRoot: string;
    projectPath: string; machine: string; projectIdentity: string; virtualRootIdentity: string;
    workIdentity: string; trackingIdentity: string; storeIdentity: string; repoIdentity: string;
}>;

export type TrackerManifest = TrackerManifestBase & (Readonly<{ version: 1 }> | Readonly<{
    version: 2; includeDirectories: readonly string[]; includeDirectoryIdentities: readonly (readonly string[])[];
}>);

export type TrackerManifestIdentity = Readonly<{ repoPath: string; manifest: TrackerManifest; manifestFile: string; includes?: readonly TrackerInclude[] }>;

type StoreDirectories = Readonly<{
    work: TrackerDirectory; tracking: TrackerDirectory; store: TrackerDirectory; repo: TrackerDirectory;
}>;

export type OpenedTrackerStore = TrackerManifestIdentity & Readonly<{ configFile: string; created: boolean }>;

export class FileTrackerStore {
    static readonly #branch = 'tracking';
    static readonly #sha = /^[a-f0-9]{40}\n$/;
    static readonly uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

    private readonly git: FileTrackerGit;

    constructor(git: FileTrackerGit) { this.git = git; }

    async open(location: TrackerLocation, codeName: string, machine: string, verifyRoute: () => void, requested?: readonly TrackerInclude[]): Promise<OpenedTrackerStore> {
        await this.git.checkAvailable(location.project.path); // No private directories exist on our behalf until Git passes preflight.
        return new FileTrackerSource(location.project.path).withPinnedDirectory(() => this.openPinned(location, codeName, machine, verifyRoute, requested));
    }

    private async openPinned(location: TrackerLocation, codeName: string, machine: string, verifyRoute: () => void, requested?: readonly TrackerInclude[]): Promise<OpenedTrackerStore> {
        verifyRoute();
        const workName = FileTrackerLocation.workAreaName(location.project.path);
        const work = FileTrackerLocation.privateChild(location.project.path, workName, false);
        const tracking = work && FileTrackerLocation.privateChild(work.path, 'tracking', false);
        const existing = tracking && FileTrackerLocation.privateChild(tracking.path, codeName, false);
        if (existing) {
            const manifestName = FileTrackerLocation.matchingName(existing.path, 'tracker.json');
            if (manifestName !== 'tracker.json') {
                const reason = manifestName === undefined ? 'tracker.json is missing' : 'tracker.json has different capitalization';
                throw new FileTrackerError(`Tracker folder '${codeName}' already exists, but ${reason}. It was left unchanged. Use a different tracker name or inspect the existing folder.`);
            }
            const opened = this.attach(location, codeName, machine);
            if (requested && (!opened.includes || !FileTrackerScope.same(requested, opened.includes))) {
                throw new FileTrackerError('The requested scope does not match this tracker. Use a different tracker name for a different scope.');
            }
            FileTrackerLocation.assertNotNested(location, machine, this, opened.manifest.version === 2 ? opened.manifest.includeDirectories : undefined);
            return opened;
        }
        const create = () => this.create(location, workName, codeName, machine, verifyRoute, requested);
        return requested ? FileTrackerScope.withPinnedRoots(location.project.path, requested, create) : create();
    }

    private async create(location: TrackerLocation, workName: string, codeName: string, machine: string,
        verifyRoute: () => void, includes?: readonly TrackerInclude[]): Promise<OpenedTrackerStore> {
        verifyRoute();
        FileTrackerLocation.assertNotNested(location, machine, this, includes?.map(entry => entry.path));
        const work = FileTrackerLocation.privateChild(location.project.path, workName, true)!;
        const tracking = FileTrackerLocation.privateChild(work.path, 'tracking', true)!;
        const path = join(tracking.path, codeName);
        mkdirSync(path, { mode: 0o700 });
        const store = FileTrackerLocation.privateChild(tracking.path, codeName, false)!;
        mkdirSync(join(store.path, 'repo.git'), { mode: 0o700 });
        const repo = FileTrackerLocation.privateChild(store.path, 'repo.git', false)!;
        const dirs = { work, tracking, store, repo };
        const expected = this.manifest(location, dirs, codeName, machine, randomUUID(), includes);
        verifyRoute();
        this.assertSameDirectories(location, expected);
        return new FileTrackerSource(repo.path).withPinnedDirectory(async () => {
            this.assertNames(repo.path, []);
            await this.git.run(repo.path, ['init', '--bare', '--template=', '--object-format=sha1', `--initial-branch=${FileTrackerStore.#branch}`]);
            verifyRoute();
            this.assertSameDirectories(location, expected);
            this.validateBare(repo.path, true);
            writeFileSync(join(store.path, 'tracker.json'), `${JSON.stringify(expected, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
            return { ...this.attach(location, codeName, machine), created: true };
        });
    }

    protectCapture<T>(repoPath: string, action: () => Promise<T>): Promise<T> {
        const store = new FileTrackerSource(dirname(repoPath));
        const repo = new FileTrackerSource(repoPath);
        const refs = new FileTrackerSource(join(repoPath, 'refs', 'heads'));
        const objects = new FileTrackerSource(join(repoPath, 'objects'));
        return store.withPinnedFile('tracker.json', () => repo.withPinnedFile('config', () =>
            refs.withPinnedDirectory(() => objects.withPinnedDirectory(action))));
    }

    attach(location: TrackerLocation, codeName: string, machine: string, verifiedHead?: string): OpenedTrackerStore {
        const identity = this.inspect(location, codeName, machine);
        if (identity.includes) FileTrackerScope.assertCurrent(location.project.path, identity.includes);
        return this.validateStore(identity, verifiedHead);
    }

    attachForReview(location: TrackerLocation, codeName: string, machine: string, verifiedHead?: string): OpenedTrackerStore {
        return this.validateStore(this.inspect(location, codeName, machine), verifiedHead);
    }

    private validateStore(identity: TrackerManifestIdentity, verifiedHead?: string): OpenedTrackerStore {
        const config = this.validateBare(identity.repoPath, false, verifiedHead);
        return { ...identity, configFile: config, created: false };
    }

    inspect(location: TrackerLocation, codeName: string, machine: string): TrackerManifestIdentity {
        const dirs = this.directories(location, codeName);
        new FileTrackerSource(dirs.repo.path).assertRoot();
        const saved = FileTrackerStore.readSmallFile(dirs.store.path, 'tracker.json');
        let raw: Partial<TrackerManifest> | undefined;
        try { raw = JSON.parse(saved.text); } catch { /* invalid or foreign manifest */ }
        if (!raw || typeof raw.trackerId !== 'string' || !FileTrackerStore.uuid.test(raw.trackerId)) throw this.foreign();
        if (raw.version !== 1 && raw.version !== 2) throw this.foreign();
        if (raw.version === 1 && saved.size > 16_384n) throw this.foreign();
        const includes = raw.version === 2 ? FileTrackerScope.fromManifest(raw.includeDirectories, raw.includeDirectoryIdentities) : undefined;
        const expected = this.manifest(location, dirs, codeName, machine, raw.trackerId, includes);
        if (Object.keys(raw).length !== Object.keys(expected).length) throw this.foreign();
        for (const [key, value] of Object.entries(expected)) {
            if (!Object.hasOwn(raw, key) || JSON.stringify(Reflect.get(raw, key)) !== JSON.stringify(value)) throw this.foreign();
        }
        return { repoPath: dirs.repo.path, manifest: expected, manifestFile: saved.identity, ...(includes ? { includes } : {}) };
    }

    checkNeighbor(location: TrackerLocation, codeName: string, machine: string, roots: readonly string[], scoped: boolean): string {
        const neighbor = this.inspect(location, codeName, machine);
        const owner = location.project.path;
        if (neighbor.includes) {
            for (const include of neighbor.includes) {
                const root = FileTrackerScope.absolute(owner, include);
                if (!scoped && FileTrackerLocation.samePath(root, roots[0])) FileTrackerScope.assertCurrent(owner, [include]);
                else if (roots.some(candidate => this.containsRoot(candidate, root) || this.containsRoot(root, candidate))) {
                    throw FileTrackerLocation.overlap();
                }
            }
        } else if (!scoped || !roots.some(root => FileTrackerLocation.samePath(root, owner))) {
            throw FileTrackerLocation.overlap();
        }
        // This only classifies the neighboring source claim. Opening its Git objects still requires normal attach validation.
        this.validateBare(neighbor.repoPath, false, undefined, false);
        return neighbor.manifest.trackerId;
    }

    private containsRoot(parent: string, child: string): boolean {
        const suffix = relative(parent, child);
        return !isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith(`..${sep}`);
    }

    trackingHead(repoPath: string): string {
        const refs = this.childDirectory(repoPath, 'refs');
        const heads = this.childDirectory(refs, 'heads');
        const { text } = FileTrackerStore.readSmallFile(heads, FileTrackerStore.#branch, 64);
        if (!FileTrackerStore.#sha.test(text)) throw this.foreign();
        return text.slice(0, -1);
    }

    private directories(location: TrackerLocation, codeName: string): StoreDirectories {
        const work = FileTrackerLocation.privateChild(location.project.path, FileTrackerLocation.workAreaName(location.project.path), false);
        const tracking = work && FileTrackerLocation.privateChild(work.path, 'tracking', false);
        const store = tracking && FileTrackerLocation.privateChild(tracking.path, codeName, false);
        const repo = store && FileTrackerLocation.privateChild(store.path, 'repo.git', false);
        if (!work || !tracking || !store || !repo) throw this.foreign();
        return { work, tracking, store, repo };
    }

    private assertSameDirectories(location: TrackerLocation, expected: TrackerManifest): void {
        const dirs = this.directories(location, expected.codeName);
        if (dirs.work.identity !== expected.workIdentity || dirs.tracking.identity !== expected.trackingIdentity
            || dirs.store.identity !== expected.storeIdentity || dirs.repo.identity !== expected.repoIdentity) throw this.foreign();
    }

    private manifest(location: TrackerLocation, dirs: StoreDirectories, codeName: string, machine: string, trackerId: string,
        includes?: readonly TrackerInclude[]): TrackerManifest {
        const base = { trackerId, codeName, virtualRoot: location.virtualRoot.path, root: location.project.path,
            projectPath: location.projectPath, machine, virtualRootIdentity: location.virtualRoot.identity,
            projectIdentity: location.project.identity, workIdentity: dirs.work.identity, trackingIdentity: dirs.tracking.identity,
            storeIdentity: dirs.store.identity, repoIdentity: dirs.repo.identity };
        return includes ? { version: 2, ...base, includeDirectories: includes.map(entry => entry.path),
            includeDirectoryIdentities: includes.map(entry => entry.identities) } : { version: 1, ...base };
    }

    private validateBare(repo: string, empty: boolean, verifiedHead?: string, checkObjects = true): string {
        this.assertNames(repo, ['HEAD', 'config', 'objects', 'refs']);
        const config = FileTrackerStore.readSmallFile(repo, 'config', 2048);
        this.validateConfig(config.text);
        if (FileTrackerStore.readSmallFile(repo, 'HEAD', 64).text !== `ref: refs/heads/${FileTrackerStore.#branch}\n`) throw this.foreign();
        const refs = this.childDirectory(repo, 'refs');
        this.assertNames(refs, ['heads', 'tags']);
        const heads = this.childDirectory(refs, 'heads');
        this.assertNames(heads, empty ? [] : [FileTrackerStore.#branch]);
        this.assertNames(this.childDirectory(refs, 'tags'), []);
        const head = FileTrackerLocation.matchingName(heads, FileTrackerStore.#branch);
        const headText = head ? FileTrackerStore.readSmallFile(heads, head, 64).text : null;
        if (headText && !FileTrackerStore.#sha.test(headText)) throw this.foreign();
        const objects = this.childDirectory(repo, 'objects');
        // Neighbor placement and an already verified continuation do not walk loose objects.
        if (checkObjects && (verifiedHead === undefined || headText !== `${verifiedHead}\n`)) this.validateObjects(objects, empty);
        else {
            this.assertNames(this.childDirectory(objects, 'info'), []);
            this.assertNames(this.childDirectory(objects, 'pack'), []);
        }
        return config.identity + ':' + config.text;
    }

    private validateObjects(objects: string, empty: boolean): void {
        for (const name of readdirSync(objects)) {
            if (name !== 'info' && name !== 'pack' && (empty || !/^[a-f0-9]{2}$/.test(name))) throw this.foreign();
            const dir = this.childDirectory(objects, name);
            const leaves = readdirSync(dir);
            if (name === 'info' || name === 'pack') { if (leaves.length) throw this.foreign(); continue; }
            for (const leaf of leaves) {
                if (!/^[a-f0-9]{38}$/.test(leaf)) throw this.foreign();
                FileTrackerStore.ordinaryFile(join(dir, leaf));
            }
        }
        this.childDirectory(objects, 'info');
        this.childDirectory(objects, 'pack');
    }

    private validateConfig(text: string): void {
        const lines = text.replace(/\r\n/g, '\n').trimEnd().split('\n');
        if (lines.shift() !== '[core]') throw this.foreign();
        const seen = new Map<string, string>();
        for (const line of lines) {
            const match = /^\t(repositoryformatversion|filemode|bare|symlinks|ignorecase|precomposeunicode) = (0|true|false)$/.exec(line);
            if (!match || seen.has(match[1]) || (match[1] === 'repositoryformatversion' ? match[2] !== '0' : match[2] === '0')) throw this.foreign();
            seen.set(match[1], match[2]);
        }
        if (seen.get('repositoryformatversion') !== '0' || seen.get('bare') !== 'true' || !seen.has('filemode')) throw this.foreign();
    }

    private assertNames(dir: string, allowed: readonly string[]): void {
        if (readdirSync(dir).some(name => !allowed.includes(name))) throw this.foreign();
    }

    private childDirectory(dir: string, name: string): string {
        const child = FileTrackerLocation.privateChild(dir, name, false);
        if (!child) throw this.foreign();
        return child.path;
    }

    private foreign(): FileTrackerError {
        return new FileTrackerError('The existing tracker does not match this private store or has an unsupported Git layout/configuration. It was not modified.');
    }

    private static ordinaryFile(path: string) {
        const stat = lstatSync(path, { bigint: true });
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n) throw new FileTrackerError('A private tracker file is not an ordinary single-link file.');
        return stat;
    }

    private static readSmallFile(parent: string, name: string, limit?: number): { text: string; identity: string; size: bigint } {
        if (FileTrackerLocation.matchingName(parent, name) !== name) throw new FileTrackerError('A required private tracker file is missing or has conflicting casing.');
        const path = join(parent, name);
        const before = this.ordinaryFile(path);
        const fd = openSync(path, constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW));
        try {
            const opened = fstatSync(fd, { bigint: true });
            const identity = FileTrackerLocation.identity(before);
            if (FileTrackerLocation.identity(opened) !== identity || (limit !== undefined && opened.size > BigInt(limit))) {
                throw new FileTrackerError('A private tracker file changed or exceeds its expected size.');
            }
            const bytes = limit === undefined ? readFileSync(fd) : Buffer.alloc(limit + 1);
            const count = limit === undefined ? bytes.length : readSync(fd, bytes, 0, bytes.length, 0);
            const after = this.ordinaryFile(path);
            if (BigInt(count) !== opened.size || FileTrackerLocation.identity(after) !== identity || after.mtimeNs !== opened.mtimeNs
                || after.ctimeNs !== opened.ctimeNs || after.size !== opened.size) throw new FileTrackerError('A private tracker file changed while being checked.');
            return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, count)), identity, size: opened.size };
        } finally { closeSync(fd); }
    }
}
