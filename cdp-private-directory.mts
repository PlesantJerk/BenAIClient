import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { CdpContractError } from './cdp-contract.mts';
import type { CdpDirectoryGuard } from './cdp-store.mts';

// Only this dedicated root may be hardened. Never changes an existing directory or a parent ACL.
// Windows implementation is exercised by the owned fixture. Other platforms deliberately fail closed.
export class CdpPrivateDirectoryPolicy implements CdpDirectoryGuard {
    readonly #root: string;
    constructor(root: string) {
        if (!path.isAbsolute(root)) throw new CdpContractError('PRIVATE_DIRECTORY_REQUIRED', 'Private root must be absolute.');
        this.#root = path.resolve(root);
        this.#assertAncestors(this.#root, true);
    }
    createFresh(): void {
        if (process.platform !== 'win32') throw new CdpContractError('PRIVATE_PLATFORM_UNSUPPORTED', 'Private storage policy is currently Windows only.');
        if (fs.existsSync(this.#root)) throw new CdpContractError('PRIVATE_DIRECTORY_EXISTS', 'Fresh private root already exists; no ACL changes were made.');
        fs.mkdirSync(this.#root, { mode: 0o700 });
        this.#hardenFresh(this.#root);
        this.assertPrivateDirectory(this.#root);
    }
    openInstallation(clientName:string,routingDigest:string): void {
        if(!/^[a-z0-9][a-z0-9._-]{0,99}$/.test(clientName)||!/^[a-f0-9]{64}$/.test(routingDigest))throw new CdpContractError('PRIVATE_MARKER_INVALID','Installation marker binding is invalid.');
        const marker=path.join(this.#root,'.cdp-installation-v1.json');
        const expected={kind:'BenAI.CDP.private-installation',version:1,clientName,routingDigest};
        if(!fs.existsSync(this.#root)) {
            this.createFresh();
            const descriptor=fs.openSync(marker,'wx',0o600);
            try {fs.writeFileSync(descriptor,JSON.stringify(expected));fs.fsyncSync(descriptor);}finally{fs.closeSync(descriptor);}
            this.#powershell(`$d=New-Object System.Security.AccessControl.FileSecurity;$d.SetAccessRuleProtection($true,$false);$d.SetOwner($sid);foreach($s in @($sid,[System.Security.Principal.SecurityIdentifier]'S-1-5-18')){$d.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($s,'FullControl','Allow')))};Set-Acl -LiteralPath $p -AclObject $d;`,marker);
        }
        // Existing roots are only read/verified. Missing or mismatched markers are never repaired.
        this.assertPrivateDirectory(this.#root);
        let stat:fs.Stats;
        try {stat=fs.lstatSync(marker);}catch {throw new CdpContractError('PRIVATE_MARKER_INVALID','An existing installation requires its verified marker; no state was repaired.');}
        if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size<1||stat.size>4096)throw new CdpContractError('PRIVATE_MARKER_INVALID','Installation marker must be an ordinary bounded unaliased file.');
        this.#powershell(`$a=Get-Acl -LiteralPath $p;if(-not $a.AreAccessRulesProtected -or $a.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value){throw 'owner'};$seen=@();foreach($r in $a.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier])){if($r.AccessControlType -ne 'Allow' -or @($sid.Value,'S-1-5-18') -notcontains $r.IdentityReference.Value -or $r.FileSystemRights -ne [System.Security.AccessControl.FileSystemRights]::FullControl -or $r.InheritanceFlags -ne 'None' -or $r.PropagationFlags -ne 'None'){throw 'rule'};$seen+=$r.IdentityReference.Value};if($seen -notcontains $sid.Value -or $seen -notcontains 'S-1-5-18'){throw 'missing'};`,marker);
        if(fs.readFileSync(marker,'utf8')!==JSON.stringify(expected))throw new CdpContractError('PRIVATE_MARKER_INVALID','Installation marker does not match this captured route.');
    }
    openInstallationChild(name:'journal'|'images'|'observations'|'downloads'):string {
        if(!['journal','images','observations','downloads'].includes(name))throw new CdpContractError('UNSAFE_STORAGE_PATH','Unknown persistent child.');
        const directory=path.join(this.#root,name);
        if(!fs.existsSync(directory))return this.createChild(name);
        this.assertPrivateDirectory(directory);return directory;
    }
    createChild(name: string): string {
        if (!/^[a-zA-Z0-9-]{1,100}$/.test(name)) throw new CdpContractError('UNSAFE_STORAGE_PATH', 'Invalid private child name.');
        this.assertPrivateDirectory(this.#root);
        const child = path.join(this.#root, name);
        fs.mkdirSync(child, { mode: 0o700 });
        this.#hardenFresh(child);
        this.assertPrivateDirectory(child);
        return child;
    }
    // Core-only integration for a helper-created empty child from this exact fresh operation.
    initializeFreshDownloadChild(parent:string,child:string,createdAfterMs:number):void {
        const full=path.resolve(child),expectedParent=path.resolve(parent);this.assertPrivateDirectory(expectedParent);
        if(path.dirname(full)!==expectedParent||!/^cdp-downloads-[a-f0-9-]{36}$/.test(path.basename(full))||!Number.isFinite(createdAfterMs))throw new CdpContractError('UNSAFE_STORAGE_PATH','Fresh helper staging identity is outside its exact owner parent.');
        this.#assertAncestors(full,false);const stat=fs.lstatSync(full);
        if(!stat.isDirectory()||stat.isSymbolicLink()||stat.birthtimeMs<createdAfterMs-1000||fs.readdirSync(full).length)throw new CdpContractError('UNSAFE_STORAGE_PATH','Only the empty child just created by this helper operation receives initial directory policy.');
        this.#hardenFresh(full);this.assertPrivateDirectory(full);
    }
    assertPrivateDirectory(directory: string): void {
        if (process.platform !== 'win32') throw new CdpContractError('PRIVATE_PLATFORM_UNSUPPORTED', 'Private storage policy is currently Windows only.');
        const full = path.resolve(directory);
        if (!this.contains(full)) throw new CdpContractError('UNSAFE_STORAGE_PATH', 'Directory is outside the dedicated private root.');
        this.#assertAncestors(full, false);
        const relative = path.relative(this.#root, full);
        const descendants = relative ? relative.split(path.sep) : [];
        let current = this.#root;
        this.#verifyAcl(current, true);
        for (const part of descendants) { current = path.join(current, part); this.#verifyAcl(current, false); }
    }
    assertPrivateFile(file:string,fresh:boolean):void {
        const full=path.resolve(file);
        this.assertPrivateDirectory(path.dirname(full));
        const stat=fs.lstatSync(full);
        if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1)throw new CdpContractError('UNSAFE_STORAGE_PATH','Private file must be ordinary and unaliased.');
        if(fresh)this.#powershell(`$d=New-Object System.Security.AccessControl.FileSecurity;$d.SetAccessRuleProtection($true,$false);$d.SetOwner($sid);foreach($s in @($sid,[System.Security.Principal.SecurityIdentifier]'S-1-5-18')){$d.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($s,'FullControl','Allow')))};Set-Acl -LiteralPath $p -AclObject $d;`,full);
        this.#powershell(`$a=Get-Acl -LiteralPath $p;if(-not $a.AreAccessRulesProtected -or $a.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value){throw 'owner'};$seen=@();foreach($r in $a.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier])){if($r.AccessControlType -ne 'Allow' -or @($sid.Value,'S-1-5-18') -notcontains $r.IdentityReference.Value -or $r.FileSystemRights -ne [System.Security.AccessControl.FileSystemRights]::FullControl -or $r.InheritanceFlags -ne 'None' -or $r.PropagationFlags -ne 'None'){throw 'rule'};$seen+=$r.IdentityReference.Value};if($seen -notcontains $sid.Value -or $seen -notcontains 'S-1-5-18'){throw 'missing'};`,full);
    }
    contains(full: string): boolean {
        const relative = path.relative(this.#root, path.resolve(full));
        return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
    }
    #hardenFresh(directory: string): void {
        this.#powershell(`$d = New-Object System.Security.AccessControl.DirectorySecurity; $d.SetAccessRuleProtection($true,$false); $d.SetOwner($sid);
            foreach($s in @($sid,[System.Security.Principal.SecurityIdentifier]'S-1-5-18')) {
                $r = New-Object System.Security.AccessControl.FileSystemAccessRule($s,'FullControl','ContainerInherit,ObjectInherit','None','Allow'); $d.AddAccessRule($r);
            }; Set-Acl -LiteralPath $p -AclObject $d;`,directory);
    }
    #verifyAcl(directory: string, root: boolean): void {
        this.#powershell(`$a = Get-Acl -LiteralPath $p; if ($a.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { throw 'owner'; }
            if (${root ? '$true' : '$false'} -and -not $a.AreAccessRulesProtected) { throw 'inheritance'; }
            $rules = @($a.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier])); $own = $false; $system = $false;
            foreach($r in $rules) {
                if ($r.AccessControlType -ne 'Allow' -or @($sid.Value,'S-1-5-18') -notcontains $r.IdentityReference.Value -or $r.FileSystemRights -ne [System.Security.AccessControl.FileSystemRights]::FullControl -or $r.InheritanceFlags -ne ([System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit) -or $r.PropagationFlags -ne [System.Security.AccessControl.PropagationFlags]::None) { throw 'rules'; }
                if ($r.IdentityReference.Value -eq $sid.Value) { $own = $true }; if ($r.IdentityReference.Value -eq 'S-1-5-18') { $system = $true };
            }; if (-not $own -or -not $system) { throw 'missing'; }`, directory);
    }
    #powershell(body: string, directory = this.#root): void {
        const script = `$ErrorActionPreference='Stop'; $p='${directory.replaceAll("'", "''")}'; $sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User; ${body} [Console]::Write('CDP_PRIVATE_OK');`;
        try {
            const result = execFileSync('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true, timeout: 10000, maxBuffer: 4096, stdio: ['ignore', 'pipe', 'pipe'] });
            if (result !== 'CDP_PRIVATE_OK') throw new Error('verification');
        } catch { throw new CdpContractError('PRIVATE_ACL_UNVERIFIED', 'Dedicated private directory ownership/ACL verification failed.'); }
    }
    #assertAncestors(directory: string, allowMissingLeaf: boolean): void {
        let current = directory;
        for (;;) {
            try {
                const stat = fs.lstatSync(current);
                if (stat.isSymbolicLink() || !stat.isDirectory()) throw new CdpContractError('UNSAFE_STORAGE_PATH', 'Private path contains a link or non-directory.');
            } catch (error) {
                if (!(allowMissingLeaf && current === directory && (error as NodeJS.ErrnoException).code === 'ENOENT')) throw error;
            }
            if (path.dirname(current) === current) break;
            current = path.dirname(current);
        }
    }
}
