import { lstatSync, mkdirSync, readdirSync, realpathSync, type BigIntStats } from 'node:fs';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { FileTrackerSource, type TrackerDirectoryEntry } from './file-tracker-files.mts';
import type { FileTrackerStore } from './file-tracker-store.mts';

export class FileTrackerError extends Error {}

export type TrackerDirectory = Readonly<{ path: string; identity: string }>;
export type TrackerLocation = Readonly<{ virtualRoot: TrackerDirectory; project: TrackerDirectory; projectPath: string }>;

type TrackerPlacement = Readonly<{
    virtualRoot: TrackerDirectory; machine: string; store: FileTrackerStore;
    roots: readonly string[]; scoped: boolean;
}>;

export class FileTrackerLocation {
    static readonly #special = new Set(['.aiwork', '.git', '.hg', '.svn', 'node_modules', '$recycle.bin', 'system volume information']);
    static readonly #reserved = /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)(?:\.|$)/i;
    static readonly #invalid = /[<>:"|?*\\/\x00-\x1f\x7f]/;

    static project(configuredRoot: string, projectPath: unknown): TrackerLocation {
        if (typeof projectPath !== 'string' || !projectPath || projectPath.length > 480 || isAbsolute(projectPath)) {
            throw new FileTrackerError('Specify an explicit project directory relative to the selected virtual root.');
        }
        const parts = projectPath.split(/[\\/]/);
        for (const part of parts) this.assertOrdinarySegment(part);
        const virtualRoot = this.configuredRoot(configuredRoot);
        const project = parts.reduce((parent, name) => this.directoryChild(parent.path, name), virtualRoot);
        new FileTrackerSource(project.path).assertRoot();
        return { virtualRoot, project, projectPath: relative(virtualRoot.path, project.path).split(sep).join('/') };
    }

    static configuredRoot(raw: string): TrackerDirectory {
        if (typeof raw !== 'string' || !isAbsolute(raw) || (process.platform === 'win32' && !/^[A-Za-z]:[\\/]/.test(raw))) {
            throw new FileTrackerError('The selected virtual root must be a local, absolute directory.');
        }
        const full = resolve(raw);
        const base = parse(full).root;
        return relative(base, full).split(sep).filter(Boolean)
            .reduce((parent, name) => this.directoryChild(parent.path, name), this.directory(base));
    }

