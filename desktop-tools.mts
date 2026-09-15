import { NativeWindows } from './desktop-windows.mts';
import { ClipboardText } from './desktop-clipboard.mts';
import nut from '@nut-tree-fork/nut-js';
import { setTimeout as delay } from 'node:timers/promises';

// JSON wire contracts for the six desktop commands. Native handles never cross this boundary.
export interface DesktopCommand { id: string; command: string; }
export interface WindowListCommand extends DesktopCommand { command: 'window_list'; }
export interface WindowActivateCommand extends DesktopCommand { command: 'window_activate'; windowId: string; }
export interface WindowBounds { x: number; y: number; width: number; height: number; }
export interface WindowSetBoundsCommand extends DesktopCommand, WindowBounds {
    command: 'window_set_bounds'; windowId: string;
}
export interface MouseDoubleClickCommand extends DesktopCommand {
    command: 'mouse_double_click'; x: number; y: number; button: 'left' | 'right'; delay: number;
}
export interface ClipboardGetTextCommand extends DesktopCommand { command: 'clipboard_get_text'; }
export interface ClipboardSetTextCommand extends DesktopCommand { command: 'clipboard_set_text'; text: string; }

export interface DesktopReply { success: boolean; msg: string; }
export interface WindowInfo {
    windowId: string; title: string; processId: number; processName: string; bounds: WindowBounds;
    isMinimized: boolean; isMaximized: boolean; isForeground: boolean;
}
export interface WindowActivationResult extends WindowInfo, DesktopReply { }
export interface WindowListReply extends DesktopReply { windows?: WindowInfo[]; }
export interface WindowReply extends DesktopReply, Partial<WindowInfo> { }
export interface ClipboardTextData { hasText: boolean; text: string; }
export interface ClipboardTextWriteResult { msg: string; }
export interface ClipboardGetTextReply extends DesktopReply, Partial<ClipboardTextData> { }
export interface ClipboardSetTextReply extends DesktopReply { }
export interface MouseDoubleClickReply extends DesktopReply { }

export class DesktopCommands
{
    private static native: NativeWindows | undefined;

    private static getNative(): NativeWindows
    {
        return DesktopCommands.native ??= new NativeWindows();
    }

    private static integer(value: number, name: string, min = -2147483648, max = 2147483647): void
    {
        if (!Number.isInteger(value) || value < min || value > max)
            throw new Error(`${name} must be an integer between ${min} and ${max}`);
    }

    private static failed(reply: DesktopReply, error: unknown): void
    {
        // Preserve the new commands' descriptive JSON errors; leave the legacy server boundary alone.
        reply.success = false;
        reply.msg = error instanceof Error ? error.message : String(error);
    }

    static async windowList(cmd: WindowListCommand, reply: WindowListReply): Promise<void>
    {
        try {
            const windows = DesktopCommands.getNative().list();
            Object.assign(reply, { success: true, msg: '', windows });
        }
        catch (error) { DesktopCommands.failed(reply, error); }
    }

    static async windowActivate(cmd: WindowActivateCommand, reply: WindowReply): Promise<void>
    {
        try {
            const result = await DesktopCommands.getNative().activateWindow(cmd.windowId);
            Object.assign(reply, result);
        }
        catch (error) { DesktopCommands.failed(reply, error); }
    }

    static async windowSetBounds(cmd: WindowSetBoundsCommand, reply: WindowReply): Promise<void>
    {
        try {
            DesktopCommands.integer(cmd.x, 'x');
            DesktopCommands.integer(cmd.y, 'y');
            DesktopCommands.integer(cmd.width, 'width', 1);
            DesktopCommands.integer(cmd.height, 'height', 1);
            const result = DesktopCommands.getNative().setWindowBounds(cmd);
            Object.assign(reply, { success: true, msg: '' }, result);
        }
        catch (error) { DesktopCommands.failed(reply, error); }
    }

    static async mouseDoubleClick(cmd: MouseDoubleClickCommand, reply: MouseDoubleClickReply): Promise<void>
    {
        try {
            DesktopCommands.integer(cmd.x, 'x');
            DesktopCommands.integer(cmd.y, 'y');
            DesktopCommands.integer(cmd.delay, 'delay', 0, 10000);
            if (cmd.button !== 'left' && cmd.button !== 'right') throw new Error('button must be left or right');
            DesktopCommands.getNative().moveCursor(cmd.x, cmd.y);
            await delay(30);
            await nut.mouse.doubleClick(cmd.button === 'left' ? nut.Button.LEFT : nut.Button.RIGHT);
            await delay(cmd.delay);
            Object.assign(reply, { success: true, msg: '' });
        }
        catch (error) { DesktopCommands.failed(reply, error); }
    }

    static async clipboardGetText(cmd: ClipboardGetTextCommand, reply: ClipboardGetTextReply): Promise<void>
    {
        try {
            const result = await ClipboardText.getText();
            Object.assign(reply, { success: true, msg: '' }, result);
        }
        catch (error) { DesktopCommands.failed(reply, error); }
    }

    static async clipboardSetText(cmd: ClipboardSetTextCommand, reply: ClipboardSetTextReply): Promise<void>
    {
        try {
            const result = await ClipboardText.setText(cmd.text);
            Object.assign(reply, { success: true, msg: '' }, result);
        }
        catch (error) { DesktopCommands.failed(reply, error); }
    }
}
