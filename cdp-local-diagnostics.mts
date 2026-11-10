import { write } from 'node:fs';

export type CdpLocalWriter=(buffer:Buffer,offset:number,done:(error:unknown,written:number)=>void)=>void;
interface CdpLocalRecord {readonly buffer:Buffer;offset:number;}

// Feature-only, best-effort stdout. A hung OS write cannot be cancelled: the one
// active record stays bounded and later whole records drop. No flush guarantee.
export class CdpLocalDiagnosticSink {
    static readonly shared=new CdpLocalDiagnosticSink();
    readonly #writer:CdpLocalWriter;
    readonly #records:CdpLocalRecord[]=[];
    #bytes=0;
    #writing=false;
    #dropped=0;
    constructor(writer:CdpLocalWriter=(buffer,offset,done)=>write(1,buffer,offset,buffer.length-offset,null,(error,written)=>done(error,written))) {this.#writer=writer;}
    get droppedRecords():number {return this.#dropped;}
    record(value:string):void {
        try {
            const buffer=Buffer.from(value+'\n','utf8');
            if(buffer.length>16385||this.#records.length>=16||this.#bytes+buffer.length>262144){this.#drop();return;}
            this.#records.push({buffer,offset:0});this.#bytes+=buffer.length;this.#pump();
        }catch{this.#drop();}
    }
    #drop():void {this.#dropped=Math.min(2147483647,this.#dropped+1);}
    #pump():void {
        const record=this.#records[0];if(this.#writing||!record)return;
        this.#writing=true;
        try {this.#writer(record.buffer,record.offset,(error,written)=>this.#settled(record,error,written));}
        catch(error){this.#settled(record,error,0);}
    }
    #settled(record:CdpLocalRecord,error:unknown,written:number):void {
        if(!this.#writing||this.#records[0]!==record)return;
        this.#writing=false;
        const valid=!error&&Number.isInteger(written)&&written>0&&written<=record.buffer.length-record.offset;
        if(valid)record.offset+=written;else this.#drop();
        if(!valid||record.offset===record.buffer.length){this.#records.shift();this.#bytes-=record.buffer.length;}
        queueMicrotask(()=>this.#pump());
    }
}
