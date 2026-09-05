//import screenshot from 'screenshot-desktop';
const screenshot = require('screenshot-desktop') as typeof import('screenshot-desktop');

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

module.exports = {takeScreenShot}