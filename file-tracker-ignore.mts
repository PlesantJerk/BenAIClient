import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { FileTrackerGit } from './file-tracker-git.mts';
import { FileTrackerSource } from './file-tracker-files.mts';
import { FileTrackerLocation, type TrackerLocation } from './file-tracker-location.mts';

export class FileTrackerIgnore {
    private readonly git: FileTrackerGit;
    constructor(git: FileTrackerGit) { this.git = git; }

    async warnings(location: TrackerLocation, repoPath: string): Promise<string[]> {
        const warning = 'Project .gitignore rules did not confirm that its private .AIWork directory is ignored. Review your real repository ignore rules before staging files; no ignore files were changed.';
        try {
            return await new FileTrackerSource(repoPath).withPinnedFile('config', async () => {
                const ignored = await this.projectRulesIgnore(location, repoPath);
                return ignored ? [] : [warning];
            });
        } catch { return [warning]; }
    }

    private async projectRulesIgnore(location: TrackerLocation, repoPath: string): Promise<boolean> {
        const scope = FileTrackerLocation.ignoreScope(location);
        const scratch = mkdtempSync(join(dirname(repoPath), '.capture-'));
        try {
            const workTree = join(scratch, 'rules');
            mkdirSync(join(workTree, scope.probePath), { recursive: true });
            this.copyRules(location, scope.workTree, workTree);
            const result = await this.git.run(repoPath, ['check-ignore', '--no-index', '-q', '--', scope.probePath],
                { workTree, scratchRoot: scratch, allowExitCodes: [0, 1] });
            return result.exitCode === 0;
        } finally { rmSync(scratch, { recursive: true, force: true }); }
    }

    private copyRules(location: TrackerLocation, realRuleRoot: string, workTree: string): void {
        const source = new FileTrackerSource(realRuleRoot);
        let copied = 0;
        for (let p = location.project.path; ; p = dirname(p)) {
            if (FileTrackerLocation.matchingName(p, '.gitignore') === '.gitignore') {
                const trail = relative(realRuleRoot, p).split('\\').filter(Boolean);
                const data = source.readFile([...trail, '.gitignore'], Math.min(262_144, 1_048_576 - copied));
                if (data.link) throw new Error('An ordinary project ignore file was not available.');
                copied += data.bytes.length;
                writeFileSync(join(workTree, ...trail, '.gitignore'), data.bytes, { flag: 'wx' });
            }
            if (p === realRuleRoot) break;
        }
    }
}
