import { realpathSync } from 'node:fs';
import { basename, join } from 'node:path';
import { FileTrackerSource } from './file-tracker-files.mts';
import { FileTrackerError, FileTrackerLocation } from './file-tracker-location.mts';

export type TrackerInclude = Readonly<{ path: string; identities: readonly string[] }>;

export class FileTrackerScope {
    static resolve(project: string, value: unknown): TrackerInclude[] {
        if (!Array.isArray(value) || !value.length) throw new FileTrackerError('Select one or more relative include directories.');
        const paths = value.map(path => this.relativeParts(path));
        return this.sortAndCheck(paths.map(parts => this.resolveInclude(project, parts)));
    }

    static fromManifest(paths: unknown, identities: unknown): TrackerInclude[] {
        if (!Array.isArray(paths) || !paths.length || !Array.isArray(identities) || identities.length !== paths.length) {
            throw new FileTrackerError('The stored tracker scope is invalid.');
        }
        const includes = paths.map((value, index) => this.storedInclude(value, identities[index]));
        const ordered = this.sortAndCheck([...includes]);
        if (!this.same(includes, ordered)) throw new FileTrackerError('The stored tracker scope is invalid.');
        return includes;
    }

    private static storedInclude(value: unknown, identities: unknown): TrackerInclude {
        const parts = this.relativeParts(value);
        const path = parts.join('/');
        if (value !== path || !Array.isArray(identities) || identities.length !== parts.length || !identities.every(identity =>
            typeof identity === 'string' && /^[0-9]+:[1-9][0-9]*:-?[0-9]+:[0-9]+:[0-9]+$/u.test(identity))) {
            throw new FileTrackerError('The stored tracker scope is invalid.');
        }
        return { path, identities };
    }

    private static sortAndCheck(includes: TrackerInclude[]): TrackerInclude[] {
        const keys = new Set<string>();
        const identities = new Set<string>();
        for (const include of includes) {
            const key = include.path.toLowerCase();
            const identity = include.identities.at(-1)!;
            if (keys.has(key) || identities.has(identity)) throw this.overlap();
            keys.add(key);
            identities.add(identity);
        }
        for (const key of keys) {
            for (let slash = key.indexOf('/'); slash >= 0; slash = key.indexOf('/', slash + 1)) {
                if (keys.has(key.slice(0, slash))) throw this.overlap();
            }
        }
        return includes.sort((left, right) => left.path < right.path ? -1 : left.path === right.path ? 0 : 1);
    }

    static same(left: readonly TrackerInclude[], right: readonly TrackerInclude[]): boolean {
        return left.length === right.length && left.every((entry, index) => {
            const other = right[index];
            return entry.path === other.path && entry.identities.length === other.identities.length
                && entry.identities.every((identity, i) => identity === other.identities[i]);
        });
    }

    static assertCurrent(project: string, includes: readonly TrackerInclude[]): void {
        const current = this.resolve(project, includes.map(entry => entry.path));
        if (!this.same(includes, current)) throw this.unavailable();
    }

    static absolute(project: string, include: TrackerInclude): string {
        return join(project, ...include.path.split('/'));
    }

    static async withPinnedRoots<T>(project: string, includes: readonly TrackerInclude[], operation: () => Promise<T>): Promise<T> {
        const pins = new FileTrackerSource(project).pinDirectories(includes.map(include => include.path.split('/')));
        try {
            this.assertCurrent(project, includes);
            return await operation();
        } finally { pins.release(); }
    }

    static contains(prefixes: ReadonlySet<string>, path: string): boolean {
        if (path.split('/').some(part => this.isMetadata(part))) return false;
        for (let slash = path.indexOf('/'); slash >= 0; slash = path.indexOf('/', slash + 1)) {
            if (prefixes.has(path.slice(0, slash))) return true;
        }
        return false;
    }

    static partition(files: ReadonlyMap<string, string>, includes: readonly TrackerInclude[]): Map<string, Map<string, string>> {
        const groups = new Map(includes.map(include => [include.path, new Map<string, string>()]));
        for (const [path, sha] of files) {
            if (path.split('/').some(part => this.isMetadata(part))) {
                throw new FileTrackerError('The private tree contains Git or tracker metadata.');
            }
            let matched = false;
            for (let slash = path.indexOf('/'); slash >= 0; slash = path.indexOf('/', slash + 1)) {
                const group = groups.get(path.slice(0, slash));
                if (!group) continue;
                group.set(path.slice(slash + 1), sha);
                matched = true;
                break;
            }
            if (!matched) throw new FileTrackerError('The private tree contains a path outside the stored tracker scope.');
        }
        return groups;
    }

    private static isMetadata(part: string): boolean {
        const key = part.toLowerCase();
        return key === '.git' || key === '.aiwork' || /^git~[1-9]$/u.test(key);
    }

    private static relativeParts(value: unknown): string[] {
        if (typeof value !== 'string') throw new FileTrackerError('Every include must be a relative directory path.');
        const parts = value.split(/[\\/]/u);
        for (const part of parts) {
            FileTrackerLocation.assertOrdinarySegment(part);
            if (/^git~[0-9]+$/iu.test(part)) throw new FileTrackerError('The include contains a reserved Git directory name.');
        }
        return parts;
    }

    private static resolveInclude(project: string, parts: readonly string[]): TrackerInclude {
        const names: string[] = [], identities: string[] = [];
        let parent = project;
        try {
            for (const part of parts) {
                const directory = FileTrackerLocation.directory(join(parent, part));
                const name = basename(realpathSync.native(directory.path));
                names.push(name);
                identities.push(directory.identity);
                parent = join(parent, name);
            }
            new FileTrackerSource(parent).assertRoot();
            return { path: names.join('/'), identities };
        } catch { throw this.unavailable(); }
    }

    private static overlap(): FileTrackerError {
        return new FileTrackerError('Included directories must be distinct and must not contain one another.');
    }

    private static unavailable(): FileTrackerError {
        return new FileTrackerError('An included directory is missing, replaced or unsafe. No snapshot was published.');
    }
}
