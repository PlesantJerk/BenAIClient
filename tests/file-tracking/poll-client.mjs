import assert from 'node:assert/strict';
import path from 'node:path';
import {createRequire, registerHooks} from 'node:module';
import {pathToFileURL} from 'node:url';
import {Socket} from 'node:net';

export class PollClient {
    static routes = new Map();
    static pending = new Map();
    static sessions = new Map();
    static nextId = 0;
    static unexpected = 0;
    static muted = [];
    static Server;
    static log = console.log.bind(console);
    static nativePath = process.env.FILE_TRACKER_QA_DEPENDENCIES;

    static install(clientPath) {
        this.installTransport();
        const clientUrl = pathToFileURL(clientPath + path.sep).href;
        const qa = new URL('./poll-stub.mjs',import.meta.url).href;
        const alternate = this.nativePath ? pathToFileURL(path.join(this.nativePath,'server.js')).href : null;
        registerHooks({resolve(specifier, context, next) {
            if (context.parentURL?.startsWith(clientUrl)) {
                if (['./ai-config.mts','./commands.mts','./desktop-tools.mts'].includes(specifier)) {
                    return {url:qa, shortCircuit:true};
                }
                if (alternate && (specifier === 'koffi' || specifier === 'playwright-core' || specifier.startsWith('playwright-core/'))) {
                    try { return next(specifier,context); }
                    catch (error) {
                        if (!['ERR_MODULE_NOT_FOUND','MODULE_NOT_FOUND'].includes(error.code)) throw error;
                        return next(specifier,{...context,parentURL:alternate});
                    }
                }
            }
            return next(specifier,context);
        }});
        this.Server = createRequire(import.meta.url)(path.join(clientPath,'server.js')).Server;
    }

    static installTransport() {
        const self = this;
        globalThis.fetch = async (address, init) => self.fetch(address,init);
        Socket.prototype.connect = function() {
            self.unexpected++;
            throw new Error('QA denied socket connect');
        };
        console.log = (...args) => { if (this.muted.length<2_000) this.muted.push(args); };
        console.error = console.log;
    }

    static async fetch(address,init) {
        const url = new URL(address);
        const id = url.searchParams.get('id');
        if (url.origin === 'https://benai.org' && url.pathname === '/debugger_hook' && init.method === 'get') {
            const key = `${id}|${url.searchParams.get('session_id')}`;
            const route = this.sessions.get(key) ?? this.routes.get(id);
            if (route) {
                this.sessions.set(key,route);
                return {json:()=>route.take()};
            }
        }
        if (url.origin === 'https://benai.org' && url.pathname === '/debugger_reply' && init.method === 'post') {
            const receiver = this.pending.get(id);
            if (receiver) {
                this.pending.delete(id);
                receiver(JSON.parse(init.body));
                return {text:async()=>''};
            }
        }
        this.unexpected++;
        throw new Error('QA denied unmatched fetch');
    }

    constructor(root, label) {
        const email = `offline-${label}@example.invalid`;
        PollClient.routes.set(email,this);
        this.server = new PollClient.Server({root_dir:root,conversation_location:root,email,client_name:`qa-${label}`});
        void this.server.StartPolling();
    }

    requests = [];
    awake = null;
    async take() {
        while (!this.requests.length) await new Promise(resolve => { this.awake=resolve; });
        return this.requests.splice(0);
    }

    async command(command, payload = {}, ms = 90_000) {
        const id = String(++PollClient.nextId);
        return new Promise((resolve,reject) => {
            const timer=setTimeout(() => {
                PollClient.pending.delete(id);
                reject(new Error(`No native reply for ${command} before ${ms} ms`));
            },ms);
            PollClient.pending.set(id, v => { clearTimeout(timer); resolve(v); });
            this.requests.push({command, id, ...payload});
            this.awake?.();
        });
    }

    async openShell() {
        const receipt = await this.command('create_shell_session');
        assert.equal(receipt.success,true,'native shell create');
        assert.ok(receipt.session_id,'native shell ID');
        return receipt.session_id;
    }

    async shell(id, command_line, sentinel) {
        const receipt = await this.command('send_command_to_console_shell',{session_id:id,command_line,wait_time_in_ms:700});
        assert.equal(receipt.success,true,'native shell command');
        if (!sentinel) return receipt.console_output;
        let output = receipt.console_output;
        for (let i=0;i<25;i++) {
            if (output.split(/\r?\n/).some(line=>line.trim()===sentinel)) return output;
            const read = await this.command('read_screen_from_console_shell',{session_id:id,number_of_lines:100,wait_time_in_ms:250});
            assert.equal(read.success,true,'native shell poll');
            output=read.console_output;
        }
        assert.fail('native shell did not complete the command chain');
    }
}