    static codeName(value: unknown): string {
        if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value) || this.#reserved.test(value)) {
            throw new FileTrackerError('Use a tracker code name of 1 to 64 ASCII letters, digits, hyphens or underscores, starting with a letter or digit.');
        }
        return value;
    }

    static assertOrdinarySegment(name: string): void {
        if (!this.ordinary(name)) throw new FileTrackerError('The project path contains an unsafe or reserved directory name.');
    }

    private static ordinary(name: string): boolean {
        return !!name && FileTrackerSource.safeName(name) && !this.#invalid.test(name)
            && !this.#special.has(name.toLowerCase());
    }

    static matchingName(parent: string, expected: string): string | undefined {
        const names = readdirSync(parent).filter(name => name.toLowerCase() === expected.toLowerCase());
        if (names.length > 1) throw new FileTrackerError('The path has a case-insensitive name collision.');
        return names[0];
    }

    static directoryChild(parent: string, name: string): TrackerDirectory {
        const actual = this.matchingName(parent, name);
        if (!actual || (actual !== name && process.platform !== 'win32')) {
            throw new FileTrackerError('The explicit project directory does not exist at the selected relative path.');
        }
        return this.directory(join(parent, actual));
    }

    static workAreaName(project: string): string {
        // Reuse the project's spelling of this shared outer folder, not the names inside our private store.
        return this.matchingName(project, '.AIWork') ?? '.AIWork';
    }

    static privateChild(parent: string, name: string, create: boolean): TrackerDirectory | undefined {
        const actual = this.matchingName(parent, name);
        if (actual !== undefined && actual !== name) throw new FileTrackerError('The private tracker path has a conflicting name or casing.');
        const path = join(parent, name);
        if (actual === undefined) {
            if (!create) return undefined;
            mkdirSync(path, { mode: 0o700 });
        }
        return this.directory(path);
    }

    static directory(path: string): TrackerDirectory {
        const stat = lstatSync(path, { bigint: true });
        if (!stat.isDirectory() || stat.isSymbolicLink() || !this.samePath(realpathSync.native(path), path)) {
            throw new FileTrackerError('Links, junctions and redirected directories are not supported for tracker locations.');
        }
        return { path, identity: this.identity(stat) };
    }

    static identity(stat: BigIntStats): string {
        if (stat.ino === 0n) throw new FileTrackerError('The filesystem does not provide a reliable tracker location identity.');
        return `${stat.dev}:${stat.ino}:${stat.birthtimeNs}:${stat.uid}:${stat.gid}`;
    }

    static samePath(left: string, right: string): boolean {
        return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
    }

    static sameDirectory(left: TrackerDirectory, right: TrackerDirectory): boolean {
        return this.samePath(left.path, right.path) && left.identity === right.identity;
    }

    static assertNotNested(location: TrackerLocation, machine: string, store: FileTrackerStore, included?: readonly string[]): void {
        const project = location.project.path;
        const placement = { virtualRoot: location.virtualRoot, machine, store, scoped: included !== undefined,
            roots: included?.map(include => join(project, ...include.split('/'))) ?? [project] };
        for (let p = dirname(project); ; p = dirname(p)) {
            if (this.matchingName(p, '.AIWork')) this.listScoped(new FileTrackerSource(p), [], p, placement);
            if (this.samePath(location.virtualRoot.path, p)) break;
        }
        if (!included) {
            this.assertNoTrackedDescendant(project);
            return;
        }
        const source = new FileTrackerSource(project);
        for (const include of included) this.assertNoScopedTrackerOverlap(source, project, include.split('/'), placement);
    }

    private static assertNoScopedTrackerOverlap(source: FileTrackerSource, project: string, root: readonly string[], placement: TrackerPlacement): void {
        for (let length = 1; length < root.length; length++) {
            const parts = root.slice(0, length);
            this.listScoped(source, parts, project, placement);
        }
        const pending = [[...root]];
        while (pending.length) {
            const parts = pending.pop()!;
            for (const child of this.listScoped(source, parts, project, parts.length === root.length ? placement : undefined)) {
                if (child.directory && !child.unsafe && this.ordinary(child.name)) pending.push([...parts, child.name]);
            }
        }
    }

    private static listScoped(source: FileTrackerSource, parts: readonly string[], base: string, placement?: TrackerPlacement): TrackerDirectoryEntry[] {
        return source.directory(parts, entries => {
            const work = this.metadataEntry(entries, '.aiwork');
            if (!work?.directory) return;
            const workParts = [...parts, work.name];
            source.directory(workParts, children => {
                const tracking = this.metadataEntry(children, 'tracking');
                if (!tracking) return;
                if (!tracking.directory || tracking.name !== 'tracking' || !placement) throw this.overlap();
                const owner = join(base, ...parts);
                const trackingParts = [...workParts, tracking.name];
                source.directory(trackingParts, stores => this.checkStores(owner, placement, source, trackingParts, stores));
            });
        });
    }

    private static metadataEntry(entries: readonly TrackerDirectoryEntry[], name: string): TrackerDirectoryEntry | undefined {
        const matches = entries.filter(entry => entry.name.toLowerCase() === name);
        if (matches.length > 1 || matches[0]?.unsafe) throw this.overlap();
        return matches[0];
    }

    private static checkStores(owner: string, placement: TrackerPlacement, source: FileTrackerSource,
        trackingParts: readonly string[], stores: readonly TrackerDirectoryEntry[]): void {
        const { virtualRoot, machine, store, roots, scoped } = placement;
        if (!stores.length || this.samePath(owner, virtualRoot.path)) throw this.overlap();
        const projectPath = relative(virtualRoot.path, owner).split(sep).join('/');
        const location = this.project(virtualRoot.path, projectPath);
        const names = new Set<string>(), ids = new Set<string>();
        for (const entry of stores) {
            const name = entry.name.toLowerCase();
            if (!entry.directory || entry.unsafe || names.has(name)) throw this.overlap();
            names.add(name);
            const codeName = this.codeName(entry.name);
            const pin = source.pinDirectories([[...trackingParts, codeName, 'repo.git']]);
            try {
                const id = store.checkNeighbor(location, codeName, machine, roots, scoped);
                if (ids.has(id)) throw this.overlap();
                ids.add(id);
            } finally { pin.release(); }
        }
    }

    static overlap(): FileTrackerError {
        return new FileTrackerError('Another tracker target overlaps the selected source directories or could not be verified safely.');
    }

    private static hasTrackerArea(path: string): boolean {
        const work = this.matchingName(path, '.AIWork');
        if (!work) return false;
        const workPath = join(path, work);
        const stat = lstatSync(workPath);
        if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
        return this.matchingName(workPath, 'tracking') !== undefined;
    }

    private static assertNoTrackedDescendant(project: string): void {
        const pending = [project];
        while (pending.length) {
            const current = pending.pop()!;
            if (current !== project && this.hasTrackerArea(current)) throw new FileTrackerError('The selected directory contains another tracker target.');
            const children = readdirSync(current, { withFileTypes: true });
            for (const child of children) {
                if (child.isDirectory() && !child.isSymbolicLink() && this.ordinary(child.name)) {
                    const path = join(current, child.name);
                    pending.push(this.directory(path).path);
                }
            }
        }
    }

    static ignoreScope(location: TrackerLocation): { workTree: string; probePath: string } {
        let workTree = location.project.path;
        for (let p = location.project.path; ; p = dirname(p)) {
            if (this.matchingName(p, '.git') !== undefined) { workTree = p; break; }
            if (this.samePath(location.virtualRoot.path, p)) break;
        }
        for (let p = location.project.path; ; p = dirname(p)) {
            const rule = this.matchingName(p, '.gitignore');
            if (rule) {
                const stat = lstatSync(join(p, rule));
                if (rule !== '.gitignore' || !stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
                    throw new FileTrackerError('A project ignore file could not be checked safely.');
                }
            }
            if (p === workTree) break;
        }
        return { workTree, probePath: relative(workTree, join(location.project.path, this.workAreaName(location.project.path))).split(sep).join('/') };
    }
}
