import { spawn } from 'node:child_process';
import path from 'node:path';

export interface McpAuthorizationUrlCommand {
    id: string;
    command: 'mcp_open_authorization_url';
    url: string;
}
export interface McpAuthorizationUrlReply { success: boolean; msg: string; }
export type AuthorizationUrlOpener = (url: string) => Promise<void>;
interface BrowserLaunch { executable: string; args: string[]; input?: string; }

/** Opens only the authorization URL. OAuth state, credentials and token exchange belong to the server. */
export class McpAuthorizationCommands {
    private readonly opener: AuthorizationUrlOpener;
    // Never append URL arguments to -Command: PowerShell would parse them as source code.
    private static readonly windowsScript = "$ErrorActionPreference = 'Stop'; "
        + '[Console]::InputEncoding = [System.Text.Encoding]::UTF8; '
        + 'Start-Process -FilePath ([Console]::In.ReadToEnd())';

    constructor(opener?: AuthorizationUrlOpener) {
        this.opener = opener ?? this.openBrowser.bind(this);
    }

    async openAuthorizationUrl(command: McpAuthorizationUrlCommand, reply: McpAuthorizationUrlReply): Promise<void> {
        if (!this.isWebUrl(command.url)) {
            Object.assign(reply, { success: false, msg: 'url must be an absolute HTTP(S) URL without credentials or whitespace.' });
            return;
        }
        try {
            await this.opener(command.url);
            // Success confirms launcher completion, not consent, login or authorization completion.
            Object.assign(reply, { success: true, msg: '' });
        } catch (error) {
            // Only our controlled diagnostic is safe. Never echo arbitrary error.message, URL or stderr.
            const reason = error instanceof BrowserLaunchFailure ? ` (${error.reason})` : '';
            Object.assign(reply, { success: false, msg: `Unable to open the authorization URL with the system browser${reason}.` });
        }
    }


    private isWebUrl(value: unknown): value is string {
        if (typeof value !== 'string' || !/^https?:\/\//i.test(value) || /[\u0000-\u0020\u007f]/.test(value)) return false;
        try {
            const url = new URL(value);
            return (url.protocol === 'http:' || url.protocol === 'https:') && !!url.hostname && !url.username && !url.password;
        } catch { return false; }
    }

    private browserLaunch(url: string): BrowserLaunch {
        switch (process.platform) {
            case 'win32': return {
                executable: path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
                args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', McpAuthorizationCommands.windowsScript],
                input: url
            };
            case 'darwin': return { executable: '/usr/bin/open', args: [url] };
            case 'linux': return { executable: 'xdg-open', args: [url] };
            default: throw new BrowserLaunchFailure('unsupported_platform');
        }
    }

    private async openBrowser(url: string): Promise<void> {
        const launch = this.browserLaunch(url);
        await new Promise<void>((resolve, reject) => {
            const child = spawn(launch.executable, launch.args, {
                shell: false, windowsHide: true, timeout: 15000,
                stdio: [launch.input === undefined ? 'ignore' : 'pipe', 'ignore', 'ignore']
            });
            child.once('error', error => reject(new BrowserLaunchFailure(
                (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'executable_missing' :
                (error as NodeJS.ErrnoException).code === 'EACCES' ? 'permission_denied' : 'launch_error')));
            child.once('close', (code, signal) => code === 0 ? resolve() : reject(new BrowserLaunchFailure(
                signal ? 'timeout_or_termination' : `exit_code_${code ?? 'unknown'}`)));
            if (launch.input !== undefined) {
                child.stdin!.once('error', () => reject(new BrowserLaunchFailure('launcher_input_failed')));
                child.stdin!.end(launch.input, 'utf8');
            }
        });
    }
}

class BrowserLaunchFailure extends Error {
    readonly reason: string;
    constructor(reason: string) { super('Browser launcher failed.'); this.reason = reason; }
}
