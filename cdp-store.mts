import { DatabaseSync } from 'node:sqlite';
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CdpContract, CdpContractError, CdpLimits } from './cdp-contract.mts';
import type { CdpTraceSnapshot, CdpTraceEvent, CdpTraceJson, CdpTraceGap, CdpTraceSection, CdpTraceArtifactReference } from './cdp-trace.mts';
import type { CdpClientIdentity, CdpCommand, CdpContext, CdpIdKind, CdpJsonObject, CdpOperation, CdpReceipt, CdpState } from './cdp-contract.mts';

// The embedding harness must verify directory ownership/ACLs. chmod is not Windows ACL proof.
// No default permissive guard: production integration must supply a real policy.
export interface CdpDirectoryGuard { assertPrivateDirectory(directory: string): void; assertPrivateFile?(file:string,fresh:boolean):void; }
export interface CdpStoreFaultInjector { beforeCommit(phase: 'acceptance' | 'dispatchBarrier' | 'outcome' | 'maintenance'): void; }
export interface CdpStoreOptions {
    readonly directory: string;
    readonly clientName: string;
    readonly directoryGuard: CdpDirectoryGuard;
    readonly limits?: CdpLimits;
    readonly clock?: { now(): number; };
    readonly faultInjector?: CdpStoreFaultInjector;
}
export interface CdpReceiptReference {
    readonly accountUserId: string; readonly actorConversationId: string;
    readonly scope: string; readonly idKind: CdpIdKind; readonly id: string;
}
export interface CdpDialogControlMetadata {readonly dialogId:string;readonly pageId:string;readonly originCallId:string|null;readonly originActionId:string|null;}
// Runtime owner reference, never a model/transport field. The owner checks its exact active public Dialog.
export interface CdpDialogControlOwner {assertDialogControl(sessionId:string,pageId:string,dialogId:string):CdpDialogControlMetadata;}
export interface CdpNativeCompletion {
    readonly stage:'native-completion';
    readonly outcome:'returned'|'javascript-error'|'closed';
    readonly observedAtUtc:string;
    readonly sideEffectsMayHaveOccurred:true;
    readonly businessSuccessVerified:false;
    readonly replayAllowed:false;
}
export interface CdpEvidence {
    readonly nativeCompletion?:CdpNativeCompletion;
    readonly dialog?:CdpDialogControlMetadata;
    readonly sessionId?: string;
    readonly pageId?: string;
    readonly artifactIds?: readonly string[];
    readonly pageClose?:{readonly pageId:string;readonly closed:true;};
    readonly destinationTarget?:{readonly elementId:string;readonly documentId:string;readonly frameId:string;};
    readonly watch?: {readonly watchId:string;readonly documentId:string;readonly afterEventId:string;readonly expiresAtUtc:string;};
    readonly target?: {readonly elementId:string;readonly documentId:string;readonly frameId:string;};
    readonly counts?: { readonly pages?: number; readonly nodes?: number; readonly bytes?: number; };
}
export interface CdpJournalEntry {
    readonly reference: CdpReceiptReference;
    readonly callId: string;
    readonly op: CdpOperation;
    readonly sessionId: string | null;
    readonly pageId: string | null;
    readonly owner: CdpContext;
    readonly receipt: CdpReceipt;
    readonly payloadExpired: boolean;
    readonly errorCode: string | null;
    readonly uncertainty: { readonly observedAtUtc: string; readonly code: string; } | null;
    readonly evidence: Readonly<CdpEvidence> | null;
}
export interface CdpAcceptance { readonly isNew: boolean; readonly entry: CdpJournalEntry; }
export interface CdpEventMetadata { readonly kind: 'console' | 'network' | 'dialog' | 'download' | 'lifecycle'; readonly pageId: string | null; readonly actionId: string | null; readonly code: string | null; }
export interface CdpArtifactMetadata {
    readonly artifactId: string; readonly sessionId: string; readonly pageId: string | null;
    readonly kind: 'image' | 'download' | 'observation'; readonly mime: string | null;
    readonly byteLength: number; readonly sha256: string; readonly width: number | null; readonly height: number | null;
}

export interface CdpTraceSnapshotArgs {
    readonly afterEventId:string|null;readonly throughEventId:string|null;readonly include:readonly string[];
    readonly maxEvents:number;readonly maxBytes:number;
}
interface CdpTraceScan {cursor:string;hasMore:boolean;events:CdpTraceEvent[];gaps:CdpTraceGap[];eventBytes:number;scanned:number;}
interface CdpTraceAuxiliary {actions:CdpTraceJson[];references:CdpTraceArtifactReference[];bytes:number;actionsLimited:boolean;referencesLimited:boolean;}
type CdpRow = Record<string, any>;
// Exact selected SQL text columns; preserve CAST-as-TEXT Int64 cursors, never Number coercion.
type CdpTraceEventSqlRow = Record<string, import('node:sqlite').SQLOutputValue> & {seq:string};
type CdpTraceActionSqlRow = Record<string, import('node:sqlite').SQLOutputValue> & {call_id:string;dedup_id:string};

// One owner per directory. All methods are synchronous and transactions contain only bounded SQL/metadata work.
// There is no browser, network, UI input, server registration, or automatic dispatcher in this class.
export class CdpStore {
    readonly #options: CdpStoreOptions;
    readonly #limits: CdpLimits;
    readonly #directory: string;

    readonly #incarnation = randomUUID();
    #db!: DatabaseSync;
    #key!: Buffer;
    #identity!: CdpClientIdentity;
    #leaseAcquired = false;
    #closed = false;
    readonly #existingFiles=new Set<string>();

    constructor(options: CdpStoreOptions) {
        this.#options = Object.freeze({ ...options });
        this.#limits = options.limits ?? new CdpLimits();
        CdpContract.clientName(options.clientName);
        this.#directory = this.#prepareDirectory(options);

        try {
            this.#db = new DatabaseSync(path.join(this.#directory, 'journal.sqlite'));
            this.#configure();
            this.#schema();
            this.#acquireLease();
            this.#verifyFreshFiles();
            this.#loadIdentity(options.clientName);
            this.#recover();
        } catch (error) {
            this.#releaseLease();
            this.#db?.close();
            throw error;
        }
    }

