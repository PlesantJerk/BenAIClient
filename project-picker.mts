import { lstat, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { AIConfig } from './configsetup.mts';


export interface PickerCommand { id: string; command: string; }
export interface PickerSearchCommand extends PickerCommand {
    project_name: string;
    mode: '@' | '$';
    query: string;
}
export interface PickerProject { name: string; comment?: string; }
export interface PickerMatch { name: string; relative_path: string; is_directory: boolean; }
export interface PickerReply {
    success: boolean;
    msg: string;
    projects?: PickerProject[];
    min_search_length?: number;
    matches?: PickerMatch[];
}
interface ProjectIndex { entries: PickerMatch[]; created: number; }
interface SearchSettings {
    project: NonNullable<AIConfig['projects']>[number];
    mode: '@' | '$';
    query: string;
    limit: number;
}

/** Name-only search, independent of polling/desktop state. No file contents cross this boundary. */
export class ProjectPicker {
    private readonly indexes = new Map<string, ProjectIndex>();
    private readonly pending = new Map<string, Promise<ProjectIndex>>();
    private lastRoot = '';
    private static readonly cacheMilliseconds = 15000;
    private static readonly scanMilliseconds = 5000;

    private readonly config: AIConfig;
    private readonly getRoot: () => string;

    constructor(config: AIConfig, getRoot: () => string) {
        this.config = config;
        this.getRoot = getRoot;
    }

    async configuration(_command: PickerCommand, reply: PickerReply): Promise<void> {
        await this.respond(reply, async () => ({
            projects: this.projects().map(project => ({ name: project.name, comment: project.comment })),
            min_search_length: 3
        }));
    }

    async search(command: PickerSearchCommand, reply: PickerReply): Promise<void> {
        await this.respond(reply, async () => {
            const settings = this.settings(command);
            if (settings.query.length < 3) return { matches: [] };
            const index = await this.index(settings.project.path);
            return { matches: this.match(index.entries, settings) };
        });
    }

    // This is the JSON command boundary, not a silent recovery in the search implementation.
    private async respond(reply: PickerReply, action: () => Promise<Partial<PickerReply>>): Promise<void> {
        try { Object.assign(reply, await action(), { success: true, msg: '' }); }
        catch (error) {
            reply.success = false;
            reply.msg = error instanceof Error ? error.message : String(error);
        }
    }

    private projects(): NonNullable<AIConfig['projects']> {
        const projects = this.config.projects ?? [];
        const names = new Set<string>();
        for (const project of projects) {
            if (!project.name || /\s/.test(project.name) || !project.path)
                throw new Error('Picker projects require a nonempty, space-free name and a path.');
            const name = project.name.toLowerCase();
            if (names.has(name)) throw new Error(`Duplicate picker project name: ${project.name}`);
            names.add(name);
        }
        return projects;
    }

    private settings(command: PickerSearchCommand): SearchSettings {
        if (command.mode !== '@' && command.mode !== '$') throw new Error('Invalid picker mode.');
        if (typeof command.query !== 'string' || typeof command.project_name !== 'string')
            throw new Error('Picker project_name and query must be strings.');
        const project = this.projects().find(item => item.name.toLowerCase() === command.project_name.toLowerCase());
        if (!project) throw new Error(`Unknown picker project: ${command.project_name}`);
        const limit = this.config.max_match_count ?? 10;
        if (!Number.isInteger(limit) || limit < 1) throw new Error('max_match_count must be a positive integer.');
        return { project, mode: command.mode, query: command.query.trim().toLowerCase(), limit };
    }

    private extensions(mode: '@' | '$'): Set<string> {
        const configured = mode === '@' ? this.config.at_file_extensions : this.config.dollar_file_extensions;
        const defaults = mode === '@' ? ['cs', 'ts', 'js', 'razor', 'vue'] : ['md'];
        return new Set((configured ?? defaults).map(extension => extension.replace(/^\./, '').toLowerCase()));
    }

    private match(entries: PickerMatch[], settings: SearchSettings): PickerMatch[] {
        const extensions = this.extensions(settings.mode);
        return entries.filter(entry => this.eligible(entry, settings.mode, extensions)
                && entry.name.toLowerCase().includes(settings.query))
            .sort((left, right) => this.compare(left, right, settings.query))
            .slice(0, settings.limit);
    }

    private eligible(entry: PickerMatch, mode: '@' | '$', extensions: Set<string>): boolean {
        return entry.is_directory ? mode === '@' : extensions.has(path.extname(entry.name).slice(1).toLowerCase());
    }

    private compare(left: PickerMatch, right: PickerMatch, query: string): number {
        const rank = Number(right.name.toLowerCase().startsWith(query)) - Number(left.name.toLowerCase().startsWith(query));
        return rank || left.name.localeCompare(right.name, 'en', { sensitivity: 'base' })
            || left.relative_path.localeCompare(right.relative_path, 'en', { sensitivity: 'base' });
    }

    private async index(projectPath: string): Promise<ProjectIndex> {
        const deadline = new ScanDeadline(ProjectPicker.scanMilliseconds);
        const configuredRoot = path.resolve(this.getRoot());
        const configuredProject = path.resolve(configuredRoot, projectPath);
        this.assertContained(configuredRoot, configuredProject);
        await this.rejectPathLinks(configuredRoot, configuredProject, deadline);
        const root = await deadline.wait(() => realpath(configuredRoot));
        const project = await deadline.wait(() => realpath(configuredProject));
        this.assertContained(root, project);
        return this.cachedIndex(root, project, deadline);
    }

    private async rejectPathLinks(root: string, project: string, deadline: ScanDeadline): Promise<void> {
        let current = root;
        const segments = path.relative(root, project).split(path.sep).filter(Boolean);
        for (const segment of ['', ...segments]) {
            current = path.join(current, segment);
            const stats = await deadline.wait(() => lstat(current));
            if (stats.isSymbolicLink()) throw new Error('The configured project path cannot contain symbolic links or junctions.');
        }
    }

    private async cachedIndex(root: string, project: string, deadline: ScanDeadline): Promise<ProjectIndex> {
        if (root !== this.lastRoot) { this.indexes.clear(); this.pending.clear(); this.lastRoot = root; }
        const key = `${root}\0${project}`;
        const cached = this.indexes.get(key);
        if (cached && Date.now() - cached.created < ProjectPicker.cacheMilliseconds) return cached;
        const existing = this.pending.get(key);
        if (existing) return deadline.wait(() => existing);
        const building = this.buildIndex(root, project, deadline);
        this.pending.set(key, building);
        try { const result = await building; this.indexes.set(key, result); return result; }
        finally { this.pending.delete(key); }
    }

    private assertContained(root: string, project: string): void {
        const relative = path.relative(root, project);
        if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
            throw new Error('The configured project is outside the virtual folder.');
    }

    private exclusions(): RegExp[] {
        return (this.config.exclude_directories ?? []).map(pattern => {
            const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
            return new RegExp(`^${escaped}$`, 'i');
        });
    }

    private async buildIndex(root: string, project: string, deadline: ScanDeadline): Promise<ProjectIndex> {
        const entries: PickerMatch[] = [];
        const directories = [project];
        const exclusions = this.exclusions();
        const extensions = new Set([...this.extensions('@'), ...this.extensions('$')]);
        while (directories.length) {
            deadline.check();
            const directory = directories.pop()!;
            await this.scanDirectory(root, directory, directories, entries, exclusions, extensions, deadline);
        }
        deadline.check();
        return { entries, created: Date.now() };
    }

    private async scanDirectory(root: string, directory: string, directories: string[], entries: PickerMatch[],
            exclusions: RegExp[], extensions: Set<string>, deadline: ScanDeadline): Promise<void> {
        if ((await deadline.wait(() => lstat(directory))).isSymbolicLink()) return;
        for (const entry of await deadline.wait(() => readdir(directory, { withFileTypes: true }))) {
            deadline.check();
            if (entry.isSymbolicLink()) continue; // Includes Windows junctions; never intentionally follow links.
            const isDirectory = entry.isDirectory();
            if (isDirectory && exclusions.some(pattern => pattern.test(entry.name))) continue;
            if (!isDirectory && (!entry.isFile() || !extensions.has(path.extname(entry.name).slice(1).toLowerCase()))) continue;
            const fullPath = path.join(directory, entry.name);
            if (isDirectory) directories.push(fullPath);
            entries.push({ name: entry.name, relative_path: path.relative(root, fullPath).replaceAll(path.sep, '\\'), is_directory: isDirectory });
        }
    }
}

/** Bounds our wait, not OS I/O: a timed-out operation may still settle, but cannot resume the walk. */
class ScanDeadline {
    private readonly end: number;
    private expired = false;
    private readonly error = new Error('Project scan exceeded five seconds. Narrow the project or add directory exclusions.');

    constructor(milliseconds: number) { this.end = performance.now() + milliseconds; }

    check(): void {
        if (this.expired || performance.now() >= this.end) {
            this.expired = true;
            throw this.error;
        }
    }

    async wait<T>(operation: () => Promise<T>): Promise<T> {
        this.check();
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => { this.expired = true; reject(this.error); }, this.end - performance.now());
        });
        try {
            const result = await Promise.race([operation(), timeout]);
            this.check();
            return result;
        } finally { clearTimeout(timer); }
    }
}

