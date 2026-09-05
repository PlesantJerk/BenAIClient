const screenshot = require('screenshot-desktop') as typeof import('screenshot-desktop');
const { keyboard, mouse, Point, Button, Key } = require('@nut-tree-fork/nut-js') as typeof import('@nut-tree-fork/nut-js');
const koffi = require('koffi') as typeof import('koffi');

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

async function takeScreenShot(cmd: ScreenShotCommand, jret: ReturnData)
{
    await delay(cmd.delay);
    const image = await screenshot({ format: 'png' });
    jret.image = image.toString('base64');
    jret.success = true;
    jret.msg = '';
}

async function moveMouse(cmd: MouseMoveCommand, jref: ReturnData) :Promise<void>
{
    await mouse.setPosition(new Point(cmd.x/displayScale, cmd.y/displayScale));
}

async function mouseClick(cmd: MouseClickCommand, jref: ReturnData) :Promise<void>
{
    await mouse.setPosition(new Point(cmd.x/displayScale, cmd.y/displayScale));
    await delay(30);
    await mouse.click(cmd.button === 'left' ? Button.LEFT : Button.RIGHT);
    await delay(cmd.delay);    
}

async function keyboardSendText(cmd: KeyboardSendStringCommand, jref: ReturnData) : Promise<void>
{
    await keyboard.type(cmd.text);
}

async function keyboardSendKey(cmd: KeyboardSendKeyCommand, jref: ReturnData) : Promise<void>
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

module.exports = {takeScreenShot, moveMouse, mouseClick, keyboardSendText, keyboardSendKey}
