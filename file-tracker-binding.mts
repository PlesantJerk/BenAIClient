import { FileTrackerError, FileTrackerLocation, type TrackerLocation } from './file-tracker-location.mts';
import type { TrackerRouteSnapshot } from './file-tracker-review.mts';
import { FileTrackerScope } from './file-tracker-scope.mts';
import type { FileTrackerStore, OpenedTrackerStore } from './file-tracker-store.mts';

export type SelectedTracker = Readonly<{ location: TrackerLocation; store: OpenedTrackerStore; route: TrackerRouteSnapshot; generation: number }>;

export class FileTrackerBinding {
    static validate(binding: SelectedTracker, store: FileTrackerStore): void {
        const location = FileTrackerLocation.project(binding.route.rawRoot, binding.location.projectPath);
        if (!FileTrackerLocation.sameDirectory(location.virtualRoot, binding.location.virtualRoot)
            || !FileTrackerLocation.sameDirectory(location.project, binding.location.project)) throw this.stale();
        const expected = binding.store;
        const current = store.attach(location, expected.manifest.codeName, binding.route.machine);
        if (current.manifest.trackerId !== expected.manifest.trackerId || current.manifestFile !== expected.manifestFile
            || current.manifest.workIdentity !== expected.manifest.workIdentity || current.manifest.trackingIdentity !== expected.manifest.trackingIdentity
            || current.manifest.storeIdentity !== expected.manifest.storeIdentity || current.manifest.repoIdentity !== expected.manifest.repoIdentity
            || (current.includes === undefined) !== (expected.includes === undefined)
            || (current.includes && !FileTrackerScope.same(current.includes, expected.includes!))
            || current.configFile !== expected.configFile || !FileTrackerLocation.samePath(current.repoPath, expected.repoPath)) throw this.stale();
    }

    static stale(): FileTrackerError {
        return new FileTrackerError('The file tracker selection is stale or does not match this client and virtual root. Reopen the exact project before capturing.');
    }
}
