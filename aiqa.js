const fsp = require('fs').promises;
const { Server, ServerConfig } = require('./server.js')
const { setTimeout: delay } = require('node:timers/promises');
const readline = require('readline');

const commands = new Map();


(
    async ()=>
    {
        const rl = readline.createInterface({input: process.stdin, output: process.stdout, terminal: true});
        var config_file = await fsp.readFile('./config.json', 'utf-8');
        const host_config = JSON.parse(config_file);
        if (host_config.email === '' || host_config.email == null)
        {   
            var block =true;     
            rl.question("please supply a user_id: ", async (line)=>
            {
                host_config.email = line.trim();
                await fsp.writeFile('./config.json', JSON.stringify(host_config), 'utf-8');
                block = false;
            });
            while(block)
            {
                await delay(250);
            }
        }
        console.log('starting server');
        var host = new Server(host_config);
        console.log('polling');
        commands.set('cd', async (args)=>
            { 
                if (args === '')
                    console.log('current dir: ', host.root_dir);
                else
                {
                    host.root_dir = args; 
                    host_config.root_dir = args;
                    await fsp.writeFile('./config.json', JSON.stringify(host_config), 'utf-8');
                }
            });

        
        rl.on('line', on_line_entered);

        host.StartPolling().then(()=>console.log('done')).catch((r)=>console.log('error:', r));
    }
)();


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



