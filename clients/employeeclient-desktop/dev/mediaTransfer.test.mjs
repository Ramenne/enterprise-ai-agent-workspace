import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import ts from 'typescript';
import {sha256} from '@noble/hashes/sha2.js';
import {bytesToHex} from '@noble/hashes/utils.js';

const source=await readFile(new URL('../src/collaboration/media.ts',import.meta.url),'utf8');
const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}})
  .outputText.replace(/^import[\s\S]*?from ['"][^'"]+['"];\s*$/gm,'');

async function transfer(direct){
  const actions=[],bytes=new TextEncoder().encode('hello');
  let next=0;
  const native={
    lookup:async()=>({found:false}),begin:async()=>({id:'native-'+(++next)}),
    addListener:async()=>({remove:async()=>{}}),
    fetch:async()=>{actions.push('direct');if(direct==='short')return {size:3};throw {code:direct};},
    append:async({id,data,offset})=>{actions.push(`append:${id}:${offset}:${atob(data).length}`);},
    finish:async({id,size})=>{actions.push(`finish:${id}:${size}`);return {url:'file:///verified.txt'};},
    remove:async({id})=>{actions.push(`remove:${id}`);},release:async()=>{},
  };
  const deps={sha256,bytesToHex,cachedBlob:async()=>undefined,storeBlob:async()=>true,
    attachmentKey:async()=> 'file-key',resolveAttachmentKey:k=>k,rememberAttachmentAlias(){},cacheLease:()=>()=>true,
    runCommand(){},prepareBrowserSave(){},Capacitor:{isNativePlatform:()=>true,convertFileSrc:u=>u},
    registerPlugin:()=>native};
  const key='__qn_media_'+Math.random().toString(36).slice(2);globalThis[key]=deps;
  const originalFetch=globalThis.fetch;
  globalThis.fetch=async()=>{actions.push('webview');return new Response(bytes,{status:200});};
  try{
    const mod=await import('data:text/javascript;base64,'+Buffer.from(`const {${Object.keys(deps).join(',')}}=globalThis['${key}'];\n`+code).toString('base64'));
    try{const result=await mod.loadAttachment({id:'file',name:'file.txt',mime:'text/plain',kind:'file',size:bytes.length,url:'https://example.test/verified.txt'},
      {account:'a',computer:'cloud',provider:'company',thread:'group'},new AbortController().signal,()=>{});
      result.dispose();return {actions};
    }catch(error){return {actions,error};}
  }finally{globalThis.fetch=originalFetch;delete globalThis[key];}
}

test('Android transfer failure never starts a second WebView download',async()=>{
  const {actions,error}=await transfer('ATTACHMENT_TRANSFER_TRUNCATED');
  assert.equal(error?.code,'ATTACHMENT_TRANSFER_TRUNCATED');
  assert.deepEqual(actions,['direct','remove:native-1']);
});

test('Android wrong byte count cannot be marked acquired or retried through a second stack',async()=>{
  const {actions,error}=await transfer('short');
  assert.match(error?.message||'',/长度校验失败/);
  assert.deepEqual(actions,['direct','remove:native-1']);
});

test('Android cache write failure is not misreported as a recoverable transfer',async()=>{
  const {actions,error}=await transfer('ATTACHMENT_CACHE_WRITE_FAILED');
  assert.equal(error?.code,'ATTACHMENT_CACHE_WRITE_FAILED');
  assert.deepEqual(actions,['direct','remove:native-1']);
});

test('a verified Android cache entry is reused for later file actions without resolving or downloading again',async()=>{
  const actions=[],bytes=new TextEncoder().encode('hello');let ready=false,lookups=0;
  const native={
    lookup:async()=>{lookups++;return ready?{found:true,id:'native-1',url:'file:///verified.txt',size:bytes.length,name:'file.txt',saved:false,location:''}:{found:false};},
    begin:async()=>{actions.push('begin');return {id:'native-1'};},
    addListener:async()=>({remove:async()=>{}}),
    fetch:async()=>{actions.push('fetch');return {size:bytes.length};},
    finish:async()=>{ready=true;actions.push('finish');return {url:'file:///verified.txt'};},
    share:async()=>{actions.push('share');},open:async()=>{actions.push('open');},
    save:async()=>{actions.push('save');return {saved:true,size:bytes.length,sha256:'a'.repeat(64),location:'下载/员工客户端'};},
    release:async()=>{},remove:async()=>{},
  };
  const deps={sha256,bytesToHex,cachedBlob:async()=>undefined,storeBlob:async()=>true,
    attachmentKey:async()=> 'file-key',resolveAttachmentKey:k=>k,rememberAttachmentAlias(){},cacheLease:()=>()=>true,
    runCommand(){},prepareBrowserSave(){},Capacitor:{isNativePlatform:()=>true,convertFileSrc:u=>u},registerPlugin:()=>native};
  const key='__qn_media_'+Math.random().toString(36).slice(2);globalThis[key]=deps;
  try{
    const mod=await import('data:text/javascript;base64,'+Buffer.from(`const {${Object.keys(deps).join(',')}}=globalThis['${key}'];\n`+code).toString('base64'));
    const a={id:'file',name:'file.txt',mime:'text/plain',kind:'file',size:bytes.length,url:'https://example.test/verified.txt'};
    const ctx={account:'a',computer:'cloud',provider:'company',thread:'group'};
    const first=await mod.loadAttachment(a,ctx,new AbortController().signal,()=>{});first.dispose();
    const second=await mod.loadAttachment(a,ctx,new AbortController().signal,()=>{});
    await second.open();await second.share();await second.save();second.dispose();
    assert.deepEqual(actions,['begin','fetch','finish','open','share','save']);
    assert.equal(lookups,2);
  }finally{delete globalThis[key];}
});
