import koffi from 'koffi';
import type { LibraryHandle } from 'koffi';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { WindowInfo, WindowActivationResult, WindowSetBoundsCommand } from './desktop-tools.mts';

type NativeHandle = number | bigint;
// Koffi represents void* as an opaque external object; application code never dereferences it.
type ProcessHandle = object | null;
interface NativeRect { left: number; top: number; right: number; bottom: number; }
interface NativePoint { x: number; y: number; }
interface NativePlacement {
    length: number; flags?: number; showCmd?: number;
    ptMinPosition?: NativePoint; ptMaxPosition?: NativePoint; rcNormalPosition?: NativeRect;
}

export class NativeWindows
{
    private placementSize: number;
    // Explicit signatures contain Koffi's dynamically bound FFI at this boundary.
    private enumWindows: (callback: (hwnd: NativeHandle, data: NativeHandle) => number, data: NativeHandle) => number;
    private openProcess: (access: number, inherit: number, pid: number) => ProcessHandle;
    private closeHandle: (handle: ProcessHandle) => number;
    private processImage: (process: ProcessHandle, flags: number, name: Buffer, size: number[]) => number;
    private isWindow!: (hwnd: NativeHandle) => number;
    private isVisible!: (hwnd: NativeHandle) => number;
    private isMinimized!: (hwnd: NativeHandle) => number;
    private isMaximized!: (hwnd: NativeHandle) => number;
    private foreground!: () => NativeHandle;
    private activate!: (hwnd: NativeHandle) => number;
    private titleLength!: (hwnd: NativeHandle) => number;
    private titleText!: (hwnd: NativeHandle, text: Buffer, count: number) => number;
    private processId!: (hwnd: NativeHandle, pid: number[]) => number;
    private rect!: (hwnd: NativeHandle, rect: NativeRect) => number;
    private getPlacement!: (hwnd: NativeHandle, placement: NativePlacement) => number;
    private setPlacement!: (hwnd: NativeHandle, placement: NativePlacement) => number;
    private setBounds!: (hwnd: NativeHandle, after: NativeHandle, x: number, y: number, width: number, height: number, flags: number) => number;
    private dpiContext!: (context: NativeHandle) => NativeHandle;
    private setCursor!: (x: number, y: number) => number;

    constructor()
    {
        const user = koffi.load('user32.dll');
        const kernel = koffi.load('kernel32.dll');
        const rect = koffi.struct('BenDesktopRect', { left: 'int32', top: 'int32', right: 'int32', bottom: 'int32' });
        const point = koffi.struct('BenDesktopPoint', { x: 'int32', y: 'int32' });
        const placement = koffi.struct('BenDesktopPlacement', { length: 'uint32', flags: 'uint32', showCmd: 'uint32',
            ptMinPosition: point, ptMaxPosition: point, rcNormalPosition: rect });
        koffi.proto('int __stdcall BenDesktopEnum(uintptr_t hwnd, intptr_t data)');
        this.placementSize = koffi.sizeof(placement);
        this.enumWindows = user.func('int __stdcall EnumWindows(BenDesktopEnum *callback, intptr_t data)');
        this.bindWindowFunctions(user);
        this.openProcess = kernel.func('void * __stdcall OpenProcess(uint32 access, int inherit, uint32 pid)');
        this.closeHandle = kernel.func('int __stdcall CloseHandle(void *handle)');
        this.processImage = kernel.func('int __stdcall QueryFullProcessImageNameW(void *process, uint32 flags, _Out_ uint16 *name, _Inout_ uint32 *size)');
    }

    private bindWindowFunctions(user: LibraryHandle): void
    {
        this.isWindow = user.func('int __stdcall IsWindow(uintptr_t hwnd)');
        this.isVisible = user.func('int __stdcall IsWindowVisible(uintptr_t hwnd)');
        this.isMinimized = user.func('int __stdcall IsIconic(uintptr_t hwnd)');
        this.isMaximized = user.func('int __stdcall IsZoomed(uintptr_t hwnd)');
        this.foreground = user.func('uintptr_t __stdcall GetForegroundWindow()');
        this.activate = user.func('int __stdcall SetForegroundWindow(uintptr_t hwnd)');
        this.titleLength = user.func('int __stdcall GetWindowTextLengthW(uintptr_t hwnd)');
        this.titleText = user.func('int __stdcall GetWindowTextW(uintptr_t hwnd, _Out_ uint16 *text, int count)');
        this.processId = user.func('uint32 __stdcall GetWindowThreadProcessId(uintptr_t hwnd, _Out_ uint32 *pid)');
        this.rect = user.func('int __stdcall GetWindowRect(uintptr_t hwnd, _Out_ BenDesktopRect *rect)');
        this.getPlacement = user.func('int __stdcall GetWindowPlacement(uintptr_t hwnd, _Inout_ BenDesktopPlacement *placement)');
        this.setPlacement = user.func('int __stdcall SetWindowPlacement(uintptr_t hwnd, const BenDesktopPlacement *placement)');
        this.setBounds = user.func('int __stdcall SetWindowPos(uintptr_t hwnd, uintptr_t after, int x, int y, int width, int height, uint32 flags)');
        this.dpiContext = user.func('intptr_t __stdcall SetThreadDpiAwarenessContext(intptr_t context)');
        this.setCursor = user.func('int __stdcall SetCursorPos(int x, int y)');
    }

