const { spawn } = require('child_process');
const {TempCache} = require('./temp-cache.js')

class ConsoleShell
{
    #session_id_generator = 1;
    #session_cache;

    constructor()
    {
        this.#session_cache = new TempCache();
    }

    CreateShell()
    {
        var ret = new ConsoleShellSession(this.#session_id_generator);
        this.#session_id_generator++;
        this.#session_cache.set(ret.session_id, ret);
        return ret;
    }

    GetSession(iSessionId)
    {
        return this.#session_cache.get(iSessionId);
    }
}

class ConsoleShellSession
{
    #session_id;
    #process = null;
    #error = null;
    #out_buffer = [];    
    max_buffer_size = 10;

    constructor(session_id)
    {
        this.#session_id = session_id;
        this.#process = spawn("cmd.exe", [], { shell: false });        
        this.#process.stdout.on('data', this.#on_out.bind(this));
        this.#process.stderr.on('data', this.#on_err.bind(this));
        this.#process.on('close', this.#on_close.bind(this));
        this.#process.on('error', this.#on_error.bind(this));
    }

    remove()
    {
        this.Terminate();
    }

    #on_out(data)
    {
        this.#out_buffer.push(data);
        var overflow = this.#out_buffer.length - this.max_buffer_size;
        if (overflow > 0)
        {
            this.#out_buffer = this.#out_buffer.slice(overflow+this.max_buffer_size/2, this.#out_buffer.length)
        }
    }

    #on_err(data)
    {
        this.#out_buffer.push(data);
    }

    
    #on_close(code)
    {
        this.#process = null;    
    }

    #on_error(err)
    {
        this.#error = err;
        this.#process = null;
    }

    GetStdOut()
    {
        return this.#out_buffer.join("");
    }    

    SendCommand(sCmd)
    {
        if (this.#process)
            this.#process.stdin.write(sCmd + "\n");
        else
            throw new Error("Process is not running");
    }

    Terminate()
    {
        if (this.#process != null)
            this.#process.kill();
    }

    get is_running()
    {
        return this.#process !== null;
    }

    get session_id()
    {
        return this.#session_id;
    }

    get error()
    {
        return this.#error;
    }
}

module.exports = {ConsoleShell, ConsoleShellSession};