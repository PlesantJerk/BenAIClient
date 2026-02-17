

class Server
{
    #fsys = require('fs')
    #commands
    #sEmail
    constructor(config)
    {
        this.#sEmail = config.email;
        this.#commands = new Map();
        this.#commands.set("select_new_directory", this.#selectNewDirectory.bind(this));
        this.#commands.set("get_directories", this.#GetDirectories.bind(this));
        this.#commands.set("get_files", this.#GetFiles.bind(this));
        
    }

    root_dir = 'd:\\';

    
    async #selectNewDirectory(sJson, jRet)
    {
        console.log(`You got select_new_dir for ${sJson.id}`);        
    }

    async #GetDirectories(sJson, jRet)
    {
        var fd = this.#fsys.readdirSync(this.root_dir, { withFileTypes: true });
        var dirs = [];
        for(var entry of fd)
        {
            if (entry.isDirectory())
            {
                dirs.push(entry.name);
            }
        }
        jRet.directories = dirs;
    }

    async #GetFiles(sJson, jRet)
    {
        var fd = this.#fsys.readdirSync(this.root_dir, { withFileTypes: true });
        var files = [];
        for(var entry of fd)
        {
            if (entry.isFile())
            {
                files.push(entry.name);
            }
        }
        jRet.files = files;
    }

    async Poll()
    {        
        var resp = await fetch(`https://benai.org/debugger_hook?id=${this.#sEmail}`, { method: 'get' });        
        var req = await resp.json();        
        for(var cmd of req)
        {
            console.log('incomming command: ', cmd);
            var cb = this.#commands.get(cmd.command);
            if (cb != null)
            {
                var jret = { success: true, msg: ""};
                try
                {
                    await cb(cmd, jret);                    
                }
                catch(err)
                {
                    console.error('failed to invoke function: ', err.stack || err)
                    jret.success = false;
                    jret.msg = JSON.stringify(err);                    
                }
                await this.Reply(cmd.id, jret);
            }
        }
    }

    async Reply(sId, payload = {})
    {
        if (payload == null) payload = {};
        var resp = await fetch(`https://benai.org/debugger_reply?id=${sId}`, { method: 'post', body: JSON.stringify(payload)})
        var text = await resp.text();
    }
}

module.exports = { Server }

console.log('starting server');
var s = new Server({ email: 'blicht10069@gmail.com'});
console.log('polling');
s.Poll().then(()=>console.log('done')).catch((r)=>console.log('error:', r));

