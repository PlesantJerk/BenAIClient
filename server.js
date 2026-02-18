const fsp = require('fs').promises;
const fsys = require('fs')
const psys = require('path')
const { exec: exe_launcher } = require('child_process');
const util = require('util');
const startProcessAsync = util.promisify(exe_launcher);
const { FindInFile } = require('./find-in-files.js');

class Server
{    
    #commands
    #sEmail
    conversation_location = '.';
    root_dir = '.';

    constructor(config)
    {
        this.#sEmail = config.email;
        this.root_dir = config.root_dir;
        this.conversation_location = config.conversation_location;
        this.#commands = new Map();
        this.#commands.set("select_new_directory", this.#selectNewDirectory.bind(this));
        this.#commands.set("get_directories", this.#GetDirectories.bind(this));
        this.#commands.set("get_files", this.#GetFiles.bind(this));
        this.#commands.set("read_file", this.#ReadFile.bind(this));
        this.#commands.set("write_file", this.#WriteFile.bind(this));
        this.#commands.set("create_directory", this.#CreateDirectory.bind(this));
        this.#commands.set("record_message", this.#RecordMessage.bind(this));
        this.#commands.set("load_messages", this.#LoadMessages.bind(this));
        this.#commands.set("get_virtual_directory_location", (sJson, jRet)=>{ jRet.virtual_directory = this.root_dir; });
        this.#commands.set("execute_powershell", this.#RunPowerShellScript.bind(this));
        this.#commands.set("find_in_files", this.#SearchFiles.bind(this));
    }

    async StartPolling()
    {
        while(true)
        {
            await this.#Poll();
        }
    }

    async #SearchFiles(sJson, jRet)
    {
        var ff = new FindInFile(sJson);
        var sPath = this.#MapPath(sJson.path);
        jRet.found_files = await ff.Search(sPath);        
    }

    async #Poll()
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

    #MapPath(sPath)
    {
        return psys.join(this.root_dir, sPath);
    }

    #fileExists(sFileName)
    {
        try
        {
            fsys.accessSync(sFileName, fsp.constants.F_OK);            
            return true;
        }
        catch { return false; }
    }

    #directoryExists(sPath)
    {
        try
        {
            var stat = fsys.statSync(sPath);
            return stat.isDirectory();
        }
        catch { return false; }
    }    

    async #RunPowerShellScript(sJson, jRet)
    {
        if (sJson.ps1_file == null)
        {
            jRet.success = false;
            jRet.msg = "Filename (ps1_file) must be supplied"
        }
        else
        {
            try
            {
                var sFileName = this.#MapPath(sJson.ps1_file);
                var timeout = sJson.time_out ?? 60000;
                var args = sJson.args ?? "";
                const { stdout, stderr } = await startProcessAsync('powershell.exe ' + sFileName + " " + args,
                    { timeout: timeout, killSignal: 'SIGTERM'});
                jRet.stdout = stdout;
                jRet.stderr = stderr;
            }
            catch(err)
            {
                jRet.success = false;
                if (err.killed === true)
                {
                    jRet.msg = "script timed out prior to completion";
                }
                else
                {
                    jRet.msg = err.message;
                }
                jRet.stdout = err.stdout;
                jRet.stderr = err.stderr;
            }
        }
    }

    async #RecordMessage(sJson, jRet)
    {
        var payload = JSON.parse(sJson.payload)
        if (payload.conversation_id > 0)
        {
            var p = psys.join(this.conversation_location, payload.conversation_id.toString());
            var fname = BigInt(Date.now());
            var fileName = psys.join(p, fname + '.json');
            if (!this.#directoryExists(p))
                fsys.mkdirSync(p);
            await fsp.writeFile(fileName, JSON.stringify(payload), 'utf-8');
        }
    }

    async #LoadMessages(sJson, jRet)
    {
        var conversation_id = sJson.conversation_id;
        if (conversation_id < 0)
        {
            jRet.success = false;
            jRet.msg = "Invalid conversation id";
        }
        else
        {
            var p = psys.join(this.conversation_location, conversation_id.toString());
            if (!this.#directoryExists(p))
            {
                jRet.success =false;
                jRet.msg = "conversation id not found."
            }
            else
            {
                var files = this.#GetFilesFromPath(p, true);
                files.sort();
                var json_payload = [];
                for(var name of files)
                {                    
                    var content = await fsp.readFile(psys.join(name), 'utf-8');
                    json_payload.push(JSON.parse(content));
                }
                jRet.messages = json_payload;
            }
        }
    }

    async #WriteFile(sJson, jRet)
    {
        var localFile = this.#MapPath(sJson.file_name);        
        await fsp.writeFile(localFile, sJson.content, 'utf-8');
    }

    #CreateDirectory(sJson, jRet)
    {
        var localDir = this.#MapPath(sJson.dir_name);    
        fsys.mkdirSync(localDir, {recursive: true});
    }

    async #ReadFile(sJson, jRet)
    {
        var localFile = this.#MapPath(sJson.file_name);
        if (!this.#fileExists(localFile))
        {
            jRet.success = false;
            jRet.msg = `file ${sJson.file_name} not found.`;
        }
        else
        {                        
            jRet.msg = await fsp.readFile(localFile, 'utf-8');
        }
    }

    async #selectNewDirectory(sJson, jRet)
    {
        console.log(`You got select_new_dir for ${sJson.id}`);        
    }

    async #GetDirectories(sJson, jRet)
    {
        var sPath = psys.join(this.root_dir, sJson.path);        
        jRet.directories = this.#GetDirectories(sPath);
    }

    #GetDirectoriesFromPath(sPath)
    {        
        var fd = fsys.readdirSync(sPath, { withFileTypes: true });
        var ret = [];
        for(var entry of fd)
        {
            if (entry.isDirectory())
            {
                ret.push(entry.name);
            }
        }
        return ret;
    }

    async #GetFiles(sJson, jRet)
    {
        var sPath = psys.join(this.root_dir, sJson.path);
        jRet.files = this.#GetFilesFromPath(sPath);        
    }

    #GetFilesFromPath(sPath, bUseFullPath=false)
    {
        var fd = fsys.readdirSync(sPath, { withFileTypes: true });
        var ret = [];
        for(var entry of fd)
        {
            if (entry.isFile())
            {
                if (bUseFullPath)
                    ret.push(psys.join(entry.path, entry.name));
                else
                    ret.push(entry.name);
            }
        }
        return ret;
    }
    
    async Reply(sId, payload = {})
    {
        if (payload == null) payload = {};
        var resp = await fetch(`https://benai.org/debugger_reply?id=${sId}`, { method: 'post', body: JSON.stringify(payload)})
        var text = await resp.text();
    }

    CD(sPath)
    {
        var localDir = this.#MapPath(sPath);    
        fsys.mkdirSync(localDir, { recursive: true });
    }
}

class ServerConfig
{
    email = 'blicht10069@gmail.com';
    root_dir = 'D:\\code\\git\\Phone\\ChatAblaze\\LLMAccess';
    conversation_location = 'd:\\temp\\conversations'
}

module.exports = { Server, ServerConfig }


console.log('starting server');
var s = new Server(new ServerConfig());
console.log('polling');
s.StartPolling().then(()=>console.log('done')).catch((r)=>console.log('error:', r));




