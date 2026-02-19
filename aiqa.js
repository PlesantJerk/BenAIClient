const { Server, ServerConfig } = require('./server.js')
const { setTimeout: delay } = require('node:timers/promises');
const readline = require('readline');

const commands = new Map();
console.log('starting server');
var host = new Server(new ServerConfig());

commands.set('cd', (args)=>
    { 
        if (args === '')
            console.log('current dir: ', host.root_dir);
        else
            host.root_dir = args; 
    });

async function on_line_entered(line)
{
    line = line.trim();
    if (line === '') return;
    var idx = line.indexOf(' ');
    var command = (idx > 0 ? line.substring(0,idx) : line).toLowerCase();
    var args = idx > 0 ? line.substring(idx+1) : '';
    var cb = commands.get(command);
    if (cb)
        await cb(args.trim());
    else
        console.log('invalid commmand ', command);
}

const rl = readline.createInterface({input: process.stdin, output: process.stdout, terminal: true});
rl.on('line', on_line_entered);


console.log('polling');
host.StartPolling().then(()=>console.log('done')).catch((r)=>console.log('error:', r));