    private physical<T>(action: () => T extends PromiseLike<unknown> ? never : T): T
    {
        // Synchronous only: release per-monitor-v2 DPI context before yielding the thread.
        const previous = this.dpiContext(-4);
        if (!previous) throw new Error('Cannot enter physical desktop DPI context');
        try { return action(); }
        finally { this.dpiContext(previous); }
    }

    private requireWindow(windowId: string): bigint
    {
        if (typeof windowId !== 'string' || !/^0x[0-9a-f]{1,16}$/i.test(windowId))
            throw new Error('windowId must be an opaque HWND returned by window_list');
        const hwnd = BigInt(windowId);
        if (!this.isWindow(hwnd)) throw new Error('Window no longer exists');
        return hwnd;
    }

    private getTitle(hwnd: NativeHandle): string
    {
        const count = this.titleLength(hwnd) + 1;
        const text = Buffer.alloc(count * 2);
        const length = this.titleText(hwnd, text, count);
        return text.toString('utf16le', 0, length * 2);
    }

    private getProcessName(pid: number): string
    {
        const process = this.openProcess(0x1000, 0, pid);
        if (!process) return ''; // Protected/exited processes can still own a listed window.
        try {
            const size = [32768];
            const text = Buffer.alloc(size[0] * 2);
            return this.processImage(process, 0, text, size) ? path.win32.basename(text.toString('utf16le', 0, size[0] * 2)) : '';
        }
        finally { this.closeHandle(process); }
    }

    private info(hwnd: NativeHandle): WindowInfo
    {
        const bounds: NativeRect = { left: 0, top: 0, right: 0, bottom: 0 };
        const pid = [0];
        if (!this.rect(hwnd, bounds) || !this.processId(hwnd, pid)) throw new Error('Cannot read window information; window may have closed');
        return { windowId: '0x' + BigInt(hwnd).toString(16), title: this.getTitle(hwnd), processId: pid[0],
            processName: this.getProcessName(pid[0]),
            bounds: { x: bounds.left, y: bounds.top, width: bounds.right - bounds.left, height: bounds.bottom - bounds.top },
            isMinimized: !!this.isMinimized(hwnd), isMaximized: !!this.isMaximized(hwnd),
            isForeground: BigInt(this.foreground()) === BigInt(hwnd) };
    }

    list(): WindowInfo[]
    {
        return this.physical(() => {
            const windows: WindowInfo[] = [];
            let failure: unknown;
            const ok = this.enumWindows(hwnd => {
                try { if (this.isVisible(hwnd)) windows.push(this.info(hwnd)); }
                catch (error) { if (this.isWindow(hwnd)) { failure = error; return 0; } }
                return 1;
            }, 0);
            if (failure) throw failure;
            if (!ok) throw new Error('Unable to enumerate desktop windows');
            return windows;
        });
    }

    private restoreWithoutActivation(hwnd: NativeHandle): void
    {
        if (!this.isMinimized(hwnd) && !this.isMaximized(hwnd)) return;
        const placement: NativePlacement = { length: this.placementSize };
        if (!this.getPlacement(hwnd, placement)) throw new Error('Cannot read window placement');
        placement.flags = 0;
        placement.showCmd = 4; // SW_SHOWNOACTIVATE: restore without changing foreground ownership.
        if (!this.setPlacement(hwnd, placement)) throw new Error('Cannot restore window without activation');
    }

    async activateWindow(windowId: string): Promise<WindowActivationResult>
    {
        const hwnd = this.physical(() => {
            const hwnd = this.requireWindow(windowId);
            if (this.isMinimized(hwnd)) this.restoreWithoutActivation(hwnd);
            this.activate(hwnd); // Respect Windows foreground restrictions; no input/thread-attachment tricks.
            return hwnd;
        });
        await delay(2000); // Ben's timing experiment: intentionally wait, do not poll.
        return this.physical(() => {
            const info = this.info(hwnd);
            return { ...info, success: info.isForeground,
                msg: info.isForeground ? '' : 'Windows did not grant foreground activation (focus restrictions or another application changed focus).' };
        });
    }

    setWindowBounds(cmd: WindowSetBoundsCommand): WindowInfo
    {
        return this.physical(() => {
            const hwnd = this.requireWindow(cmd.windowId);
            this.restoreWithoutActivation(hwnd);
            // SWP_NOZORDER | SWP_NOACTIVATE | SWP_NOOWNERZORDER. Applications may constrain the result.
            if (!this.setBounds(hwnd, 0, cmd.x, cmd.y, cmd.width, cmd.height, 0x214))
                throw new Error('Windows rejected the requested window bounds');
            return this.info(hwnd);
        });
    }

    moveCursor(x: number, y: number): void
    {
        this.physical(() => { if (!this.setCursor(x, y)) throw new Error('Cannot position cursor on the physical desktop'); });
    }
}