    get clientIdentity(): CdpClientIdentity { this.#ensureOpen(); return this.#identity; }
    get limits(): CdpLimits { return this.#limits; }

    #prepareDirectory(options: CdpStoreOptions): string {
        if (!path.isAbsolute(options.directory) || !options.directoryGuard) throw new CdpContractError('PRIVATE_DIRECTORY_REQUIRED', 'An absolute private directory and explicit directory guard are required.');
        const directory = path.resolve(options.directory);
        fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
        for (let current = directory; ; current = path.dirname(current)) {
            if (fs.lstatSync(current).isSymbolicLink()) throw new CdpContractError('UNSAFE_STORAGE_PATH', 'Store path must not contain symbolic links or junctions.');
            if (path.dirname(current) === current) break;
        }
        options.directoryGuard.assertPrivateDirectory(directory);
        for (const name of ['journal.sqlite', 'journal.sqlite-wal', 'journal.sqlite-shm']) {
            try {
                const file = fs.lstatSync(path.join(directory, name));
                if (file.isSymbolicLink() || !file.isFile() || file.nlink !== 1) throw new CdpContractError('UNSAFE_STORAGE_PATH', 'Store files must be ordinary unaliased files inside the private directory.');
                this.#existingFiles.add(name);options.directoryGuard.assertPrivateFile?.(path.join(directory,name),false);
            } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        }
        return directory;
    }

    #verifyFreshFiles():void {
        for(const name of ['journal.sqlite','journal.sqlite-wal','journal.sqlite-shm']) {
            const file=path.join(this.#directory,name);
            if(fs.existsSync(file))this.#options.directoryGuard.assertPrivateFile?.(file,!this.#existingFiles.has(name));
        }
    }
    #acquireLease(): void {
        this.#transaction('maintenance', () => {
            const owner = this.#db.prepare('SELECT pid,incarnation FROM store_owner WHERE singleton=1').get() as CdpRow | undefined;
            if (owner) {
                CdpContract.integer(owner.pid, 1, 2147483647);
                try { process.kill(owner.pid, 0); throw new CdpContractError('STORE_IN_USE', 'Store already has a live or unverifiable owner.'); }
                catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
            }
            this.#db.prepare('INSERT INTO store_owner VALUES(1,?,?) ON CONFLICT(singleton) DO UPDATE SET pid=excluded.pid,incarnation=excluded.incarnation').run(process.pid, this.#incarnation);
        });
        this.#leaseAcquired = true;
    }

    #releaseLease(): void {
        if (!this.#leaseAcquired) return;
        this.#transaction('maintenance', () => this.#db.prepare('DELETE FROM store_owner WHERE singleton=1 AND incarnation=?').run(this.#incarnation));
        this.#leaseAcquired = false;
    }

    #assertLease(): void {
        if (!this.#leaseAcquired) return;
        const owner = this.#db.prepare('SELECT incarnation FROM store_owner WHERE singleton=1').get() as CdpRow | undefined;
        if (owner?.incarnation !== this.#incarnation) throw new CdpContractError('STORE_OWNER_CHANGED', 'Store process ownership changed.');
    }

    #configure(): void {
        this.#db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL;');
        const mode = this.#db.prepare('PRAGMA journal_mode=WAL').get() as CdpRow;
        const sync = this.#db.prepare('PRAGMA synchronous').get() as CdpRow;
        if (mode.journal_mode !== 'wal' || sync.synchronous !== 2) throw new CdpContractError('DURABILITY_UNAVAILABLE', 'Required WAL/FULL durability is unavailable.');
    }

    #schema(): void {
        const version = this.#db.prepare('PRAGMA user_version').get() as CdpRow;
        if (![0, 1, 2, 3, 4, 5].includes(version.user_version)) throw new CdpContractError('STORE_VERSION', 'Unsupported store schema version.');
        if(version.user_version>0){
            const required=['store_owner','installation','receipts','sessions','pages','events','event_gaps','artifacts'];
            if(version.user_version>=3)required.push('creation_log_policy','session_log_policy');
            if(version.user_version>=4)required.push('watches');
            if(version.user_version>=5)required.push('closed_pages');
            for(const table of required)if(!this.#db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table))throw new CdpContractError('STORE_VERSION','Known journal tables are missing; no repair is permitted.');
            if(version.user_version>=4){const columns=this.#db.prepare('PRAGMA table_info(watches)').all() as CdpRow[];for(const name of ['watch_id','session_id','page_id','call_id','document_id','after_event_id','armed_ms','expires_ms','state','result_json','error_code'])if(!columns.some(column=>column.name===name))throw new CdpContractError('STORE_VERSION','Known watch schema is incomplete; no repair is permitted.');}
        }
        else if((this.#db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").get() as CdpRow).count)throw new CdpContractError('STORE_VERSION','Unversioned nonempty storage is not a new owned journal.');
        if(version.user_version>=5){const columns=this.#db.prepare('PRAGMA table_info(closed_pages)').all();if(!['page_id','verified_ms','call_id'].every(name=>columns.some(column=>column.name===name)))throw new CdpContractError('STORE_VERSION','Known page-close schema is incomplete; no repair is permitted.');}
        this.#db.exec(`BEGIN IMMEDIATE;
            CREATE TABLE IF NOT EXISTS store_owner(singleton INTEGER PRIMARY KEY CHECK(singleton=1), pid INTEGER NOT NULL, incarnation TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS installation(singleton INTEGER PRIMARY KEY CHECK(singleton=1), install_id TEXT NOT NULL, client_name TEXT NOT NULL, hmac_key BLOB NOT NULL);
            CREATE TABLE IF NOT EXISTS receipts(
                account_id TEXT NOT NULL, actor_id TEXT NOT NULL, scope TEXT NOT NULL, id_kind TEXT NOT NULL, dedup_id TEXT NOT NULL,
                call_id TEXT NOT NULL UNIQUE, operation TEXT NOT NULL, context_json TEXT NOT NULL, page_id TEXT,
                server_fingerprint TEXT NOT NULL, local_digest BLOB NOT NULL, state TEXT NOT NULL,
                accepted_ms INTEGER NOT NULL, dispatch_ms INTEGER, completed_ms INTEGER, input_method TEXT,
                error_code TEXT, evidence_json TEXT, expired INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY(account_id,actor_id,scope,id_kind,dedup_id));
            CREATE INDEX IF NOT EXISTS receipts_account ON receipts(account_id);
            CREATE INDEX IF NOT EXISTS receipts_expiry ON receipts(completed_ms) WHERE expired=0;
            CREATE INDEX IF NOT EXISTS receipts_reservation ON receipts(operation,state,scope);
            CREATE TABLE IF NOT EXISTS sessions(session_id TEXT PRIMARY KEY, context_json TEXT NOT NULL, account_id TEXT NOT NULL,
                actor_id TEXT NOT NULL, state TEXT NOT NULL, last_ms INTEGER NOT NULL);
            CREATE INDEX IF NOT EXISTS sessions_account_state ON sessions(account_id,state);
            CREATE TABLE IF NOT EXISTS pages(page_id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(session_id));
            CREATE INDEX IF NOT EXISTS pages_session ON pages(session_id);
            CREATE TABLE IF NOT EXISTS closed_pages(page_id TEXT PRIMARY KEY REFERENCES pages(page_id),verified_ms INTEGER NOT NULL,call_id TEXT NOT NULL REFERENCES receipts(call_id));
            CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES sessions(session_id),
                created_ms INTEGER NOT NULL, metadata_json TEXT NOT NULL, byte_length INTEGER NOT NULL);
            CREATE INDEX IF NOT EXISTS events_session ON events(session_id,seq);
            CREATE TABLE IF NOT EXISTS event_gaps(session_id TEXT PRIMARY KEY, through_seq TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS artifacts(artifact_id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(session_id),
                account_id TEXT NOT NULL, created_ms INTEGER NOT NULL, byte_length INTEGER NOT NULL, metadata_json TEXT NOT NULL);
            CREATE INDEX IF NOT EXISTS artifacts_session ON artifacts(session_id);
            CREATE INDEX IF NOT EXISTS artifacts_account ON artifacts(account_id);
            CREATE TABLE IF NOT EXISTS creation_log_policy(call_id TEXT PRIMARY KEY REFERENCES receipts(call_id), redact_logs INTEGER NOT NULL CHECK(redact_logs IN (0,1)));
            CREATE TABLE IF NOT EXISTS session_log_policy(session_id TEXT PRIMARY KEY REFERENCES sessions(session_id), redact_logs INTEGER NOT NULL CHECK(redact_logs IN (0,1)));
            CREATE TABLE IF NOT EXISTS watches(watch_id TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES sessions(session_id),page_id TEXT NOT NULL REFERENCES pages(page_id),call_id TEXT NOT NULL UNIQUE REFERENCES receipts(call_id),document_id TEXT NOT NULL,after_event_id TEXT NOT NULL,armed_ms INTEGER NOT NULL,expires_ms INTEGER NOT NULL,state TEXT NOT NULL,result_json TEXT,error_code TEXT);
            CREATE INDEX IF NOT EXISTS watches_page ON watches(page_id,state);
            COMMIT;`);
        this.#db.exec('BEGIN IMMEDIATE');
        try {
            const columns = this.#db.prepare('PRAGMA table_info(receipts)').all() as CdpRow[];
            if (!columns.some(column => column.name === 'uncertain_ms')) this.#db.exec('ALTER TABLE receipts ADD COLUMN uncertain_ms INTEGER; ALTER TABLE receipts ADD COLUMN uncertain_code TEXT;');
            this.#db.exec('PRAGMA user_version=5; COMMIT;');
        } catch (error) { this.#db.exec('ROLLBACK'); throw error; }
    }

    #loadIdentity(clientName: string): void {
        this.#transaction('maintenance', () => {
            let row = this.#db.prepare('SELECT install_id,client_name,hmac_key FROM installation WHERE singleton=1').get() as CdpRow | undefined;
            if (!row) {
                this.#db.prepare('INSERT INTO installation VALUES(1,?,?,?)').run(randomUUID(), clientName, randomBytes(32));
                row = this.#db.prepare('SELECT install_id,client_name,hmac_key FROM installation WHERE singleton=1').get() as CdpRow;
            }
            if (row.client_name !== clientName) throw new CdpContractError('CLIENT_BINDING_CONFLICT', 'Store belongs to a different captured client name.');
            CdpContract.uuid(row.install_id);
            this.#key = Buffer.from(row.hmac_key);
            if (this.#key.length !== 32) throw new CdpContractError('STORE_KEY_INVALID', 'Persisted integrity key is invalid.');
            this.#identity = Object.freeze({ clientName, clientInstallId: row.install_id, clientIncarnationId: this.#incarnation, platform: process.platform });
        });
    }

    #recover(): void {
        this.#transaction('maintenance', () => {
            const now = this.#now();
            this.#db.prepare("UPDATE receipts SET state='failedBeforeDispatch',completed_ms=?,error_code='RECOVERED_NOT_DISPATCHED' WHERE state='accepted'").run(now);
            this.#db.prepare("UPDATE receipts SET state='uncertain',completed_ms=?,error_code='RECOVERED_DISPATCH_UNCERTAIN',uncertain_ms=COALESCE(uncertain_ms,?),uncertain_code=COALESCE(uncertain_code,'RECOVERED_DISPATCH_UNCERTAIN') WHERE state='dispatchStarted'").run(now, now);
            this.#db.prepare("UPDATE receipts SET uncertain_ms=COALESCE(uncertain_ms,completed_ms,accepted_ms),uncertain_code=COALESCE(uncertain_code,error_code,'RECOVERED_DISPATCH_UNCERTAIN') WHERE state='uncertain'").run();
            this.#db.prepare("UPDATE watches SET state='expired',error_code='WATCH_RESTART_UNAVAILABLE',result_json=NULL WHERE state='armed'").run();
            this.#db.prepare("UPDATE sessions SET state='orphaned' WHERE state='live'").run();
        });
    }

    accept(value: unknown, dialogOwner?:CdpDialogControlOwner): CdpAcceptance {
        this.#ensureOpen();
        const command = CdpContract.validate(value, this.#limits).cdp;
        if (!CdpContract.isMutation(command.op) || command.context.access !== 'owner') throw new CdpContractError('OWNERSHIP_DENIED', 'Only an owner mutation may enter the dispatch journal.');
        const reference = this.#reference(command);
        return this.#transaction('acceptance', () => {
            const existing = this.#find(reference);
            if (existing) {
                this.#authorize(existing, command.context, false);
                this.#compareDigest(existing, command);
                return Object.freeze({ isNew: false, entry: this.#entry(existing) });
            }
            this.#assertCurrentBinding(command.context);
            this.#checkCapacity(command);
            this.#validateResources(command,dialogOwner);
            const now = this.#now();
            const call = this.#db.prepare('SELECT call_id FROM receipts WHERE call_id=?').get(command.callId);
            if (call) throw new CdpContractError('ID_CONFLICT', 'Call identity is already bound to another receipt.');
            this.#db.prepare(`INSERT INTO receipts(account_id,actor_id,scope,id_kind,dedup_id,call_id,operation,context_json,page_id,
                server_fingerprint,local_digest,state,accepted_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?,'accepted',?)`).run(
                reference.accountUserId, reference.actorConversationId, reference.scope, reference.idKind, reference.id,
                command.callId, command.op, CdpContract.canonical(command.context), command.pageId,
                command.fingerprint!, this.#digest(command), now);
            if(command.op==='HandleDialog')this.#db.prepare('UPDATE receipts SET evidence_json=? WHERE call_id=?').run(CdpContract.canonical({dialog:dialogOwner!.assertDialogControl(command.sessionId!,command.pageId!,command.args.dialogId as string)}),command.callId);
            if (command.op === 'CreateSession') this.#db.prepare('INSERT INTO creation_log_policy VALUES(?,?)').run(command.callId,(command.args.options as CdpJsonObject).redactLogs === false ? 0 : 1);
            return Object.freeze({ isNew: true, entry: this.#entry(this.#required(reference)) });
        });
    }

    #reference(c: CdpCommand): CdpReceiptReference {
        return Object.freeze({ accountUserId: c.context.accountUserId, actorConversationId: c.context.actorConversationId,
            scope: CdpContract.scope(c), idKind: CdpContract.idKind(c), id: CdpContract.dedupId(c) });
    }
    #digest(c: CdpCommand): Buffer {
        const content = { version: 1, op: c.op, context: c.context, sessionId: c.sessionId, pageId: c.pageId,
            idKind: CdpContract.idKind(c), id: CdpContract.dedupId(c), args: c.args };
        return createHmac('sha256', this.#key).update(CdpContract.canonical(content), 'utf8').digest();
    }
    #compareDigest(row: CdpRow, command: CdpCommand): void {
        const existing = Buffer.from(row.local_digest);
        const incoming = this.#digest(command);
        if (row.server_fingerprint !== command.fingerprint || existing.length !== incoming.length || !timingSafeEqual(existing, incoming)) throw new CdpContractError('ID_CONFLICT', 'Dedup identity is already bound to different normalized input.');
    }

    #checkCapacity(c: CdpCommand): void {
        const v = this.#limits.values;
        const account = this.#db.prepare('SELECT COUNT(*) AS count FROM receipts WHERE account_id=?').get(c.context.accountUserId) as CdpRow;
        const client = this.#db.prepare('SELECT COUNT(*) AS count FROM receipts').get() as CdpRow;
        if (account.count >= v.dedupIdsPerAccount || client.count >= v.dedupIdsPerClient) throw new CdpContractError('IDENTITY_CAPACITY', 'Persistent identity capacity is exhausted; existing identities are retained.');
        if (c.op === 'CreateSession') {
            const unresolved = this.#db.prepare("SELECT COUNT(*) AS count FROM receipts WHERE account_id=? AND actor_id=? AND scope='' AND state='uncertain'").get(c.context.accountUserId, c.context.actorConversationId) as CdpRow;
            if (unresolved.count) throw new CdpContractError('INSPECTION_REQUIRED', 'Uncertain creation requires explicit reconciliation before new creation.');
            this.#checkSessionCapacity(c.context);
        }
        if(c.op==='CreateWatch'){
            const active=this.#db.prepare("SELECT COUNT(*) AS count FROM watches WHERE page_id=? AND state='armed' AND expires_ms>?").get(c.pageId!,this.#now()) as CdpRow;
            const pending=this.#db.prepare("SELECT COUNT(*) AS count FROM receipts WHERE page_id=? AND operation='CreateWatch' AND state IN ('accepted','dispatchStarted','uncertain')").get(c.pageId!) as CdpRow;
            if(active.count+pending.count>=v.watchesPerPage)throw new CdpContractError('WATCH_CAPACITY','Per-page active and reserved watch capacity is exhausted.');
        }
        if (c.op === 'CreatePage') {
            const pages = this.#db.prepare('SELECT COUNT(*) AS count FROM pages WHERE session_id=? AND page_id NOT IN (SELECT page_id FROM closed_pages)').get(c.sessionId!) as CdpRow;
            const pending = this.#db.prepare("SELECT COUNT(*) AS count FROM receipts WHERE scope=? AND operation='CreatePage' AND state IN ('accepted','dispatchStarted','uncertain')").get(c.sessionId!) as CdpRow;
            if (pages.count + pending.count >= v.pagesPerSession) throw new CdpContractError('PAGE_CAPACITY', 'Session page capacity is exhausted.');
        }
    }

    #checkSessionCapacity(context: CdpContext): void {
        const sql = `SELECT account_id FROM sessions WHERE state IN ('live','orphaned') UNION ALL
            SELECT account_id FROM receipts WHERE operation='CreateSession' AND state IN ('accepted','dispatchStarted','uncertain')`;
        const client = this.#db.prepare(`SELECT COUNT(*) AS count FROM (${sql})`).get() as CdpRow;
        const account = this.#db.prepare(`SELECT COUNT(*) AS count FROM (${sql}) WHERE account_id=?`).get(context.accountUserId) as CdpRow;
        if (client.count >= this.#limits.values.liveSessionsPerClient || account.count >= this.#limits.values.liveSessionsPerAccount) throw new CdpContractError('SESSION_CAPACITY', 'Live and reserved session capacity is exhausted.');
    }

    #validateResources(c: CdpCommand,dialogOwner?:CdpDialogControlOwner): void {
        if (c.op === 'CreateSession') return;
        const session = this.#session(c.sessionId!, c.context, false);
        if (session.state !== 'live') throw new CdpContractError('SESSION_UNAVAILABLE', 'Session is not live; no replacement or replay is permitted.');
        if (c.pageId) {this.#assertPage(c.pageId,c.sessionId!);this.#assertPageInput(c.pageId,c.op);}
        if(c.op==='HandleDialog'){this.#dialogProof(c.sessionId!,c.pageId!,c.args.dialogId as string,dialogOwner);return;}
        // Cleanup does not reconcile unknown input. Only verified CloseSession completion releases resources.
        if(c.op!=='CloseSession'&&c.op!=='CreateWatch')this.#assertNoUncertainty(c.sessionId!, c.pageId);
    }

    #assertNoUncertainty(scope: string, pageId: string | null): void {
        const unresolved = this.#db.prepare("SELECT COUNT(*) AS count FROM receipts WHERE scope=? AND operation!='CreateWatch' AND state='uncertain' AND (page_id IS NULL OR ? IS NULL OR page_id=?)").get(scope, pageId, pageId) as CdpRow;
        if (unresolved.count) throw new CdpContractError('INSPECTION_REQUIRED', 'Uncertain input requires explicit observation and reconciliation before new input.');
        // No unlock is implemented in groundwork. A receipt read or parent inspection is NOT reconciliation.
    }

    #checkStoredInputGate(row: CdpRow, caller: CdpContext,dialogOwner?:CdpDialogControlOwner): void {
        if (!row.scope) return;
        const session = this.#session(row.scope, caller, false);
        if (session.state !== 'live') throw new CdpContractError('SESSION_UNAVAILABLE', 'Retained session is not live.');
        if (row.page_id) {this.#assertPage(row.page_id,row.scope);this.#assertPageInput(row.page_id,row.operation);}
        if(row.operation==='HandleDialog'){const proof=JSON.parse(row.evidence_json??'{}').dialog;if(!proof)throw new CdpContractError('DIALOG_CONTROL_REQUIRED','Exact active dialog proof is required.');this.#dialogProof(row.scope,row.page_id,proof.dialogId,dialogOwner);return;}
        if(row.operation==='CreateWatch')return;
        if(row.operation!=='CloseSession')this.#assertNoUncertainty(row.scope, row.page_id);
        const busy = this.#db.prepare("SELECT COUNT(*) AS count FROM receipts WHERE scope=? AND operation!='CreateWatch' AND state='dispatchStarted' AND (page_id IS NULL OR ? IS NULL OR page_id=?)").get(row.scope, row.page_id, row.page_id) as CdpRow;
        if (busy.count) throw new CdpContractError('PAGE_BUSY', 'Conflicting input is in flight; no automatic input queue is created.');
    }

    // This is the durable barrier, not browser input. A repeated call throws rather than granting another input.
    // An adapter must perform input ONLY after a fresh successful return, never after a duplicate acceptance.
    markDispatchStarted(reference: CdpReceiptReference, caller: CdpContext, inputMethod: string, evidence: CdpEvidence = {},dialogOwner?:CdpDialogControlOwner): CdpJournalEntry {
        this.#ensureOpen();
        const method = CdpContract.text(inputMethod, 128);
        const safe = this.#evidence(evidence);
        if(Object.keys(safe).some(key=>!['target','destinationTarget','dialog'].includes(key))) throw new CdpContractError('INVALID_EVIDENCE','Dispatch evidence accepts only resolved target identity.');
        return this.#transaction('dispatchBarrier', () => {
            const row = this.#required(reference);
            this.#authorize(row, caller, false); this.#assertCurrentBinding(caller); this.#assertRich(row);
            if (row.state !== 'accepted') throw new CdpContractError('DISPATCH_NOT_GRANTED', 'Receipt cannot grant a fresh dispatch.');
            this.#checkStoredInputGate(row, caller,dialogOwner);
            if(row.operation==='HandleDialog'&&CdpContract.canonical(safe.dialog??null)!==CdpContract.canonical(JSON.parse(row.evidence_json??'{}').dialog??null))throw new CdpContractError('DIALOG_CONTROL_REQUIRED','Barrier dialog identity must match accepted proof.');
            if(row.operation!=='HandleDialog'&&safe.dialog)throw new CdpContractError('INVALID_EVIDENCE','Dialog proof is only valid for HandleDialog.');
            this.#db.prepare("UPDATE receipts SET state='dispatchStarted',dispatch_ms=?,input_method=?,evidence_json=? WHERE call_id=? AND state='accepted'").run(this.#now(), method, Object.keys(safe).length ? CdpContract.canonical(safe) : null, row.call_id);
            return this.#entry(this.#required(reference));
        });
    }

    complete(reference: CdpReceiptReference, caller: CdpContext, evidence: CdpEvidence = {}, errorCode:string|null=null): CdpJournalEntry {
        const safe = this.#evidence(evidence); this.#nullCode(errorCode);
        if(errorCode!==null&&!safe.nativeCompletion)throw new CdpContractError('INVALID_EVIDENCE','Settled failure requires explicit native execution evidence.');
        return this.#transaction('outcome', () => {
            const row = this.#required(reference);
            this.#authorize(row, caller, false); this.#assertCurrentBinding(caller); this.#assertRich(row);
            if (row.state !== 'dispatchStarted' && row.state !== 'uncertain') throw new CdpContractError('INVALID_TRANSITION', 'Authoritative completion requires prior durable dispatch.');
            if(row.operation==='HandleDialog'&&(CdpContract.canonical(safe.dialog??null)!==CdpContract.canonical(JSON.parse(row.evidence_json??'{}').dialog??null)||!safe.dialog))throw new CdpContractError('INVALID_EVIDENCE','Dialog outcome must retain the same exact accepted control identity.');
            if(row.operation!=='HandleDialog'&&safe.dialog)throw new CdpContractError('INVALID_EVIDENCE','Dialog outcome is restricted to its control operation.');
            // A settled failed wrapper retains native proof, but does not certify required resource cleanup.
            if(errorCode===null)this.#applyResourceOutcome(row, safe);
            this.#validateEvidenceArtifacts(row, safe);
            this.#db.prepare("UPDATE receipts SET state='completed',completed_ms=?,evidence_json=?,error_code=? WHERE call_id=?").run(this.#now(), CdpContract.canonical(safe), errorCode, row.call_id);
            return this.#entry(this.#required(reference));
        });
    }

    finishWithoutCompletion(reference: CdpReceiptReference, caller: CdpContext, state: 'failedBeforeDispatch' | 'cancelledBeforeDispatch' | 'uncertain', errorCode: string): CdpJournalEntry {
        if (!['failedBeforeDispatch', 'cancelledBeforeDispatch', 'uncertain'].includes(state)) throw new CdpContractError('INVALID_TRANSITION', 'Unsupported failure transition.');
        CdpContract.token(errorCode, 80);
        if (!/^[A-Z][A-Z0-9_]*$/.test(errorCode)) throw new CdpContractError('INVALID_ERROR_CODE', 'Only nonsecret classified error codes may be retained.');
        return this.#transaction('outcome', () => {
            const row = this.#required(reference);
            this.#authorize(row, caller, false); this.#assertCurrentBinding(caller); this.#assertRich(row);
            if (state === 'uncertain' ? row.state !== 'dispatchStarted' : row.state !== 'accepted') throw new CdpContractError('INVALID_TRANSITION', 'Receipt transition would misstate whether dispatch started.');
            const now = this.#now();
            this.#db.prepare(`UPDATE receipts SET state=?,completed_ms=?,error_code=?,
                uncertain_ms=CASE WHEN ?='uncertain' THEN COALESCE(uncertain_ms,?) ELSE uncertain_ms END,
                uncertain_code=CASE WHEN ?='uncertain' THEN COALESCE(uncertain_code,?) ELSE uncertain_code END WHERE call_id=?`).run(state, now, errorCode, state, now, state, errorCode, row.call_id);
            return this.#entry(this.#required(reference));
        });
    }

    #applyResourceOutcome(row: CdpRow, evidence: CdpEvidence): void {
        if(evidence.pageClose&&row.operation!=='ClosePage')throw new CdpContractError('INVALID_EVIDENCE','Unexpected page-close proof.');
        if (row.operation === 'CreateSession') {
            if (!evidence.sessionId) throw new CdpContractError('INVALID_EVIDENCE', 'Session creation needs its actual session handle.');
            if(this.#db.prepare('SELECT 1 FROM sessions WHERE session_id=?').get(evidence.sessionId))throw new CdpContractError('ID_CONFLICT','Created session identity is already bound; no overwrite or reparenting.');
            this.#db.prepare("INSERT INTO sessions VALUES(?,?,?,?,'live',?)").run(evidence.sessionId, row.context_json, row.account_id, row.actor_id, this.#now());
            const policy = this.#db.prepare('SELECT redact_logs FROM creation_log_policy WHERE call_id=?').get(row.call_id) as CdpRow | undefined;
            this.#db.prepare('INSERT INTO session_log_policy VALUES(?,?)').run(evidence.sessionId, policy?.redact_logs === 0 ? 0 : 1);
            if(evidence.pageId)this.#recordCreatedPage(evidence.sessionId,evidence.pageId,row.call_id);
        } else if (row.operation === 'CreatePage') {
            if (!evidence.pageId || (evidence.sessionId && evidence.sessionId !== row.scope)) throw new CdpContractError('INVALID_EVIDENCE', 'Page creation needs an in-session page handle.');
            this.#recordCreatedPage(row.scope,evidence.pageId,row.call_id);
        } else if(row.operation==='ClosePage'){
            if(!evidence.pageClose||evidence.pageClose.closed!==true||evidence.pageClose.pageId!==row.page_id)throw new CdpContractError('INVALID_EVIDENCE','ClosePage completion requires exact verified owned-page closure.');
            this.#assertPage(row.page_id,row.scope);
            this.#db.prepare('INSERT OR IGNORE INTO closed_pages VALUES(?,?,?)').run(row.page_id,this.#now(),row.call_id);
        } else if(row.operation==='CreateWatch'){
            if(!evidence.watch)throw new CdpContractError('INVALID_EVIDENCE','Installed watch creation needs retained scoped identity.');
            const w=evidence.watch;
            this.#db.prepare("INSERT INTO watches VALUES(?,?,?,?,?,?,?,?,'armed',NULL,NULL)").run(w.watchId,row.scope,row.page_id,row.call_id,w.documentId,w.afterEventId,this.#now(),Date.parse(w.expiresAtUtc));
        } else if(evidence.watch)throw new CdpContractError('INVALID_EVIDENCE','Unexpected watch identity.');
        else if (evidence.sessionId || evidence.pageId) throw new CdpContractError('INVALID_EVIDENCE', 'Unexpected created handles.');
        if (row.scope) this.#db.prepare('UPDATE sessions SET last_ms=?,state=CASE WHEN ?=\'CloseSession\' THEN \'closed\' ELSE state END WHERE session_id=?').run(this.#now(), row.operation, row.scope);
    }

    // Completion checks actual pages plus other reserved creations inside the SAME outcome transaction.
    #recordCreatedPage(sessionId:string,pageId:string,callId:string):void {
        if(this.#db.prepare('SELECT 1 FROM pages WHERE page_id=?').get(pageId))throw new CdpContractError('ID_CONFLICT','Created page identity is already bound; no overwrite or reparenting.');
        const pages=this.#db.prepare('SELECT COUNT(*) AS count FROM pages WHERE session_id=? AND page_id NOT IN (SELECT page_id FROM closed_pages)').get(sessionId) as CdpRow;
        const pending=this.#db.prepare("SELECT COUNT(*) AS count FROM receipts WHERE scope=? AND operation='CreatePage' AND call_id!=? AND state IN ('accepted','dispatchStarted','uncertain')").get(sessionId,callId) as CdpRow;
        if(pages.count+pending.count>=this.#limits.values.pagesPerSession)throw new CdpContractError('PAGE_CAPACITY','Actual and other reserved page capacity is exhausted; completion was not committed.');
        this.#db.prepare('INSERT INTO pages VALUES(?,?)').run(pageId,sessionId);
    }

    #dialogProof(sessionId:string,pageId:string,dialogId:string,owner?:CdpDialogControlOwner):CdpDialogControlMetadata {
        if(!owner)throw new CdpContractError('DIALOG_CONTROL_REQUIRED','Exact current dialog owner reference is required.');
        const proof=owner.assertDialogControl(sessionId,pageId,dialogId);
        if(proof.dialogId!==dialogId||proof.pageId!==pageId)throw new CdpContractError('DIALOG_CONTROL_REQUIRED','Dialog scope changed.');
        if(proof.originCallId){const row=this.#db.prepare('SELECT * FROM receipts WHERE call_id=?').get(proof.originCallId) as CdpRow|undefined;
            if(!row||row.scope!==sessionId||row.page_id!==pageId||row.id_kind!=='action'||row.dedup_id!==proof.originActionId)throw new CdpContractError('DIALOG_CONTROL_REQUIRED','Observed originating action does not match the retained owned page.');}
        return proof;
    }
    #validateEvidenceArtifacts(row: CdpRow, evidence: CdpEvidence): void {
        for (const id of evidence.artifactIds ?? []) {
            const artifact = this.#db.prepare('SELECT session_id,account_id,created_ms FROM artifacts WHERE artifact_id=?').get(id) as CdpRow | undefined;
            const scope = row.scope || evidence.sessionId;
            if (!artifact || artifact.account_id !== row.account_id || artifact.session_id !== scope || artifact.created_ms <= this.#now() - this.#limits.values.evidenceRetentionMs) throw new CdpContractError('ARTIFACT_UNAVAILABLE', 'Receipt artifact reference is unavailable or not in the captured owned session.');
            this.#session(artifact.session_id, CdpContract.context(JSON.parse(row.context_json)), false);
        }
    }

    #evidence(value: CdpEvidence): CdpEvidence {
        const o = CdpContract.object(value); CdpContract.only(o, ['nativeCompletion','dialog', 'sessionId', 'pageId', 'artifactIds', 'counts', 'target', 'watch', 'pageClose', 'destinationTarget']);
        const result: {nativeCompletion?:CdpNativeCompletion;dialog?:CdpDialogControlMetadata;pageClose?:CdpEvidence['pageClose'];destinationTarget?:CdpEvidence['destinationTarget']; watch?: CdpEvidence['watch']; sessionId?: string; pageId?: string; artifactIds?: string[]; counts?: Record<string, number>; target?: {elementId:string;documentId:string;frameId:string;}; } = {};
        if(o.nativeCompletion!==undefined)result.nativeCompletion=this.#nativeCompletion(o.nativeCompletion);
        if(o.dialog!==undefined){const d=CdpContract.object(o.dialog,['dialogId','pageId','originCallId','originActionId']);result.dialog={dialogId:CdpContract.token(d.dialogId),pageId:CdpContract.token(d.pageId),originCallId:d.originCallId===null?null:CdpContract.uuid(d.originCallId),originActionId:CdpContract.nullToken(d.originActionId)};}
        if(o.pageClose!==undefined){const proof=CdpContract.object(o.pageClose,['pageId','closed']);if(proof.closed!==true)throw new CdpContractError('INVALID_EVIDENCE','Only verified page closure is accepted.');result.pageClose={pageId:CdpContract.token(proof.pageId),closed:true};}
        if(o.destinationTarget!==undefined){const t=CdpContract.object(o.destinationTarget,['elementId','documentId','frameId']);result.destinationTarget={elementId:CdpContract.token(t.elementId),documentId:CdpContract.token(t.documentId),frameId:CdpContract.token(t.frameId)};}
        if(o.watch!==undefined){const w=CdpContract.object(o.watch,['watchId','documentId','afterEventId','expiresAtUtc']);const expires=this.#timestamp(w.expiresAtUtc);if(expires<this.#now()-600000||expires>this.#now()+600000)throw new CdpContractError('INVALID_EVIDENCE','Watch expiry is outside its admitted lifetime.');result.watch={watchId:CdpContract.token(w.watchId),documentId:CdpContract.token(w.documentId),afterEventId:CdpContract.eventCursor(w.afterEventId)!,expiresAtUtc:w.expiresAtUtc as string};}
        if(o.target!==undefined) {const t=CdpContract.object(o.target,['elementId','documentId','frameId']);result.target={elementId:CdpContract.token(t.elementId),documentId:CdpContract.token(t.documentId),frameId:CdpContract.token(t.frameId)};}
        if (o.sessionId !== undefined) result.sessionId = CdpContract.token(o.sessionId);
        if (o.pageId !== undefined) result.pageId = CdpContract.token(o.pageId);
        if (o.artifactIds !== undefined) {
            if (!Array.isArray(o.artifactIds) || o.artifactIds.length > 32) throw new CdpContractError('INVALID_EVIDENCE', 'Artifact reference list exceeds its bound.');
            result.artifactIds = o.artifactIds.map(id => CdpContract.token(id));
        }
        if (o.counts !== undefined) {
            const counts = CdpContract.object(o.counts); CdpContract.only(counts, ['pages', 'nodes', 'bytes']); result.counts = {};
            for (const [key, value] of Object.entries(counts)) result.counts[key] = CdpContract.integer(value, 0, Number.MAX_SAFE_INTEGER);
        }
        if (Buffer.byteLength(CdpContract.canonical(result)) > this.#limits.values.nonImageReplyBytes) throw new CdpContractError('EVIDENCE_LIMIT', 'Retained metadata exceeds its byte bound.');
        return CdpContract.freezeJson(result as CdpJsonObject) as CdpEvidence;
    }

    recordNativeCompletion(reference:CdpReceiptReference,caller:CdpContext,evidence:CdpEvidence):CdpJournalEntry {
        const safe=this.#evidence(evidence);
        if(!safe.nativeCompletion)throw new CdpContractError('INVALID_EVIDENCE','A proven native milestone is required.');
        return this.#transaction('outcome',()=>{
            const row=this.#required(reference);this.#authorize(row,caller,false);this.#assertCurrentBinding(caller);this.#assertRich(row);
            if(!['dispatchStarted','uncertain'].includes(row.state))throw new CdpContractError('INVALID_TRANSITION','Native progress requires prior durable dispatch.');
            this.#db.prepare('UPDATE receipts SET evidence_json=? WHERE call_id=?').run(CdpContract.canonical(safe),row.call_id);
            return this.#entry(this.#required(reference));
        });
    }
    #nativeCompletion(value:unknown):CdpNativeCompletion {
        const o=CdpContract.object(value,['stage','outcome','observedAtUtc','sideEffectsMayHaveOccurred','businessSuccessVerified','replayAllowed']);
        this.#timestamp(o.observedAtUtc);
        if(o.stage!=='native-completion'||!['returned','javascript-error','closed'].includes(o.outcome as string)||o.sideEffectsMayHaveOccurred!==true||o.businessSuccessVerified!==false||o.replayAllowed!==false)
            throw new CdpContractError('INVALID_EVIDENCE','Native milestone must not claim business success, replay permission or absence of side effects.');
        return {...o} as unknown as CdpNativeCompletion;
    }

    get(reference: CdpReceiptReference, caller: CdpContext): CdpJournalEntry {
        this.#ensureOpen(); const row = this.#required(reference); this.#authorize(row, caller, true); return this.#entry(row);
    }
    getCall(callId: string, caller: CdpContext): CdpJournalEntry {
        this.#ensureOpen(); CdpContract.uuid(callId);
        const row = this.#db.prepare('SELECT * FROM receipts WHERE call_id=?').get(callId) as CdpRow | undefined;
        if (!row) throw new CdpContractError('NOT_FOUND', 'Retained call is unavailable.');
        this.#authorize(row, caller, true); return this.#entry(row);
    }

    #authorize(row: CdpRow, callerValue: CdpContext, allowParent: boolean): void {
        const caller = CdpContract.context(callerValue);
        const owner = CdpContract.context(JSON.parse(row.context_json));
        const matchingClient = caller.clientName === owner.clientName && caller.clientInstallId === owner.clientInstallId && caller.clientIncarnationId === owner.clientIncarnationId;
        const ownerRead = caller.access === 'owner' && caller.actorConversationId === owner.actorConversationId && caller.parentConversationId === owner.parentConversationId;
        const parentRead = allowParent && caller.access === 'parentInspect' && owner.parentConversationId !== null && caller.actorConversationId === owner.parentConversationId;
        if (caller.accountUserId !== owner.accountUserId || !matchingClient || (!ownerRead && !parentRead)) throw new CdpContractError('OWNERSHIP_DENIED', 'Captured account, actor, parent or client binding does not authorize this record.');
        if (owner.clientName !== this.#identity.clientName || owner.clientInstallId !== this.#identity.clientInstallId) throw new CdpContractError('CLIENT_BINDING_CONFLICT', 'Record is not bound to this installation.');
    }
    #assertCurrentBinding(context: CdpContext): void {
        if (context.clientName !== this.#identity.clientName || context.clientInstallId !== this.#identity.clientInstallId || context.clientIncarnationId !== this.#identity.clientIncarnationId) throw new CdpContractError('CLIENT_BINDING_CONFLICT', 'New input requires the captured current client incarnation.');
    }
    #isExpired(row: CdpRow): boolean {
        const eligible = ['completed', 'failedBeforeDispatch', 'cancelledBeforeDispatch'].includes(row.state);
        return eligible && (row.expired === 1 || (row.completed_ms !== null && row.completed_ms <= this.#now() - this.#limits.values.evidenceRetentionMs));
    }
    #assertRich(row: CdpRow): void { if (this.#isExpired(row)) throw new CdpContractError('IDENTITY_EXPIRED', 'Identity is a retained tombstone, never a fresh dispatch.'); }
    #session(sessionId: string, caller: CdpContext, allowParent: boolean): CdpRow {
        CdpContract.token(sessionId);
        const row = this.#db.prepare('SELECT * FROM sessions WHERE session_id=?').get(sessionId) as CdpRow | undefined;
        if (!row) throw new CdpContractError('NOT_FOUND', 'Retained session is unavailable.');
        this.#authorize(row, caller, allowParent); return row;
    }
    #assertPage(pageId: string, sessionId: string): void {
        const row = this.#db.prepare('SELECT session_id FROM pages WHERE page_id=?').get(pageId) as CdpRow | undefined;
        if (!row || row.session_id !== sessionId) throw new CdpContractError('NOT_FOUND', 'Page is not in the captured session.');
    }

    #assertPageInput(pageId:string,operation:string):void{if(operation!=='ClosePage'&&this.#db.prepare('SELECT page_id FROM closed_pages WHERE page_id=?').get(pageId))throw new CdpContractError('PAGE_UNAVAILABLE','Verified closed page cannot receive new work.');}

    getAction(scope: string, idKind: CdpIdKind, id: string, callerValue: CdpContext): CdpJournalEntry {
        this.#ensureOpen(); const caller = CdpContract.context(callerValue);
        if (scope !== '') CdpContract.token(scope); CdpContract.token(id);
        if (idKind !== 'action' && idKind !== 'creation') throw new CdpContractError('INVALID_WIRE', 'Invalid receipt ID kind.');
        if (caller.access === 'owner') return this.get({accountUserId:caller.accountUserId,actorConversationId:caller.actorConversationId,scope,idKind,id},caller);
        const rows = this.#db.prepare(`SELECT * FROM receipts WHERE account_id=? AND scope=? AND id_kind=? AND dedup_id=?
            AND json_extract(context_json,'$.parentConversationId')=? AND json_extract(context_json,'$.clientName')=?
            AND json_extract(context_json,'$.clientInstallId')=? AND json_extract(context_json,'$.clientIncarnationId')=? LIMIT 2`).all(
                caller.accountUserId,scope,idKind,id,caller.actorConversationId,caller.clientName,caller.clientInstallId,caller.clientIncarnationId) as CdpRow[];
        if (rows.length !== 1) throw new CdpContractError(rows.length ? 'LOOKUP_AMBIGUOUS' : 'NOT_FOUND', 'Use exact original GetCall identity when no unique retained action is authorized.');
        this.#authorize(rows[0],caller,true); return this.#entry(rows[0]);
    }

    /** INTERNAL exact-context observed-page admission. No manufactured input/action receipt. */
    admitObservedPage(sessionId:string,pageId:string,caller:CdpContext):void{
        CdpContract.token(pageId);this.#transaction('outcome',()=>{const session=this.#session(sessionId,caller,false);this.#assertCurrentBinding(caller);if(session.state!=='live')throw new CdpContractError('SESSION_UNAVAILABLE','Observed page requires the live owned session.');this.#recordCreatedPage(sessionId,pageId,'');});
    }
    getPage(sessionId:string,pageId:string,caller:CdpContext):Readonly<{pageId:string;closed:boolean;}>{this.#ensureOpen();this.#session(sessionId,caller,true);this.#assertPage(pageId,sessionId);return Object.freeze({pageId,closed:!!this.#db.prepare('SELECT page_id FROM closed_pages WHERE page_id=?').get(pageId)});}
    // Additive retained inventory reads. Ownership is evaluated here, not reconstructed by browser adapters.
    getSession(sessionId: string, caller: CdpContext): Readonly<{ sessionId: string; state: string; }> {
        this.#ensureOpen(); const row = this.#session(sessionId, caller, true);
        return Object.freeze({ sessionId: row.session_id, state: row.state });
    }
    getSessionLogRedaction(sessionId: string, caller: CdpContext): boolean {
        this.#ensureOpen(); this.#session(sessionId,caller,true);
        const policy = this.#db.prepare('SELECT redact_logs FROM session_log_policy WHERE session_id=?').get(sessionId) as CdpRow | undefined;
        return policy?.redact_logs !== 0;
    }
    listSessions(callerValue: CdpContext, cursor: string | null = null, limit = 20): { items: readonly Readonly<{ sessionId: string; state: string; }>[]; nextCursor: string | null; } {
        this.#ensureOpen(); const caller = CdpContract.context(callerValue);
        if (cursor !== null) CdpContract.token(cursor); CdpContract.integer(limit, 1, 50);
        const actorPredicate = caller.access === 'owner' ? "actor_id=? AND json_extract(context_json,'$.parentConversationId') IS ?" : "json_extract(context_json,'$.parentConversationId')=?";
        const actorValues = caller.access === 'owner' ? [caller.actorConversationId, caller.parentConversationId] : [caller.actorConversationId];
        const rows = this.#db.prepare(`SELECT * FROM sessions WHERE account_id=? AND ${actorPredicate}
            AND json_extract(context_json,'$.clientName')=? AND json_extract(context_json,'$.clientInstallId')=?
            AND json_extract(context_json,'$.clientIncarnationId')=? AND session_id>? ORDER BY session_id LIMIT ?`).all(
                caller.accountUserId, ...actorValues, caller.clientName, caller.clientInstallId, caller.clientIncarnationId, cursor ?? '', limit + 1) as CdpRow[];
        for (const row of rows) this.#authorize(row, caller, true);
        const items = rows.slice(0, limit).map(row => Object.freeze({ sessionId: row.session_id, state: row.state }));
        return Object.freeze({ items: Object.freeze(items), nextCursor: rows.length > limit ? items.at(-1)!.sessionId : null });
    }
    listPages(sessionId: string, caller: CdpContext, cursor: string | null = null, limit = 20): { items: readonly Readonly<{ pageId: string; state:string; }>[]; nextCursor: string | null; } {
        this.#ensureOpen(); this.#session(sessionId, caller, true);
        if (cursor !== null) CdpContract.token(cursor); CdpContract.integer(limit, 1, 50);
        const rows = this.#db.prepare("SELECT p.page_id,CASE WHEN c.page_id IS NULL THEN 'open' ELSE 'closed' END AS state FROM pages p LEFT JOIN closed_pages c ON p.page_id=c.page_id WHERE p.session_id=? AND p.page_id>? ORDER BY p.page_id LIMIT ?").all(sessionId, cursor ?? '', limit + 1) as CdpRow[];
        const items = rows.slice(0, limit).map(row => Object.freeze({ pageId: row.page_id, state:row.state }));
        return Object.freeze({ items: Object.freeze(items), nextCursor: rows.length > limit ? items.at(-1)!.pageId : null });
    }

    appendEvent(sessionId: string, caller: CdpContext, metadata: CdpEventMetadata): string {
        const o = CdpContract.object(metadata, ['kind', 'pageId', 'actionId', 'code']);
        if (!['console', 'network', 'dialog', 'download', 'lifecycle'].includes(o.kind as string)) throw new CdpContractError('INVALID_EVIDENCE', 'Invalid event metadata kind.');
        const safe = { kind: o.kind, pageId: CdpContract.nullToken(o.pageId), actionId: CdpContract.nullToken(o.actionId), code: this.#nullCode(o.code) };
        const json = CdpContract.canonical(safe); const bytes = Buffer.byteLength(json);
        if (bytes > this.#limits.values.eventBytesPerSession) throw new CdpContractError('EVENT_CAPACITY', 'Event metadata exceeds its byte budget.');
        return this.#transaction('maintenance', () => {
            this.#session(sessionId, caller, false); this.#assertCurrentBinding(caller);
            if (safe.pageId) this.#assertPage(safe.pageId, sessionId);
            this.#db.prepare('INSERT INTO events(session_id,created_ms,metadata_json,byte_length) VALUES(?,?,?,?)').run(sessionId, this.#now(), json, bytes);
            const inserted = this.#db.prepare('SELECT CAST(last_insert_rowid() AS TEXT) AS seq').get() as CdpRow;
            this.#trimEvents(sessionId);
            return inserted.seq;
        });
    }

    #nullCode(value: unknown): string | null {
        if (value === null) return null;
        const code = CdpContract.token(value, 80);
        if (!/^[A-Z][A-Z0-9_]*$/.test(code)) throw new CdpContractError('INVALID_EVIDENCE', 'Metadata code must be classified and nonsecret.');
        return code;
    }
    #trimEvents(sessionId: string): void {
        let total = this.#db.prepare('SELECT COUNT(*) AS count,COALESCE(SUM(byte_length),0) AS bytes FROM events WHERE session_id=?').get(sessionId) as CdpRow;
        while (total.count > this.#limits.values.eventsPerSession || total.bytes > this.#limits.values.eventBytesPerSession) {
            const oldest = this.#db.prepare('SELECT CAST(seq AS TEXT) AS seq,byte_length FROM events WHERE session_id=? ORDER BY events.seq LIMIT 1').get(sessionId) as CdpRow;
            this.#rememberGap(sessionId, oldest.seq);
            this.#db.prepare('DELETE FROM events WHERE seq=CAST(? AS INTEGER)').run(oldest.seq);
            total = { count: total.count - 1, bytes: total.bytes - oldest.byte_length };
        }
    }
    #rememberGap(sessionId: string, through: string): void {
        this.#db.prepare(`INSERT INTO event_gaps VALUES(?,?) ON CONFLICT(session_id) DO UPDATE SET
            through_seq=CASE WHEN CAST(excluded.through_seq AS INTEGER)>CAST(through_seq AS INTEGER) THEN excluded.through_seq ELSE through_seq END`).run(sessionId, through);
    }
    readEvents(sessionId: string, caller: CdpContext, after = '0', limit = 50): { events: readonly Readonly<CdpJsonObject>[]; nextCursor: string; gap: boolean; earliestCursor: string | null; } {
        this.#ensureOpen(); this.#session(sessionId, caller, true); this.#cursor(after); CdpContract.integer(limit, 1, 50);
        const cutoff = this.#now() - this.#limits.values.evidenceRetentionMs;
        const rows = this.#db.prepare('SELECT CAST(seq AS TEXT) AS seq,metadata_json FROM events WHERE session_id=? AND seq>CAST(? AS INTEGER) AND created_ms>? ORDER BY events.seq LIMIT ?').all(sessionId, after, cutoff, limit) as CdpRow[];
        const gap = this.#db.prepare('SELECT through_seq FROM event_gaps WHERE session_id=?').get(sessionId) as CdpRow | undefined;
        const aged = this.#db.prepare('SELECT CAST(MAX(seq) AS TEXT) AS seq FROM events WHERE session_id=? AND created_ms<=?').get(sessionId, cutoff) as CdpRow;
        const through = [gap?.through_seq, aged.seq].filter(Boolean).reduce((a, b) => BigInt(a) > BigInt(b) ? a : b, '0');
        const earliest = this.#db.prepare('SELECT CAST(MIN(seq) AS TEXT) AS seq FROM events WHERE session_id=? AND created_ms>?').get(sessionId, cutoff) as CdpRow;
        return Object.freeze({ events: Object.freeze(rows.map(row => CdpContract.freezeJson({ cursor: row.seq, metadata: JSON.parse(row.metadata_json) }))),
            nextCursor: rows.at(-1)?.seq ?? after, gap: BigInt(after) < BigInt(through), earliestCursor: earliest.seq });
    }
    #cursor(value: string): void { if (value !== '0') CdpContract.int64(value); }


    #timestamp(value:unknown):number {if(typeof value!=='string'||!Number.isFinite(Date.parse(value))||new Date(Date.parse(value)).toISOString()!==value)throw new CdpContractError('INVALID_EVIDENCE','Expected canonical UTC timestamp.');return Date.parse(value);}
    getWatch(sessionId:string,watchId:string,caller:CdpContext):Readonly<CdpJsonObject>{
        this.#ensureOpen();this.#session(sessionId,caller,true);CdpContract.token(watchId);
        const row=this.#db.prepare('SELECT * FROM watches WHERE watch_id=? AND session_id=?').get(watchId,sessionId) as CdpRow|undefined;
        if(!row)throw new CdpContractError('NOT_FOUND','Retained watch is unavailable.');
        const aged=row.armed_ms<=this.#now()-this.#limits.values.evidenceRetentionMs;
        return CdpContract.freezeJson({watchId:row.watch_id,sessionId:row.session_id,pageId:row.page_id,documentId:row.document_id,afterEventId:row.after_event_id,armedAtUtc:this.#iso(row.armed_ms),expiresAtUtc:this.#iso(row.expires_ms),state:aged?'expired':row.state==='armed'&&row.expires_ms<=this.#now()?'expired':row.state,result:aged?null:row.result_json?JSON.parse(row.result_json):null,errorCode:aged?'IDENTITY_EXPIRED':row.error_code});
    }
    finishWatch(sessionId:string,watchId:string,caller:CdpContext,state:'satisfied'|'cancelled'|'expired',result:CdpJsonObject|null=null,errorCode:string|null=null):Readonly<CdpJsonObject>{
        if(!['satisfied','cancelled','expired'].includes(state))throw new CdpContractError('INVALID_TRANSITION','Invalid terminal watch state.');
        const safe=result===null?null:CdpContract.canonical(result);if(safe&&Buffer.byteLength(safe)>16384)throw new CdpContractError('EVIDENCE_LIMIT','Watch result exceeds its bounded observation budget.');
        this.#nullCode(errorCode);
        this.#transaction('outcome',()=>{this.#session(sessionId,caller,false);this.#assertCurrentBinding(caller);const row=this.#db.prepare('SELECT * FROM watches WHERE watch_id=? AND session_id=?').get(watchId,sessionId) as CdpRow|undefined;if(!row)throw new CdpContractError('NOT_FOUND','Watch unavailable.');if(row.state==='armed')this.#db.prepare('UPDATE watches SET state=?,result_json=?,error_code=? WHERE watch_id=?').run(row.expires_ms<=this.#now()?'expired':state,row.expires_ms<=this.#now()&&state!=='expired'?null:safe,errorCode,watchId);});
        return this.getWatch(sessionId,watchId,caller);
    }
    latestEventId(sessionId:string,caller:CdpContext):string {this.#session(sessionId,caller,true);const row=this.#db.prepare('SELECT CAST(MAX(seq) AS TEXT) AS seq FROM events WHERE session_id=?').get(sessionId) as CdpRow;const gap=this.#db.prepare('SELECT through_seq FROM event_gaps WHERE session_id=?').get(sessionId) as CdpRow|undefined;return [row.seq,gap?.through_seq,'0'].filter(Boolean).reduce((a,b)=>BigInt(a)>BigInt(b)?a:b);}
    appendCanonicalEvent(sessionId:string,caller:CdpContext,event:CdpJsonObject):CdpJsonObject {
        const o=CdpContract.object(event,['kind','pageId','frameId','documentId','capturedAtUtc','data','truncated']);CdpContract.eventKind(o.kind);this.#timestamp(o.capturedAtUtc);CdpContract.boolean(o.truncated);const pageId=CdpContract.nullToken(o.pageId);CdpContract.nullToken(o.frameId);CdpContract.nullToken(o.documentId);CdpContract.object(o.data);
        const safe=CdpContract.freezeJson({schemaVersion:2,...CdpContract.cloneJson(o,0,new Set()) as CdpJsonObject});const json=CdpContract.canonical(safe),bytes=Buffer.byteLength(json);
        if(bytes>Math.min(16384,this.#limits.values.eventBytesPerSession))throw new CdpContractError('EVENT_CAPACITY','Canonical event exceeds its admitted byte budget.');
        return this.#transaction('maintenance',()=>{this.#session(sessionId,caller,false);this.#assertCurrentBinding(caller);if(pageId)this.#assertPage(pageId,sessionId);this.#db.prepare('INSERT INTO events(session_id,created_ms,metadata_json,byte_length) VALUES(?,?,?,?)').run(sessionId,Date.parse(o.capturedAtUtc as string),json,bytes);const id=(this.#db.prepare('SELECT CAST(last_insert_rowid() AS TEXT) AS seq').get() as CdpRow).seq;this.#trimEvents(sessionId);return CdpContract.freezeJson({eventId:id,sessionId,...safe});});
    }
    readCanonicalEvents(sessionId:string,pageId:string|null,caller:CdpContext,args:any):CdpJsonObject {
        this.#ensureOpen();this.#session(sessionId,caller,true);if(pageId)this.#assertPage(pageId,sessionId);
        const after=CdpContract.eventCursor(args.afterEventId),kinds=args.kinds as string[],maxItems=CdpContract.integer(args.maxItems,1,50),maxChars=CdpContract.integer(args.maxChars,256,32000);
        for(const kind of kinds)CdpContract.eventKind(kind);
        const legacy=this.readEvents(sessionId,caller,after??'0',50);
        const rows=this.#db.prepare('SELECT CAST(seq AS TEXT) AS seq,metadata_json FROM events WHERE session_id=? AND seq>CAST(? AS INTEGER) AND created_ms>? ORDER BY events.seq LIMIT ?').all(sessionId,after??'0',this.#now()-this.#limits.values.evidenceRetentionMs,this.#limits.values.eventsPerSession) as CdpRow[];
        const events:CdpJsonObject[]=[];let chars=2,truncated=false,legacyOmitted=false,last=after??'0';
        for(const row of rows){const meta=JSON.parse(row.metadata_json);if(meta.schemaVersion!==2){legacyOmitted=true;last=row.seq;continue;}if(pageId&&meta.pageId!==pageId){last=row.seq;continue;}if(kinds.length&&!kinds.includes(meta.kind)){last=row.seq;continue;}
            let event:CdpJsonObject={eventId:row.seq,sessionId,...meta};let length=JSON.stringify(event).length;
            if(length+2>maxChars){event={eventId:row.seq,kind:meta.kind,truncated:true,omitted:true,summary:'Whole event exceeds MaxChars; payload omitted.'};length=JSON.stringify(event).length;}
            if(events.length>=maxItems||chars+length+1>maxChars){truncated=true;break;}events.push(event);chars+=length+1;last=row.seq;
        }
        return CdpContract.freezeJson({events,nextCursor:last,lastReturnedEventId:events.at(-1)?.eventId??null,truncated,gap:after!==null&&legacy.gap,earliestCursor:legacy.earliestCursor,legacyOmitted,coverage:'bounded canonical capture; unsupported kinds are not clean-state proof'});
    }

    /** One consistent retained SQLite snapshot. No live browser reads or artifact admission. */
    traceSnapshot(sessionId:string,pageId:string|null,caller:CdpContext,args:CdpTraceSnapshotArgs|CdpJsonObject):CdpTraceSnapshot {
        this.#ensureOpen();
        const safe=this.#traceArgs(args),now=this.#now();
        this.#db.exec('BEGIN');
        try {
            const session=this.#session(sessionId,caller,true);if(pageId!==null)this.#assertPage(CdpContract.token(pageId),sessionId);
            const scan=this.#traceScan(sessionId,pageId,safe,now);
            const auxiliary=this.#traceAuxiliary(session,pageId,caller,safe,scan,now);
            const result={capturedAtUtc:this.#iso(now)!,afterEventId:safe.afterEventId,throughEventId:safe.throughEventId,
                scannedThroughEventId:scan.cursor,hasMore:scan.hasMore,include:[...safe.include],
                sections:this.#traceSections(safe,scan,auxiliary),gaps:scan.gaps,actions:auxiliary.actions,
                artifactReferences:auxiliary.references,events:scan.events};
            this.#db.exec('COMMIT');return CdpContract.freezeJson(result as unknown as CdpJsonObject) as unknown as CdpTraceSnapshot;
        } catch(error) {
            try{this.#db.exec('ROLLBACK');}catch(rollbackError){throw new AggregateError([error,rollbackError],'Trace read and rollback both failed.');}throw error;
        }
    }
    #traceArgs(value:CdpTraceSnapshotArgs|CdpJsonObject):CdpTraceSnapshotArgs {
        const a=CdpContract.object(value,['afterEventId','throughEventId','include','maxEvents','maxBytes']);
        const after=CdpContract.eventCursor(a.afterEventId??null),through=CdpContract.eventCursor(a.throughEventId??null);
        if(after!==null&&through!==null&&BigInt(after)>BigInt(through))throw new CdpContractError('INVALID_WIRE','Trace interval is reversed.');
        const include=a.include??['actions','console','network-summary'];
        if(!Array.isArray(include)||!include.length||include.length>3||new Set(include).size!==include.length||include.some(v=>!['actions','console','network-summary'].includes(v)))throw new CdpContractError('INVALID_WIRE','Expected unique supported trace sections.');
        return {afterEventId:after,throughEventId:through,include:[...include] as string[],maxEvents:CdpContract.integer(a.maxEvents??1000,1,10000),maxBytes:CdpContract.integer(a.maxBytes??5000000,1,20000000)};
    }
    #traceScan(sessionId:string,pageId:string|null,args:CdpTraceSnapshotArgs,now:number):CdpTraceScan {
        const after=args.afterEventId??'0',maximum=this.#traceHighWater(sessionId,args.throughEventId);
        const scan:CdpTraceScan={cursor:after,hasMore:false,events:[],gaps:[],eventBytes:2,scanned:0};
        this.#traceRetainedGap(sessionId,after,maximum,scan);
        const rows=this.#db.prepare(`SELECT CAST(seq AS TEXT) AS seq,created_ms,
            CASE WHEN length(metadata_json)<=32768 THEN metadata_json ELSE NULL END AS metadata_json
            FROM events WHERE session_id=? AND seq>CAST(? AS INTEGER) AND seq<=CAST(? AS INTEGER)
            ORDER BY events.seq LIMIT 10001`).iterate(sessionId,after,maximum);
        for(const row of rows){
            if(scan.scanned===10000){scan.hasMore=true;break;}
            const event=this.#traceEvent(sessionId,pageId,args,row,scan,now);
            if(event&&(scan.events.length>=args.maxEvents||scan.eventBytes+Buffer.byteLength(JSON.stringify(event))+1>args.maxBytes)){
                if(scan.cursor===after)throw new CdpContractError('TRACE_SNAPSHOT_BUDGET','First progressing event cannot fit snapshot budget.');scan.hasMore=true;break;
            }
            if(event){scan.events.push(event);scan.eventBytes+=Buffer.byteLength(JSON.stringify(event))+1;}
            scan.cursor=(row as CdpTraceEventSqlRow).seq;scan.scanned++;
        }
        return scan;
    }
    #traceHighWater(sessionId:string,through:string|null):string {
        const row=this.#db.prepare('SELECT CAST(MAX(seq) AS TEXT) AS seq FROM events WHERE session_id=?').get(sessionId) as CdpRow;
        const gap=this.#db.prepare('SELECT through_seq FROM event_gaps WHERE session_id=?').get(sessionId) as CdpRow|undefined;
        const maximum=[row.seq,gap?.through_seq,'0'].filter(Boolean).reduce((a,b)=>BigInt(a)>BigInt(b)?a:b);
        return through!==null&&BigInt(through)<BigInt(maximum)?through:maximum;
    }
    #traceRetainedGap(sessionId:string,after:string,maximum:string,scan:CdpTraceScan):void {
        const gap=this.#db.prepare('SELECT through_seq FROM event_gaps WHERE session_id=?').get(sessionId) as CdpRow|undefined;
        if(gap&&BigInt(gap.through_seq)>BigInt(after)&&BigInt(maximum)>BigInt(after)){
            const through=BigInt(gap.through_seq)<BigInt(maximum)?gap.through_seq:maximum;
            scan.gaps.push({afterEventId:after,throughEventId:through,reason:'Retention/trim marker proves historical omission at or before this bound; not every global ID in this envelope is missing.'});
        }
    }
    #traceEvent(sessionId:string,pageId:string|null,args:CdpTraceSnapshotArgs,row:CdpRow,scan:CdpTraceScan,now:number):CdpTraceEvent|null {
        if(row.created_ms<=now-this.#limits.values.evidenceRetentionMs){this.#traceGap(scan,row.seq,'Expired retained rows omitted.');return null;}
        if(row.metadata_json===null){this.#traceGap(scan,row.seq,'Oversized legacy/unavailable row omitted under per-row bound.');return null;}
        const meta=JSON.parse(row.metadata_json);
        if(meta.schemaVersion!==2){this.#traceGap(scan,row.seq,'Legacy noncanonical rows omitted; they were scanned, not silently treated as canonical evidence.');return null;}
        if(pageId!==null&&meta.pageId!==pageId)return null;
        const section=meta.kind==='console'||meta.kind==='pageError'?'console':meta.kind==='request'||meta.kind==='response'?'network-summary':'actions';
        if(!args.include.includes(section))return null;
        if(meta.truncated===true||meta.omitted===true)this.#traceGap(scan,row.seq,'Selected canonical capture explicitly truncated/omitted payload; envelope preserved, not complete evidence.');
        return {eventId:row.seq,kind:meta.kind,data:{eventId:row.seq,sessionId,...meta}};
    }
    #traceGap(scan:CdpTraceScan,through:string,reason:string):void {
        const index=scan.gaps.findIndex(gap=>gap.reason===reason);
        if(index>=0)scan.gaps[index]={...scan.gaps[index],throughEventId:through};else scan.gaps.push({afterEventId:scan.cursor,throughEventId:through,reason});
    }
    #traceAuxiliary(session:CdpRow,pageId:string|null,caller:CdpContext,args:CdpTraceSnapshotArgs,scan:CdpTraceScan,now:number):CdpTraceAuxiliary {
        const aux:CdpTraceAuxiliary={actions:[],references:[],bytes:0,actionsLimited:false,referencesLimited:false};
        const interval=args.afterEventId!==null||args.throughEventId!==null,named=this.#traceNamedIds(scan.events);
        if(named.size>=256){aux.referencesLimited=true;if(interval)aux.actionsLimited=true;}
        if(args.include.includes('actions'))this.#traceActions(session,pageId,caller,interval,named,aux,args.maxBytes);
        this.#traceReferences(session,pageId,interval,named,aux,args.maxBytes,now);
        return aux;
    }
    #traceNamedIds(events:readonly CdpTraceEvent[]):Set<string> {
        const ids=new Set<string>();
        for(const event of events){const envelope=event.data as Record<string,any>;for(const value of [envelope,envelope.data]){
            if(!value||typeof value!=='object')continue;
            for(const key of ['callId','actionId','originCallId','originActionId','artifactId'])if(typeof value[key]==='string'&&value[key].length<=128&&ids.size<256)ids.add(value[key]);
            if(Array.isArray(value.artifactIds))for(const id of value.artifactIds.slice(0,32))if(typeof id==='string'&&id.length<=128&&ids.size<256)ids.add(id);
        }}return ids;
    }
    #traceActions(session:CdpRow,pageId:string|null,caller:CdpContext,interval:boolean,named:Set<string>,aux:CdpTraceAuxiliary,maxBytes:number):void {
        const owner=CdpContract.context(JSON.parse(session.context_json));
        const rows=this.#db.prepare(`SELECT * FROM receipts WHERE account_id=? AND actor_id=? AND context_json=?
            AND (scope=? OR (operation='CreateSession' AND scope='' AND json_extract(evidence_json,'$.sessionId')=?))
            AND (? IS NULL OR page_id=? OR json_extract(evidence_json,'$.pageId')=?)
            ORDER BY accepted_ms,call_id LIMIT 257`).iterate(owner.accountUserId,owner.actorConversationId,session.context_json,session.session_id,session.session_id,pageId,pageId,pageId);
        let scanned=0;
        for(const row of rows){
            if(++scanned>256){aux.actionsLimited=true;break;}
            const actionRow=row as CdpTraceActionSqlRow;
            if(interval&&!named.has(actionRow.call_id)&&!named.has(actionRow.dedup_id))continue;
            this.#authorize(row,caller,true);
            const entry=this.#entry(row) as unknown as CdpTraceJson;
            if(!this.#traceAuxFits(aux,entry,maxBytes)){aux.actionsLimited=true;break;}aux.actions.push(entry);
        }
    }
    #traceAuxFits(aux:CdpTraceAuxiliary,value:unknown,maxBytes:number):boolean {
        const bytes=Buffer.byteLength(JSON.stringify(value))+1;
        if(aux.bytes+bytes>Math.min(65536,Math.floor(maxBytes/2)))return false;aux.bytes+=bytes;return true;
    }
    #traceReferences(session:CdpRow,pageId:string|null,interval:boolean,named:Set<string>,aux:CdpTraceAuxiliary,maxBytes:number,now:number):void {
        if(interval)for(const action of aux.actions){const evidence=(action as Record<string,any>).evidence;if(evidence?.artifactIds)for(const id of evidence.artifactIds)if(named.size<256)named.add(id);}
        const rows=interval?this.#traceNamedArtifacts(session,pageId,named):this.#db.prepare(`SELECT artifact_id,created_ms,metadata_json FROM artifacts WHERE session_id=? AND account_id=?
            AND (? IS NULL OR json_extract(metadata_json,'$.pageId')=?) ORDER BY created_ms,artifact_id LIMIT 257`).all(session.session_id,session.account_id,pageId,pageId) as CdpRow[];
        for(const row of rows){
            if(aux.references.length>=256){aux.referencesLimited=true;break;}
            const meta=JSON.parse(row.metadata_json),expired=row.created_ms<=now-this.#limits.values.evidenceRetentionMs;
            const ref:CdpTraceArtifactReference={artifactId:row.artifact_id,availability:expired?'expired':'retained',mime:meta.mime??null,byteLength:meta.byteLength??null,sha256:meta.sha256??null,
                reason:expired?'Admission metadata is expired; bytes were not read.':'Admission metadata only; file existence and whole-file hash not reverified.'};
            if(!this.#traceAuxFits(aux,ref,maxBytes)){aux.referencesLimited=true;break;}aux.references.push(ref);
        }
    }
    #traceNamedArtifacts(session:CdpRow,pageId:string|null,named:Set<string>):CdpRow[] {
        const rows:CdpRow[]=[];
        const statement=this.#db.prepare(`SELECT artifact_id,created_ms,metadata_json FROM artifacts WHERE artifact_id=? AND session_id=? AND account_id=?
            AND (? IS NULL OR json_extract(metadata_json,'$.pageId')=?)`);
        for(const id of named){const row=statement.get(id,session.session_id,session.account_id,pageId,pageId);if(row)rows.push(row);}return rows;
    }
    #traceSections(args:CdpTraceSnapshotArgs,scan:CdpTraceScan,aux:CdpTraceAuxiliary):CdpTraceSection[] {
        const interval=args.afterEventId!==null||args.throughEventId!==null;
        const partial=scan.hasMore||scan.gaps.length>0||(args.throughEventId!==null&&BigInt(scan.cursor)<BigInt(args.throughEventId));
        const sections:CdpTraceSection[]=args.include.map(section=>({section,status:partial||(section==='actions'&&(aux.actionsLimited||interval))?'partial':'complete',
            reason:section==='actions'?(interval?'Receipts have no event cursor; only IDs explicitly named by selected interval events are associated. ':'Exact scoped retained receipt summaries. ')+(aux.actionsLimited?'Receipt count/byte/scan bound reached. ':'')+'No browser replay or historical reconstruction.':partial?'Actual bounded canonical scan; gaps, source continuation or unscanned requested upper bound remain.':'All selected canonical records through this retained snapshot scan; not full historical capture.'}));
        sections.push({section:'artifact-references',status:aux.referencesLimited?'partial':'references-only',reason:(aux.referencesLimited?'Reference count/byte bound reached. ':'')+(interval?'Only explicit selected-event/receipt references. ':'Bounded exact scoped registry references. ')+'No attachment bytes, path resolution or whole-file verification.'});
        sections.push({section:'network-bodies-sql-library-trace',status:'unavailable',reason:'No live fetch, network bodies, SQL diagnostics, HAR or library trace gathered.'});return sections;
    }

    /** Admission preflight only. recordArtifact rechecks inside its existing atomic transaction. */
    assertArtifactAdmission(caller: CdpContext, value: CdpArtifactMetadata): Readonly<CdpArtifactMetadata> {
        this.#ensureOpen();
        const metadata = this.#artifact(CdpContract.object(value, ['artifactId','sessionId','pageId','kind','mime','byteLength','sha256','width','height']));
        const session = this.#session(metadata.sessionId, caller, false); this.#assertCurrentBinding(caller);
        if (metadata.pageId) this.#assertPage(metadata.pageId, metadata.sessionId);
        if (this.#db.prepare('SELECT 1 FROM artifacts WHERE artifact_id=?').get(metadata.artifactId)) throw new CdpContractError('ARTIFACT_ID_CONFLICT', 'Artifact identity is already admitted; never overwrite or reparent it.');
        this.#artifactCapacity(metadata, session.account_id);
        return metadata;
    }
    recordArtifact(caller: CdpContext, value: CdpArtifactMetadata): void {
        this.#transaction('maintenance', () => {
            const metadata = this.assertArtifactAdmission(caller, value);
            const session = this.#session(metadata.sessionId, caller, false);
            this.#db.prepare('INSERT INTO artifacts VALUES(?,?,?,?,?,?)').run(metadata.artifactId, metadata.sessionId, session.account_id,
                this.#now(), metadata.byteLength, CdpContract.canonical(metadata));
        });
    }
    #artifact(o: Record<string, unknown>): CdpArtifactMetadata {
        if (!['image', 'download', 'observation'].includes(o.kind as string) || (o.mime !== null && (typeof o.mime !== 'string' || !/^[a-z0-9!#&$^_.+-]+\/[a-z0-9!#&$^_.+-]+$/.test(o.mime) || o.mime.length > 100))) throw new CdpContractError('INVALID_EVIDENCE', 'Invalid artifact kind or MIME metadata.');
        if (typeof o.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(o.sha256)) throw new CdpContractError('INVALID_EVIDENCE', 'Invalid artifact digest metadata.');
        const byteLength = CdpContract.integer(o.byteLength, o.kind === 'image' ? 1 : 0, this.#limits.values.artifactBytesPerSession);
        const width = o.width === null ? null : CdpContract.integer(o.width, 1, 32768);
        const height = o.height === null ? null : CdpContract.integer(o.height, 1, 32768);
        if (o.kind === 'image' && (!width || !height || !['image/png', 'image/jpeg'].includes(o.mime as string) || byteLength > this.#limits.values.sourceImageBytes || byteLength > this.#limits.values.finalImageBytes)) throw new CdpContractError('IMAGE_LIMIT', 'Image metadata does not meet the bounded nonempty contract.');
        if (o.kind !== 'image' && (width !== null || height !== null)) throw new CdpContractError('INVALID_EVIDENCE', 'Non-image dimensions must remain null.');
        if (o.kind === 'download' && byteLength > this.#limits.values.downloadBytes) throw new CdpContractError('ARTIFACT_CAPACITY', 'Download metadata exceeds its byte bound.');
        return Object.freeze({ artifactId: CdpContract.token(o.artifactId), sessionId: CdpContract.token(o.sessionId), pageId: CdpContract.nullToken(o.pageId),
            kind: o.kind as CdpArtifactMetadata['kind'], mime: o.mime as string | null, byteLength, sha256: o.sha256, width, height });
    }
    #artifactCapacity(metadata: CdpArtifactMetadata, account: string): void {
        const session = this.#db.prepare('SELECT COALESCE(SUM(byte_length),0) AS bytes FROM artifacts WHERE session_id=?').get(metadata.sessionId) as CdpRow;
        const owner = this.#db.prepare('SELECT COALESCE(SUM(byte_length),0) AS bytes FROM artifacts WHERE account_id=?').get(account) as CdpRow;
        const client = this.#db.prepare('SELECT COALESCE(SUM(byte_length),0) AS bytes FROM artifacts').get() as CdpRow;
        const v = this.#limits.values;
        if (session.bytes + metadata.byteLength > v.artifactBytesPerSession || owner.bytes + metadata.byteLength > v.artifactBytesPerAccount || client.bytes + metadata.byteLength > v.artifactBytesPerClient) throw new CdpContractError('ARTIFACT_CAPACITY', 'Retained artifact capacity is exhausted.');
    }
    getArtifact(artifactId: string, caller: CdpContext): Readonly<CdpArtifactMetadata> {
        this.#ensureOpen(); CdpContract.token(artifactId);
        const row = this.#db.prepare('SELECT * FROM artifacts WHERE artifact_id=?').get(artifactId) as CdpRow | undefined;
        if (!row || row.created_ms <= this.#now() - this.#limits.values.evidenceRetentionMs) throw new CdpContractError('NOT_FOUND', 'Artifact metadata is expired or unavailable.');
        this.#session(row.session_id, caller, true); return Object.freeze(JSON.parse(row.metadata_json));
    }

    describeArtifact(artifactId:string,caller:CdpContext): Readonly<{metadata:Readonly<CdpArtifactMetadata>;capturedAtUtc:string;expiresAtUtc:string;}> {
        const metadata=this.getArtifact(artifactId,caller);
        const row=this.#db.prepare('SELECT created_ms FROM artifacts WHERE artifact_id=?').get(artifactId) as CdpRow;
        return Object.freeze({metadata,capturedAtUtc:this.#iso(row.created_ms)!,expiresAtUtc:this.#iso(row.created_ms+this.#limits.values.evidenceRetentionMs)!});
    }

    // Internal private-store housekeeping, like prune(). Never exposed as a model read or a grant.
    retainedArtifactIds(maximum = 100000): readonly string[] {
        this.#ensureOpen(); CdpContract.integer(maximum,1,100000);
        const rows = this.#db.prepare('SELECT artifact_id FROM artifacts ORDER BY artifact_id LIMIT ?').all(maximum + 1) as CdpRow[];
        if (rows.length > maximum) throw new CdpContractError('ARTIFACT_MAINTENANCE_LIMIT', 'Private artifact reconciliation budget exceeded; no evidence was silently forgotten.');
        return Object.freeze(rows.map(row => row.artifact_id));
    }

    /** Kind-aware private housekeeping, not a public metadata listing or grant. */
    retainedArtifacts(maximum = 100000): readonly Readonly<{ artifactId: string; kind: CdpArtifactMetadata['kind']; mime:string|null; }>[] {
        this.#ensureOpen(); CdpContract.integer(maximum,1,100000);
        const rows = this.#db.prepare('SELECT artifact_id,metadata_json FROM artifacts ORDER BY artifact_id LIMIT ?').all(maximum + 1) as CdpRow[];
        if (rows.length > maximum) throw new CdpContractError('ARTIFACT_MAINTENANCE_LIMIT', 'Private artifact reconciliation budget exceeded.');
        return Object.freeze(rows.map(row => this.#artifactReference(row)));
    }
    #artifactReference(row: CdpRow): Readonly<{ artifactId: string; kind: CdpArtifactMetadata['kind']; mime:string|null; }> {
        const metadata = JSON.parse(row.metadata_json);
        if (metadata.artifactId !== row.artifact_id || !['image','download','observation'].includes(metadata.kind)) throw new CdpContractError('ARTIFACT_INTEGRITY', 'Retained artifact kind/identity is invalid.');
        if(metadata.mime!==undefined&&metadata.mime!==null&&typeof metadata.mime!=='string')throw new CdpContractError('ARTIFACT_INTEGRITY','Retained artifact MIME is invalid.');
        return Object.freeze({artifactId:CdpContract.token(row.artifact_id),kind:metadata.kind,mime:metadata.mime??null});
    }

    prune(): { readonly expiredReceipts: number; readonly artifactIdsToDelete: readonly string[]; readonly artifactsToDelete: readonly Readonly<{artifactId:string;kind:CdpArtifactMetadata['kind'];mime:string|null;}>[]; } {
        return this.#transaction('maintenance', () => {
            const cutoff = this.#now() - this.#limits.values.evidenceRetentionMs;
            const artifacts = this.#db.prepare('SELECT artifact_id,metadata_json FROM artifacts WHERE created_ms<? LIMIT 100001').all(cutoff) as CdpRow[];
            if (artifacts.length > 100000) throw new CdpContractError('ARTIFACT_MAINTENANCE_LIMIT', 'Expired artifact deletion budget exceeded; no registry rows removed.');
            const artifactsToDelete = Object.freeze(artifacts.map(row => this.#artifactReference(row)));
            const gaps = this.#db.prepare('SELECT session_id,CAST(MAX(seq) AS TEXT) AS seq FROM events WHERE created_ms<? GROUP BY session_id').all(cutoff) as CdpRow[];
            for (const gap of gaps) this.#rememberGap(gap.session_id, gap.seq);
            this.#db.prepare('DELETE FROM events WHERE created_ms<?').run(cutoff);
            this.#db.prepare('DELETE FROM artifacts WHERE created_ms<?').run(cutoff);
            this.#db.prepare("UPDATE watches SET result_json=NULL,error_code='IDENTITY_EXPIRED' WHERE armed_ms<? AND state!='armed'").run(cutoff);
            const expired = this.#db.prepare('UPDATE receipts SET expired=1,evidence_json=NULL,error_code=\'IDENTITY_EXPIRED\' WHERE expired=0 AND state IN (\'completed\',\'failedBeforeDispatch\',\'cancelledBeforeDispatch\') AND completed_ms IS NOT NULL AND completed_ms<?').run(cutoff);
            // Evidence expiry never proves a browser closed. Keep live/orphaned session and page ownership/accounting.
            // Only an authoritative owned CloseSession completion releases the live resource slot.
            return Object.freeze({ expiredReceipts: Number(expired.changes), artifactIdsToDelete: Object.freeze(artifacts.map(row => row.artifact_id)), artifactsToDelete });
        });
    }

    #find(reference: CdpReceiptReference): CdpRow | undefined {
        CdpContract.int64(reference.accountUserId); CdpContract.int64(reference.actorConversationId);
        if (reference.scope !== '') CdpContract.token(reference.scope);
        if (reference.idKind !== 'action' && reference.idKind !== 'creation') throw new CdpContractError('INVALID_WIRE', 'Invalid receipt reference kind.');
        CdpContract.token(reference.id);
        return this.#db.prepare('SELECT * FROM receipts WHERE account_id=? AND actor_id=? AND scope=? AND id_kind=? AND dedup_id=?').get(
            reference.accountUserId, reference.actorConversationId, reference.scope, reference.idKind, reference.id) as CdpRow | undefined;
    }
    #required(reference: CdpReceiptReference): CdpRow { const row = this.#find(reference); if (!row) throw new CdpContractError('NOT_FOUND', 'Receipt identity is unavailable.'); return row; }
    #entry(row: CdpRow): CdpJournalEntry {
        const context = CdpContract.context(JSON.parse(row.context_json));
        return Object.freeze({ reference: Object.freeze({ accountUserId: row.account_id, actorConversationId: row.actor_id, scope: row.scope, idKind: row.id_kind, id: row.dedup_id }),
            callId: row.call_id, op: row.operation, sessionId: row.scope || null, pageId: row.page_id, owner: context, payloadExpired: this.#isExpired(row),
            uncertainty: row.uncertain_ms === null ? null : Object.freeze({ observedAtUtc: this.#iso(row.uncertain_ms)!, code: row.uncertain_code }),
            errorCode: this.#isExpired(row) ? 'IDENTITY_EXPIRED' : row.error_code, evidence: !this.#isExpired(row) && row.evidence_json ? CdpContract.freezeJson(JSON.parse(row.evidence_json)) : null,
            receipt: Object.freeze({ idKind: row.id_kind, id: row.dedup_id, fingerprint: row.server_fingerprint, state: row.state as CdpState,
                acceptedAtUtc: this.#iso(row.accepted_ms)!, dispatchStartedAtUtc: this.#iso(row.dispatch_ms), completedAtUtc: row.state === 'uncertain' ? null : this.#iso(row.completed_ms), inputMethod: row.input_method, payloadExpired: this.#isExpired(row) }) });
    }
    #iso(ms: number | null): string | null { return ms === null ? null : new Date(ms).toISOString(); }
    #now(): number { const now = this.#options.clock?.now() ?? Date.now(); return CdpContract.integer(now, 0, 8640000000000000); }
    #ensureOpen(): void { if (this.#closed) throw new CdpContractError('STORE_CLOSED', 'Store is closed.'); }
    #transaction<T>(phase: 'acceptance' | 'dispatchBarrier' | 'outcome' | 'maintenance', work: () => T): T {
        this.#ensureOpen(); this.#db.exec('BEGIN IMMEDIATE');
        try { this.#assertLease(); const result = work(); this.#options.faultInjector?.beforeCommit(phase); this.#db.exec('COMMIT'); return result; }
        catch (error) {
            try { this.#db.exec('ROLLBACK'); } catch (rollbackError) { throw new AggregateError([error, rollbackError], 'Store transaction and rollback both failed.'); }
            throw error;
        }
    }
    close(): void {
        if (this.#closed) return;
        this.#releaseLease(); this.#db.close(); this.#key.fill(0); this.#closed = true;
    }
}
