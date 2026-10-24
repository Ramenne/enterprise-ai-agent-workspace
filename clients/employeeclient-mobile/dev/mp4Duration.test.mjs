import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';

const bundle=await build({entryPoints:['src/chat/mp4Duration.ts'],bundle:true,write:false,format:'esm'});
const {fragmentedMp4Duration}=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'));
const word=n=>{const b=Buffer.alloc(4);b.writeUInt32BE(n);return b;};
const box=(type,...parts)=>{const data=Buffer.concat(parts);return Buffer.concat([word(data.length+8),Buffer.from(type),data]);};

test('fragmented audio uses tfdt and trun rather than zero mvhd duration',()=>{
 const tkhd=Buffer.alloc(32);tkhd[0]=1;tkhd.writeUInt32BE(1,20);
 const mdhd=Buffer.alloc(32);mdhd[0]=1;mdhd.writeUInt32BE(48000,20);
 const hdlr=Buffer.alloc(12);hdlr.write('soun',8);
 const moov=box('moov',box('trak',box('tkhd',tkhd),box('mdia',box('mdhd',mdhd),box('hdlr',hdlr))));
 const fragment=(base,durations)=>{
  const tfhd=box('tfhd',Buffer.alloc(4),word(1));
  const tfdt=box('tfdt',Buffer.from([1,0,0,0]),word(0),word(base));
  const trun=box('trun',Buffer.from([0,0,1,0]),word(durations.length),...durations.map(word));
  return box('moof',box('traf',tfhd,tfdt,trun));
 };
 const file=Buffer.concat([box('ftyp',Buffer.from('isom')),moov,fragment(0,[24000,24000]),fragment(48000,[24000,24000]),box('mdat',Buffer.from('payload'))]);
 assert.equal(fragmentedMp4Duration(file),2);
 assert.equal(fragmentedMp4Duration(file.subarray(0,20)),0);
});
