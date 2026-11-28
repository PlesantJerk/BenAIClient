import koffi from 'koffi';
import { closeSync, openSync, opendirSync, writeSync, type Dirent } from 'node:fs';
import path from 'node:path';
import { FileTrackerCaptureError } from './file-tracker-git.mts';

type Handle = bigint | number;

export interface TrackerDirectoryEntry { name: string; directory: boolean; unsafe: boolean }
export interface TrackerFileBytes { bytes: Buffer; link: false }
export interface TrackerExcludedFile { link: true }

export class FileTrackerSource {
    private readonly root: string;
    private readonly volume: string;
    private rootIdentity?: string;
    private readonly openHandle: (name: string, access: number, share: number, sec: null, disposition: number, flags: number, template: number) => Handle;
    private readonly getInfo: (handle: Handle, info: Buffer) => number;
    private readonly getType: (handle: Handle) => number;
    private readonly getDrive: (name: string) => number;
    private readonly readHandle: (handle: Handle, bytes: Buffer, length: number, read: Buffer, overlapped: null) => number;
    private readonly closeHandle: (handle: Handle) => number;
    private readonly lastError: () => number;

    constructor(root: string) {
        if (process.platform !== 'win32' || !/^[A-Za-z]:\\/.test(root) || path.normalize(root) !== root || root.slice(2).includes(':')) {
            throw new FileTrackerCaptureError('File tracking requires a canonical local Windows directory.');
        }
        this.root = root;
        this.volume = path.parse(root).root;
        const api = koffi.load('C:\\Windows\\System32\\kernel32.dll');
        this.openHandle = api.func('intptr_t __stdcall CreateFileW(str16 name, uint32_t access, uint32_t share, void *sec, uint32_t disposition, uint32_t flags, intptr_t templateFile)');
        this.getInfo = api.func('int __stdcall GetFileInformationByHandle(intptr_t handle, void *info)');
        this.getType = api.func('uint32_t __stdcall GetFileType(intptr_t handle)');
        this.getDrive = api.func('uint32_t __stdcall GetDriveTypeW(str16 name)');
        this.readHandle = api.func('int __stdcall ReadFile(intptr_t handle, void *bytes, uint32_t length, void *read, void *overlapped)');
        this.closeHandle = api.func('int __stdcall CloseHandle(intptr_t handle)');
        this.lastError = api.func('uint32_t __stdcall GetLastError()');
        if (this.getDrive(this.volume) !== 3) throw new FileTrackerCaptureError('File tracking supports only fixed local Windows drives.');
    }

