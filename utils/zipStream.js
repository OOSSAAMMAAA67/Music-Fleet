'use strict';
// Stored ZIP64 preserves the exact source bytes and supports files/archives
// larger than 4 GiB without buffering media in memory or needing another CLI.
const fs = require('node:fs');
const table = new Uint32Array(256);
for (let n=0;n<256;n++) { let c=n; for(let b=0;b<8;b++) c=c&1 ? 0xedb88320^(c>>>1) : c>>>1; table[n]=c>>>0; }
function crcUpdate(crc, chunk) { for(const byte of chunk) crc=table[(crc^byte)&255]^(crc>>>8); return crc>>>0; }
function stamp(date=new Date()) { const y=Math.min(2107,Math.max(1980,date.getUTCFullYear())); return { time:(date.getUTCHours()<<11)|(date.getUTCMinutes()<<5)|(date.getUTCSeconds()>>1), date:((y-1980)<<9)|((date.getUTCMonth()+1)<<5)|date.getUTCDate() }; }
class ZipStream {
    constructor(handle,{signal}={}) { this.handle=handle;this.signal=signal;this.offset=0n;this.entries=[]; }
    async write(buffer) { this.signal?.throwIfAborted();let start=0;while(start<buffer.length){const {bytesWritten}=await this.handle.write(buffer,start,buffer.length-start,null);if(!bytesWritten)throw new Error('Archive write stopped.');start+=bytesWritten;this.offset+=BigInt(bytesWritten);} }
    async add(filename,file) {
        this.signal?.throwIfAborted();
        if(!filename || /[\x00-\x1f\\/]/.test(filename))throw new Error('Invalid archive filename.');
        const name=Buffer.from(filename),at=this.offset,s=stamp(),header=Buffer.alloc(30),extra=Buffer.alloc(20);
        header.writeUInt32LE(0x04034b50);header.writeUInt16LE(45,4);header.writeUInt16LE(0x808,6);header.writeUInt16LE(s.time,10);header.writeUInt16LE(s.date,12);header.writeUInt32LE(0xffffffff,18);header.writeUInt32LE(0xffffffff,22);header.writeUInt16LE(name.length,26);header.writeUInt16LE(extra.length,28);extra.writeUInt16LE(1);extra.writeUInt16LE(16,2);
        await this.write(header);await this.write(name);await this.write(extra);
        let crc=0xffffffff,size=0n;const stream=fs.createReadStream(file,{highWaterMark:256*1024,signal:this.signal});
        for await(const chunk of stream) { crc=crcUpdate(crc,chunk);size+=BigInt(chunk.length);await this.write(chunk); }
        crc=(crc^0xffffffff)>>>0;const descriptor=Buffer.alloc(24);descriptor.writeUInt32LE(0x08074b50);descriptor.writeUInt32LE(crc,4);descriptor.writeBigUInt64LE(size,8);descriptor.writeBigUInt64LE(size,16);await this.write(descriptor);
        this.entries.push({name,at,s,crc,size});return Number(size);
    }
    async finish() {
        const start=this.offset;
        for(const e of this.entries) {
            const h=Buffer.alloc(46),extra=Buffer.alloc(28);h.writeUInt32LE(0x02014b50);h.writeUInt16LE(45,4);h.writeUInt16LE(45,6);h.writeUInt16LE(0x808,8);h.writeUInt16LE(e.s.time,12);h.writeUInt16LE(e.s.date,14);h.writeUInt32LE(e.crc,16);h.writeUInt32LE(0xffffffff,20);h.writeUInt32LE(0xffffffff,24);h.writeUInt16LE(e.name.length,28);h.writeUInt16LE(extra.length,30);h.writeUInt32LE(0xffffffff,42);extra.writeUInt16LE(1);extra.writeUInt16LE(24,2);extra.writeBigUInt64LE(e.size,4);extra.writeBigUInt64LE(e.size,12);extra.writeBigUInt64LE(e.at,20);await this.write(h);await this.write(e.name);await this.write(extra);
        }
        const size=this.offset-start,endAt=this.offset,count=BigInt(this.entries.length),end=Buffer.alloc(56),locator=Buffer.alloc(20),legacy=Buffer.alloc(22);
        end.writeUInt32LE(0x06064b50);end.writeBigUInt64LE(44n,4);end.writeUInt16LE(45,12);end.writeUInt16LE(45,14);end.writeBigUInt64LE(count,24);end.writeBigUInt64LE(count,32);end.writeBigUInt64LE(size,40);end.writeBigUInt64LE(start,48);
        locator.writeUInt32LE(0x07064b50);locator.writeBigUInt64LE(endAt,8);locator.writeUInt32LE(1,16);
        legacy.writeUInt32LE(0x06054b50);legacy.writeUInt16LE(0xffff,8);legacy.writeUInt16LE(0xffff,10);legacy.writeUInt32LE(0xffffffff,12);legacy.writeUInt32LE(0xffffffff,16);
        await this.write(end);await this.write(locator);await this.write(legacy);await this.handle.sync();return Number(this.offset);
    }
}
module.exports={ZipStream,crcUpdate};
