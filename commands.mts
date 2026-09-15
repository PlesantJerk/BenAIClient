import screenshot from 'screenshot-desktop';
import { keyboard, mouse, Point, Button, Key } from '@nut-tree-fork/nut-js';
import koffi from 'koffi';

const user32 = koffi.load('user32.dll');
const shcore = koffi.load('shcore.dll');

const monitorFromWindow = user32.func(
    'void * __stdcall MonitorFromWindow(void *hwnd, uint32_t flags)'
);

const getScaleFactorForMonitor = shcore.func(
    'int32_t __stdcall GetScaleFactorForMonitor(void *monitor, _Out_ int32_t *scale)'
);

type KeyValue = import('@nut-tree-fork/nut-js').Key;
type Command = {
    id: string,
    command: string,
}

type ReturnData = {
    success: boolean,
    msg: string,
    [key: string] : any
}

type ScreenShotCommand = Command & {
    delay: number
}

type MouseMoveCommand = Command & {
    x: number,
    y: number
}

type MouseClickCommand = Command & {
    button: 'left'|'right',
    x: number,
    y: number,
    delay: number;
}

type KeyboardSendStringCommand = Command & {
    text: string
}

type KeyboardSendKeyCommand = Command & {
    ctrlKey: boolean,
    altKey: boolean,
    shiftKey: boolean,
    key: string
}

function getPrimaryDisplayScale(): number
{
    const MONITOR_DEFAULTTOPRIMARY = 1;
    const monitor = monitorFromWindow(null, MONITOR_DEFAULTTOPRIMARY);
    if (!monitor)
        throw new Error('Could not locate the primary monitor');

    const scale = [0];
    const result = getScaleFactorForMonitor(monitor, scale);
    if (result !== 0 || scale[0] <= 0)
        throw new Error(`Could not read display scale: ${result}`);

    return scale[0] / 100;
}

const displayScale = getPrimaryDisplayScale();

async function  delay(time: number) : Promise<void>
{
    let cb : ()=>void;
    const wait = new Promise((r)=>cb=r as ()=>void);    
    setTimeout(()=>{cb()}, time);
    await wait;
}

export async function takeScreenShot(cmd: ScreenShotCommand, jret: ReturnData)
{
    await delay(cmd.delay);
    const image = await screenshot({ format: 'png' });
    jret.image = image.toString('base64');
    jret.success = true;
    jret.msg = '';
}

export async function moveMouse(cmd: MouseMoveCommand, jref: ReturnData) :Promise<void>
{
    await mouse.setPosition(new Point(cmd.x/displayScale, cmd.y/displayScale));
}

export async function mouseClick(cmd: MouseClickCommand, jref: ReturnData) :Promise<void>
{
    await mouse.setPosition(new Point(cmd.x/displayScale, cmd.y/displayScale));
    await delay(30);
    await mouse.click(cmd.button === 'left' ? Button.LEFT : Button.RIGHT);
    await delay(cmd.delay);    
}

export async function keyboardSendText(cmd: KeyboardSendStringCommand, jref: ReturnData) : Promise<void>
{
    keyboard.config.autoDelayMs = 10;
    await keyboard.type(cmd.text);
}

export async function keyboardSendKey(cmd: KeyboardSendKeyCommand, jref: ReturnData) : Promise<void>
{    
    const keys: KeyValue[] = [];
    if (cmd.ctrlKey) keys.push(Key.LeftControl);
    if (cmd.altKey) keys.push(Key.LeftAlt);
    if (cmd.shiftKey) keys.push(Key.LeftShift);
    const keyName : keyof typeof Key=(cmd.key as keyof typeof Key);
    if (keyName === undefined) {
        jref.success = false;
        jref.msg = 'invalid key: ' + cmd.key;        
    }
    else
    {
        try
        {
            keys.push(Key[keyName]);
            await keyboard.pressKey(...keys);
            await delay(40);
        }
        finally {
            await keyboard.releaseKey(...keys);
        }
    }
}

type MouseScrollCommand = MouseMoveCommand & {
    direction: 'up' | 'down' | 'left' | 'right',
    amount: number,
    delay: number
}

type MouseDragCommand = Command & {
    startX: number,
    startY: number,
    endX: number,
    endY: number,
    duration: number,
    delay: number
}

export class DesktopActions
{
    static requireInteger(value: number, name: string, min: number, max: number): void
    {
        if (!Number.isInteger(value) || value < min || value > max)
            throw new Error(`${name} must be an integer between ${min} and ${max}`);
    }

    static validatePoint(x: number, y: number): void
    {
        DesktopActions.requireInteger(x, 'x', -2147483648, 2147483647);
        DesktopActions.requireInteger(y, 'y', -2147483648, 2147483647);
    }