    static safeName(name: string): boolean {
        if (!name || !name.isWellFormed() || /[\u0000-\u001f\u007f\ufffd<>:"/\\|?*]/u.test(name) || /[. ]$/u.test(name)) return false;
        // Include DOS devices (and superscript COM/LPT aliases) before handing any component to Windows.
        const stem = name.split('.')[0].trimEnd();
        return !/^(?:CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[0-9¹²³]|LPT[0-9¹²³])$/iu.test(stem);
    }

    assertRoot(): void { this.withParents([], () => {}); }

    async withPinnedDirectory<T>(operation: () => Promise<T>): Promise<T> {
        const pin = this.pin([]);
        try { return await operation(); }
        finally { pin.release(); }
    }

    pinDirectories(paths: readonly (readonly string[])[]): { release: () => void } {
        const pins: ReturnType<FileTrackerSource['pin']>[] = [];
        const release = () => { while (pins.length) pins.pop()!.release(); };
        try {
            for (const parts of paths) pins.push(this.pin(parts));
            return { release };
        } catch (error) {
            release();
            throw error;
        }
    }

    async withPinnedFile<T>(name: string, operation: () => Promise<T>): Promise<T> {
        if (!FileTrackerSource.safeName(name)) throw new FileTrackerCaptureError('File tracking rejected an unsafe file name.');
        const pin = this.pin([]);
        try {
            const handle = this.open(path.join(pin.fullPath, name), 0x80000000, 0x1);
            try {
                if (!this.isOrdinaryFile(handle, this.info(handle))) throw new FileTrackerCaptureError('File tracking requires an ordinary, unlinked file.');
                return await operation();
            } finally { this.closeHandle(handle); }
        } finally { pin.release(); }
    }

    directory(parts: readonly string[], readIgnore: (entries: TrackerDirectoryEntry[]) => void): TrackerDirectoryEntry[] {
        return this.withParents(parts, fullPath => {
            const entries = this.list(fullPath);
            readIgnore(entries);
            return entries;
        });
    }

    copyFile(parts: readonly string[], destination: string, digest?: (size: number, bytes: Buffer) => void): boolean {
        const name = parts.at(-1)!;
        if (!FileTrackerSource.safeName(name)) throw new FileTrackerCaptureError('File tracking rejected an unsafe file name.');
        return this.withParents(parts.slice(0, -1), directory => this.copyPinned(path.join(directory, name), destination, digest));
    }

    private copyPinned(fullPath: string, destination: string, digest?: (size: number, bytes: Buffer) => void): boolean {
        // Keep no-follow and deny writers/renames for the entire source copy, including its hash.
        const handle = this.open(fullPath, 0x80000000, 0x1);
        try {
            const info = this.info(handle);
            if (!this.isOrdinaryFile(handle, info)) return false;
            const size = info.readUInt32LE(32) * 0x100000000 + info.readUInt32LE(36);
            if (!Number.isSafeInteger(size)) throw new FileTrackerCaptureError('File tracking cannot represent this file size exactly.');
            this.copyBytes(handle, size, destination, digest);
            return true;
        } finally { this.closeHandle(handle); }
    }

    private copyBytes(handle: Handle, size: number, destination: string, digest?: (size: number, bytes: Buffer) => void): void {
        const fd = openSync(destination, 'wx');
        try {
            const bytes = Buffer.allocUnsafe(Math.min(size, 1024 * 1024));
            const count = Buffer.alloc(4);
            if (!size) digest?.(0, bytes);
            for (let remaining = size; remaining > 0;) {
                const length = Math.min(remaining, bytes.length);
                if (!this.readHandle(handle, bytes, length, count, null) || count.readUInt32LE(0) !== length) {
                    throw new FileTrackerCaptureError('File tracking could not read all bytes of a listed file; no snapshot was published.');
                }
                const chunk = bytes.subarray(0, length);
                digest?.(size, chunk);
                for (let offset = 0; offset < length;) {
                    const written = writeSync(fd, chunk, offset, length - offset);
                    if (written <= 0) throw new FileTrackerCaptureError('File tracking could not finish a private staged file.');
                    offset += written;
                }
                remaining -= length;
            }
        } finally { closeSync(fd); }
    }

    readFile(parts: readonly string[], limit: number): TrackerFileBytes | TrackerExcludedFile {
        const name = parts.at(-1)!;
        if (!FileTrackerSource.safeName(name)) throw new FileTrackerCaptureError('File tracking rejected an unsafe file name.');
        return this.withParents(parts.slice(0, -1), fullPath => this.openFile(path.join(fullPath, name), limit));
    }

    private list(fullPath: string): TrackerDirectoryEntry[] {
        // Keep ancestors pinned while Node enumerates the directory. Never follow an entry reported as a link.
        const dir = opendirSync(fullPath, { bufferSize: 64 });
        try {
            const entries: TrackerDirectoryEntry[] = [];
            for (let entry: Dirent | null; (entry = dir.readSync()) !== null;) {
                entries.push({ name: entry.name, directory: entry.isDirectory(), unsafe: !entry.isDirectory() && !entry.isFile() });
            }
            return entries;
        } finally { dir.closeSync(); }
    }

    private withParents<T>(parts: readonly string[], operation: (fullPath: string) => T): T {
        const pin = this.pin(parts);
        try { return operation(pin.fullPath); }
        finally { pin.release(); }
    }

    private pin(parts: readonly string[]): { fullPath: string; release: () => void } {
        const segments = this.root.slice(this.volume.length).split('\\').filter(Boolean).concat(parts);
        const handles: Handle[] = [];
        const release = () => { while (handles.length) this.closeHandle(handles.pop()!); };
        let current = this.volume;
        try {
            for (const segment of ['', ...segments]) {
                if (segment && !FileTrackerSource.safeName(segment)) throw new FileTrackerCaptureError('File tracking encountered an unsafe directory name.');
                if (segment) current = path.join(current, segment);
                const handle = this.open(current, 0x80, 0x1);
                handles.push(handle);
                const info = this.info(handle);
                const attributes = info.readUInt32LE(0);
                if ((attributes & 0x410) !== 0x10) throw new FileTrackerCaptureError('File tracking will not traverse a reparse point or a replaced directory.');
                if (current === this.root) this.verifyRootIdentity(info);
            }
            return { fullPath: current, release };
        } catch (error) {
            release();
            throw error;
        }
    }

    private verifyRootIdentity(info: Buffer): void {
        const identity = `${info.readUInt32LE(28)}:${info.readUInt32LE(44)}:${info.readUInt32LE(48)}`;
        if (this.rootIdentity !== undefined && this.rootIdentity !== identity) throw new FileTrackerCaptureError('The monitored directory changed during capture; no snapshot was published.');
        this.rootIdentity = identity;
    }

    private openFile(fullPath: string, limit: number): TrackerFileBytes | TrackerExcludedFile {
        // Open the leaf no-follow, and deny concurrent writes and renames until its bytes are captured.
        const handle = this.open(fullPath, 0x80000000, 0x1);
        try {
            const info = this.info(handle);
            if (!this.isOrdinaryFile(handle, info)) return { link: true };
            const size = (BigInt(info.readUInt32LE(32)) << 32n) + BigInt(info.readUInt32LE(36));
            if (size > BigInt(limit)) throw new FileTrackerCaptureError('File tracking exceeded a per-file or total byte limit; ignore the large untracked file, or split the tracked root.');
            return { bytes: this.readExactly(handle, Number(size)), link: false };
        } finally { this.closeHandle(handle); }
    }

    private isOrdinaryFile(handle: Handle, info: Buffer): boolean {
        return (info.readUInt32LE(0) & 0x410) === 0 && info.readUInt32LE(40) === 1 && this.getType(handle) === 1;
    }

    private open(fullPath: string, access: number, share: number): Handle {
        // OPEN_EXISTING | FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS.
        const result = this.openHandle('\\\\?\\' + fullPath, access, share, null, 3, 0x02200000, 0);
        if (result === -1 || result === -1n) throw new FileTrackerCaptureError(`File tracking could not safely open a listed path (Windows error ${this.lastError()}); no snapshot was published.`);
        return result;
    }

    private info(handle: Handle): Buffer {
        const result = Buffer.alloc(52); // BY_HANDLE_FILE_INFORMATION: fixed-width 32-bit fields.
        if (!this.getInfo(handle, result)) throw new FileTrackerCaptureError('File tracking could not verify a Windows file handle.');
        return result;
    }

    private readExactly(handle: Handle, size: number): Buffer {
        const bytes = Buffer.allocUnsafe(size);
        const count = Buffer.alloc(4);
        if (size && (!this.readHandle(handle, bytes, size, count, null) || count.readUInt32LE(0) !== size)) {
            throw new FileTrackerCaptureError('File tracking could not read all bytes of a listed file; no snapshot was published.');
        }
        return bytes;
    }
}
