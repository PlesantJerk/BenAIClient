export class FileTrackerCaptureFence {
    readonly state: Int32Array;

    constructor(state = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT))) {
        this.state = state;
    }

    get isCurrent(): boolean { return Atomics.load(this.state, 0) === 0; }
    get publicationAdmitted(): boolean { return Atomics.load(this.state, 0) === 2; }

    revoke(): void { Atomics.compareExchange(this.state, 0, 0, 1); }

    admitPublication(): boolean {
        // This is the ordering point with live root/name switches, immediately before the Git spawn.
        // Once admitted, Git still does its own expected-old-ref compare and swap across processes.
        return Atomics.compareExchange(this.state, 0, 0, 2) === 0;
    }
}
