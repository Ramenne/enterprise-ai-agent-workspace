import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import ts from 'typescript';
import {sha256} from '@noble/hashes/sha2.js';
import {bytesToHex} from '@noble/hashes/utils.js';
async function fixture(isNative=false){
 const bytes=new TextEncoder().encode('uploaded original bytes'),blob=new Blob([bytes]),storage=new Map(),disk=new Map(),shared=[];let transfers=0,currentAccount='a',readGate;
 const context={account:'a',computer:'cloud',provider:'company',thread:'group'};
 const attachment={id:'material:version',version:'1:'+bytesToHex(sha256(bytes)),sha256:bytesToHex(sha256(bytes)),size:bytes.length,name:'report.txt',mime:'text/plain',kind:'file',resolveUrl:async()=>{transfers++;throw Error('must not resolve remote');}};
 const native={begin:async o=>{const id=String(disk.size);disk.set(id,{...o,parts:[],complete:false});return {id};},append:async o=>{const f=disk.get(o.id);f.parts.push(Uint8Array.from(Buffer.from(o.data,'base64')));},finish:async o=>{const f=disk.get(o.id),data=Buffer.concat(f.parts);assert.equal(data.length,o.size);if(bytesToHex(sha256(data))!==o.sha256)throw Error('integrity mismatch');f.complete=true;f.sha256=o.sha256;return {url:'file:///verified/report.txt'};},lookup:async o=>{for(const [id,f]of disk)if(f.complete&&f.key===o.key&&f.sha256===o.sha256)return {found:true,id,name:f.name,url:'file:///verified/report.txt',size:bytes.length,saved:false};return {found:false};},share:async o=>shared.push(o.id),release:async()=>{},remove:async o=>disk.delete(o.id)};
 const deps={isNativeFileUrl:()=>true,sha256,bytesToHex,cachedBlob:async key=>{const value=storage.get(key);if(readGate)await readGate;return value;},storeBlob:async(key,b,valid)=>{if(!valid())return false;storage.set(key,b);return true;},removeBlob:async key=>storage.delete(key),attachmentKey:async parts=>JSON.stringify(parts),cacheLease:account=>()=>currentAccount===account,resolveAttachmentKey:key=>key,rememberAttachmentAlias:()=>{},runCommand:()=>{transfers++;throw Error('must not retrieve remotely');},prepareBrowserSave:()=>{throw Error('not saving');},Capacitor:{isNativePlatform:()=>isNative,convertFileSrc:u=>u},registerPlugin:()=>native,navigator:{canShare:()=>true,share:async o=>shared.push(await o.files[0].text())}};
 const source=await readFile(new URL('../src/collaboration/media.ts',import.meta.url),'utf8');const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText.replace(/^import[^\n]+\n/gm,'');
 const key='__localReuse'+Math.random().toString(36).slice(2);globalThis[key]=deps;
 let module;try{module=await import('data:text/javascript;base64,'+Buffer.from(`const {${Object.keys(deps).join(',')}}=globalThis['${key}'];\n`+code).toString('base64'));}finally{delete globalThis[key];}
 return {module,attachment,context,blob,shared,transfers:()=>transfers,disk,storage,holdCacheRead:()=>{let release;readGate=new Promise(r=>release=r);return ()=>{readGate=undefined;release();};},changeAccount:()=>currentAccount='b'};
}
for(const isNative of [false,true])test((isNative?'Android':'PWA')+' retains uploaded bytes and shares without resolving or downloading',async()=>{
 const f=await fixture(isNative);assert.equal(await f.module.retainLocalAttachment(f.attachment,f.context,f.blob,new AbortController().signal),true);
 const reused=await f.module.findAttachment(f.attachment,f.context);assert.ok(reused);await reused.share();reused.dispose();assert.equal(f.shared.length,1);assert.equal(f.transfers(),0);
 assert.equal(await f.module.findAttachment({...f.attachment,id:'material:other-version',version:'2:other'},f.context),undefined);
 assert.equal(await f.module.findAttachment(f.attachment,{...f.context,account:'b'}),undefined);
});
test('local changed bytes cannot enter the verified cache',async()=>{
 const f=await fixture();await assert.rejects(f.module.retainLocalAttachment(f.attachment,f.context,new Blob(['different bytes']),new AbortController().signal));assert.equal(await f.module.findAttachment(f.attachment,f.context),undefined);assert.equal(f.transfers(),0);
});
test('cancelled local retention does not retrieve a cloud substitute',async()=>{
 const f=await fixture(true),ctl=new AbortController();ctl.abort();await assert.rejects(f.module.retainLocalAttachment(f.attachment,f.context,f.blob,ctl.signal),e=>e.name==='AbortError');assert.equal(f.transfers(),0);assert.equal(f.disk.size,0);
});
test('opening an uploaded file waits for its in-flight local retention rather than downloading another copy',async()=>{
 const f=await fixture(false);let release,reading=false;const gate=new Promise(r=>release=r);
 const source={size:f.blob.size,readPart:async()=>{reading=true;await gate;return f.blob;}};
 const kept=f.module.retainUploadedAttachment(f.attachment,f.context,source,new AbortController().signal);let opened=false;
 const opening=f.module.findAttachment(f.attachment,f.context).then(m=>{opened=true;return m;});await new Promise(r=>setTimeout(r,0));assert.equal(reading,true);assert.equal(opened,false);
 release();assert.equal(await kept,true);const media=await opening;assert.ok(media);media.dispose();assert.equal(f.transfers(),0);
});

test('same-length corrupt browser cache is rejected by original SHA and removed',async()=>{
 const f=await fixture();await f.module.retainLocalAttachment(f.attachment,f.context,f.blob,new AbortController().signal);
 const key=[...f.storage.keys()][0];f.storage.set(key,new Blob([new Uint8Array(f.blob.size)]));
 assert.equal(await f.module.findAttachment(f.attachment,f.context),undefined);assert.equal(f.storage.has(key),false);
});
test('an old cache lookup cannot return bytes after account/cache lease invalidation',async()=>{
 const f=await fixture();await f.module.retainLocalAttachment(f.attachment,f.context,f.blob,new AbortController().signal);
 const release=f.holdCacheRead(),pending=f.module.findAttachment(f.attachment,f.context);await new Promise(r=>setImmediate(r));f.changeAccount();release();assert.equal(await pending,undefined);
});
