import {Script} from 'node:vm';
import {CdpContractError} from './cdp-contract.mts';
import type {CdpJsonObject} from './cdp-contract.mts';
import type {CdpWatches,CdpWatch} from './cdp-watches.mts';

// Fixed host code only. Caller pattern/input are data; browser predicates never execute in this VM.
export class CdpConditionMatcher {
    static readonly regexTimeoutMs=100;
    static readonly regexPatternChars=1024;
    static readonly inputChars=32768;
    static readonly #compile=new Script("new RegExp(pattern,'u');true");
    static readonly #test=new Script("new RegExp(pattern,'u').test(input)");
    readonly #owner:CdpWatches;
    constructor(owner:CdpWatches){this.#owner=owner;}
    static validateRegex(pattern:string):void {
        if(pattern.length>this.regexPatternChars)throw new CdpContractError('REGEX_LIMIT','Regex pattern exceeds1024 characters.');
        this.#run(this.#compile,pattern,'');
    }
    static matches(value:string,match:any):boolean {
        if(value.length>this.inputChars)throw new CdpContractError('MATCH_INPUT_UNAVAILABLE','Complete text exceeds bounded matcher input.');
        if(match.comparison==='equals')return value===match.value;
        if(match.comparison==='contains')return value.includes(match.value);
        return this.#run(this.#test,match.value,value);
    }
    static #run(script:Script,pattern:string,input:string):boolean {
        try{return script.runInNewContext({pattern,input},{timeout:this.regexTimeoutMs,contextCodeGeneration:{strings:false,wasm:false}})===true;}
        catch(error){const timeout=error&&typeof error==='object'&&'code'in error&&error.code==='ERR_SCRIPT_EXECUTION_TIMEOUT';throw new CdpContractError(timeout?'REGEX_TIMEOUT':'REGEX_INVALID',timeout?'Bounded regex execution exceeded100ms; no absence was proved.':'Invalid bounded Unicode regular expression.');}
    }
    static eventType(condition:any):string{return condition.kind==='response'?'response':condition.eventType;}
    static filters(condition:any):any{return condition.kind==='response'?{urlMatch:condition.urlMatch,method:condition.method,status:condition.status,requestJsonMatch:condition.requestJsonMatch}:condition.filters;}
    knownIrrelevant(condition:any,event:CdpJsonObject,actual:CdpJsonObject):boolean {
        if(event.kind!==CdpConditionMatcher.eventType(condition))return true;
        const filters=CdpConditionMatcher.filters(condition);
        for(const key of ['method','status','multiple','downloadId','openerPageId','closedPageId','dialogType','level']){
            const wanted=filters[key];if(wanted===undefined||wanted===null)continue;
            const value=actual[key];if(value!==undefined&&value!==null&&(key==='method'?String(value).toUpperCase():value)!==wanted)return true;
        }
        if(filters.state!==undefined){const value=actual.downloadState??actual.state;if(['started','progress','completed','failed'].includes(value as string)&&value!==filters.state)return true;}
        return false;
    }
    async event(watch:CdpWatch,event:CdpJsonObject,actual:CdpJsonObject,condition:any,retained:boolean,sourceTruncated?:boolean):Promise<CdpJsonObject|null> {
        if(this.knownIrrelevant(condition,event,actual))return null;
        if(event.omitted||actual.omitted)throw new CdpContractError('EVENT_MATCH_UNAVAILABLE','An oversized retained event cannot be matched.');
        const filters=CdpConditionMatcher.filters(condition),network=event.kind==='request'||event.kind==='response';
        if(network)return this.#network(watch,event,actual,filters);
        for(const[key,value]of Object.entries(filters)){
            if(value===null)continue;
            const source=key==='textMatch'?actual.text:key==='messageMatch'?actual.message:key==='urlMatch'?actual.url:key==='suggestedFilenameMatch'?actual.suggestedFilename:key==='state'?actual.downloadState??actual.state:actual[key];
            if(key.endsWith('Match')){
                if(typeof source!=='string'||(retained?event.truncated:sourceTruncated??event.truncated)||key==='suggestedFilenameMatch'&&actual.metadataTruncated)throw new CdpContractError('EVENT_MATCH_UNAVAILABLE','Complete matching text is unavailable or truncated.');
                if(retained&&key==='urlMatch'&&source.includes('[REDACTED]'))throw new CdpContractError('EVENT_MATCH_UNAVAILABLE','Retained redacted URL cannot prove an actual URL match.');
                if(!CdpConditionMatcher.matches(source,value))return null;
            }else{if(source===undefined||source===null)throw new CdpContractError('EVENT_MATCH_UNAVAILABLE','Required event metadata is unavailable.');if(source!==value){if(key==='state'&&!['started','progress','completed','failed'].includes(source as string))throw new CdpContractError('DOWNLOAD_MATCH_UNAVAILABLE','Download admission state is not a completed native outcome.');return null;}}
        }
        return {event};
    }
    async #network(watch:CdpWatch,event:CdpJsonObject,actual:CdpJsonObject,filters:any):Promise<CdpJsonObject|null>{
        if(!this.#owner.session.pages().includes(watch.page))throw new CdpContractError('OWNERSHIP_DENIED','Network match page is outside this watch registry.');
        if(typeof actual.networkRequestId!=='string')throw new CdpContractError('NETWORK_MATCH_UNAVAILABLE','Authoritative network request/hop ID is unavailable.');
        const exchange=await watch.page.getNetworkExchange(actual.networkRequestId,{includeRequestBody:filters.requestJsonMatch!=null,includeResponseBody:false,maxBodyChars:32768}) as any;
        if(!exchange.retention||exchange.retention.state!=='retained'||exchange.pageId!==watch.page.id)throw new CdpContractError('NETWORK_MATCH_UNAVAILABLE','Native exchange evidence is unknown or evicted; no replay or guessed join.');
        if(exchange.urlTruncated)throw new CdpContractError('NETWORK_MATCH_UNAVAILABLE','Complete actual native URL was not retained.');
        if(filters.method!=null&&exchange.method.toUpperCase()!==filters.method)return null;
        if(filters.status!=null){if(typeof exchange.status!=='number')throw new CdpContractError('NETWORK_MATCH_UNAVAILABLE','HTTP status is not yet known.');if(exchange.status!==filters.status)return null;}
        if(filters.urlMatch&&!CdpConditionMatcher.matches(exchange.url,filters.urlMatch))return null;
        if(filters.requestJsonMatch!=null&&!this.#requestJson(exchange.requestBody,filters.requestJsonMatch))return null;
        return {event,networkRequestId:actual.networkRequestId,networkEvidence:{metadataMatched:true,requestJsonMatched:filters.requestJsonMatch!=null,bodySource:filters.requestJsonMatch!=null?exchange.requestBody.source:null,frameScope:'main native capture; logical frame/document unknown',applicationSuccessVerified:false}};
    }
    #requestJson(body:any,match:any):boolean {
        if(body?.state!=='captured'||body.truncated||typeof body.text!=='string')throw new CdpContractError('NETWORK_MATCH_UNAVAILABLE','Complete bounded request JSON is unavailable.');
        let value:unknown;try{value=JSON.parse(body.text);}catch{throw new CdpContractError('NETWORK_MATCH_UNAVAILABLE','Captured request is not complete JSON.');}
        for(const part of match.path){if(!value||typeof value!=='object'||!Object.hasOwn(value,part))return false;value=(value as Record<string,unknown>)[part];}
        return value===match.value;
    }
}
