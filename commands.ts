

const screenshot = require('screenshot-desktop') as typeof import('screenshot-desktop');
const { keyboard, mouse, Point, Button, Key } = require('@nut-tree-fork/nut-js') as typeof import('@nut-tree-fork/nut-js');
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
    await mouse.setPosition(new Point(cmd.x, cmd.y));
}

async function mouseClick(cmd: MouseClickCommand, jref: ReturnData) :Promise<void>
{
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
