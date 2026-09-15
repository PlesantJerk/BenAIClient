import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { ClipboardTextData, ClipboardTextWriteResult } from './desktop-tools.mts';

export interface ClipboardReadRequest { operation: 'get'; }
export interface ClipboardWriteRequest { operation: 'set'; textBase64: string; }
export type ClipboardRequest = ClipboardReadRequest | ClipboardWriteRequest;
export type ClipboardResult<T extends ClipboardRequest> = T extends ClipboardReadRequest ? ClipboardTextData : ClipboardTextWriteResult;

export class ClipboardText
{
    private static script: string = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Windows.Forms
try {
    $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
    if ($request.operation -eq 'get') {
        $hasText = [System.Windows.Forms.Clipboard]::ContainsText([System.Windows.Forms.TextDataFormat]::UnicodeText)
        $text = ''
        if ($hasText) { $text = [System.Windows.Forms.Clipboard]::GetText([System.Windows.Forms.TextDataFormat]::UnicodeText) }
        @{ hasText = [bool]$hasText; text = $text } | ConvertTo-Json -Compress
    }
    elseif ($request.operation -eq 'set') {
        $text = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($request.textBase64))
        if ($text.Length -eq 0) { [System.Windows.Forms.Clipboard]::Clear() }
        else {
            $data = [System.Windows.Forms.DataObject]::new()
            $data.SetText($text, [System.Windows.Forms.TextDataFormat]::UnicodeText)
            [System.Windows.Forms.Clipboard]::SetDataObject($data, $true, 10, 100)
        }
        @{ msg = 'Clipboard text updated.' } | ConvertTo-Json -Compress
    }
    else { throw 'Invalid clipboard operation' }
}
catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }
`;

    static getText(): Promise<ClipboardTextData>
    {
        return ClipboardText.run({ operation: 'get' });
    }

    static setText(text: string): Promise<ClipboardTextWriteResult>
    {
        if (typeof text !== 'string') throw new Error('text must be a string');
        if (text.includes('\0')) throw new Error('Windows clipboard text cannot contain embedded NUL characters');
        return ClipboardText.run({ operation: 'set', textBase64: Buffer.from(text, 'utf8').toString('base64') });
    }

    private static run<T extends ClipboardRequest>(request: T): Promise<ClipboardResult<T>>
    {
        // All user text travels as structured stdin data, never executable script or command-line arguments.
        const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-Command', ClipboardText.script],
            { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
        return ClipboardText.collect(child, request);
    }

    private static collect<T extends ClipboardRequest>(child: ChildProcessWithoutNullStreams, request: T): Promise<ClipboardResult<T>>
    {
        return new Promise<ClipboardResult<T>>((resolve, reject) => {
            const stdout: Buffer[] = [];
            let stderr = '';
            const fail = (error: Error): void => { clearTimeout(timer); child.kill(); reject(error); };
            const timer = setTimeout(() => fail(new Error('Clipboard operation timed out')), 15000);
            child.stdout.on('data', (data: Buffer) => stdout.push(data));
            child.stderr.on('data', (data: Buffer) => { stderr = (stderr + data.toString()).slice(-8000); });
            child.on('error', fail);
            child.stdin.on('error', fail);
            child.on('close', code => {
                clearTimeout(timer);
                if (code !== 0) return reject(new Error(`Clipboard operation failed (${code}): ${stderr}`));
                // Trusted, fixed PowerShell script produces the operation-specific JSON contract.
                try { resolve(JSON.parse(Buffer.concat(stdout).toString('utf8').replace(/^\uFEFF/, '')) as ClipboardResult<T>); }
                catch (error) { reject(error); }
            });
            child.stdin.end(JSON.stringify(request));
        });
    }
}