    static async scroll(cmd: MouseScrollCommand, jret: ReturnData): Promise<void>
    {
        DesktopActions.validatePoint(cmd.x, cmd.y);
        DesktopActions.requireInteger(cmd.amount, 'amount', 1, 10000);
        DesktopActions.requireInteger(cmd.delay, 'delay', 0, 10000);
        const actions = { up: () => mouse.scrollUp(cmd.amount), down: () => mouse.scrollDown(cmd.amount),
            left: () => mouse.scrollLeft(cmd.amount), right: () => mouse.scrollRight(cmd.amount) };
        if (!Object.prototype.hasOwnProperty.call(actions, cmd.direction))
            throw new Error('direction must be up, down, left, or right');
        await mouse.setPosition(new Point(cmd.x / displayScale, cmd.y / displayScale));
        await delay(30);
        await actions[cmd.direction]();
        await delay(cmd.delay);
    }

    static async drag(cmd: MouseDragCommand, jret: ReturnData): Promise<void>
    {
        DesktopActions.validatePoint(cmd.startX, cmd.startY);
        DesktopActions.validatePoint(cmd.endX, cmd.endY);
        DesktopActions.requireInteger(cmd.duration, 'duration', 100, 10000);
        DesktopActions.requireInteger(cmd.delay, 'delay', 0, 10000);
        await mouse.setPosition(new Point(cmd.startX / displayScale, cmd.startY / displayScale));
        await delay(30);
        try {
            await mouse.pressButton(Button.LEFT);
            await delay(100);
            await DesktopActions.dragPath(cmd);
            await delay(100);
        }
        finally { await mouse.releaseButton(Button.LEFT); }
        await delay(cmd.delay);
    }

    private static async dragPath(cmd: MouseDragCommand): Promise<void>
    {
        const steps = Math.max(1, Math.ceil(cmd.duration / 20));
        const startTime = Date.now();
        for (let step = 1; step <= steps; step++) {
            await delay(Math.max(0, startTime + cmd.duration * step / steps - Date.now()));
            const x = cmd.startX + (cmd.endX - cmd.startX) * step / steps;
            const y = cmd.startY + (cmd.endY - cmd.startY) * step / steps;
            await mouse.setPosition(new Point(x / displayScale, y / displayScale));
        }
    }

    static async screenshotToClipboard(cmd: ScreenShotCommand, jret: ReturnData): Promise<void>
    {
        DesktopActions.requireInteger(cmd.delay, 'delay', 0, 10000);
        await delay(cmd.delay);
        const image = await screenshot({ format: 'png' });
        await ClipboardImageWriter.write(image);
        jret.msg = 'Screenshot copied to the Windows clipboard as an image. Paste with Ctrl+V in an application that accepts images.';
    }
}

export class ClipboardImageWriter
{
    // A short-lived STA process publishes a persistent Windows bitmap clipboard format.
    // Image bytes go over stdin, not the command line; no temporary screenshot files.
    private static readonly script = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$stream = $null; $image = $null; $bitmap = $null
try {
    $bytes = [Convert]::FromBase64String([Console]::In.ReadToEnd())
    $stream = [System.IO.MemoryStream]::new($bytes, $false)
    $image = [System.Drawing.Image]::FromStream($stream)
    $bitmap = [System.Drawing.Bitmap]::new($image)
    $data = [System.Windows.Forms.DataObject]::new()
    $data.SetImage($bitmap)
    [System.Windows.Forms.Clipboard]::SetDataObject($data, $true, 10, 100)
    if (-not [System.Windows.Forms.Clipboard]::ContainsImage()) { throw 'Clipboard does not contain an image' }
}
catch { [Console]::Error.WriteLine($_.Exception.ToString()); exit 1 }
finally {
    if ($bitmap) { $bitmap.Dispose() }
    if ($image) { $image.Dispose() }
    if ($stream) { $stream.Dispose() }
}`;

    static async write(image: Buffer): Promise<void>
    {
        const { spawn } = await import('node:child_process');
        const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-Command', ClipboardImageWriter.script],
            { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
        await new Promise<void>((resolve, reject) => {
            let stderr = '';
            const timer = setTimeout(() => {
                child.kill();
                reject(new Error('Timed out copying screenshot to clipboard'));
            }, 15000);
            child.stderr.on('data', data => { stderr = (stderr + data.toString()).slice(-8000); });
            child.on('error', error => { clearTimeout(timer); reject(error); });
            child.stdin.on('error', error => { child.kill(); clearTimeout(timer); reject(error); });
            child.on('close', code => {
                clearTimeout(timer);
                if (code === 0) resolve();
                else reject(new Error(`Clipboard copy failed (${code}): ${stderr}`));
            });
            child.stdin.end(image.toString('base64'));
        });
    }
}

