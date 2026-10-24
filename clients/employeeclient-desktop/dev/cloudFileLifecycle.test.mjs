import test from 'node:test';import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';import ts from 'typescript';
import {sha256} from '@noble/hashes/sha2.js';import {bytesToHex} from '@noble/hashes/utils.js';
async function fixture(){
 let account='a',cacheEpoch=0,writes=0,release,renameSignal,renames=0;
 const storage=new Map();
 const deps={sha256,bytesToHex,attachmentRevision:a=>a.version||'v',cacheLease:()=>{const epoch=cacheEpoch;return()=>epoch===cacheEpoch;},captureApiLease:()=>{const owner=account;return {account:owner,valid:()=>owner===account};},localStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>{writes++;storage.set(k,v);}},resolveNativeFile:()=>new Promise(resolve=>release=resolve),renameNativeFile:(_f,_name,signal)=>{renames++;renameSignal=signal;return new Promise(resolve=>release=resolve);}};
 const source=await readFile(new URL('../src/files/cloud.ts',import.meta.url),'utf8');
 const js=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText.replace(/^import[^\n]*\n/gm,'').replace(/^export /gm,'');
 const mod=new Function(...Object.keys(deps),js+';return {lookupCloudFile,renameCloudFile,seed:retain};')(...Object.values(deps));
 return {...mod,setAccount:a=>account=a,resetCache:()=>cacheEpoch++,finish:value=>release(value),counts:()=>({writes,renames}),signal:()=>renameSignal};
}
const a={id:'attachment',name:'x',size:4},c={account:'a',computer:'cloud',provider:'personal',thread:'library'},file={id:'m:v',name:'x',state:'ready',size:4,fixed_ref:{material_id:'m',version_id:'v'}};
for(const reason of ['identity','cache'])test(`a late file lookup after ${reason} invalidation cannot rewrite the old cache`,async()=>{
 const f=await fixture();f.seed(a,c,file);const work=f.lookupCloudFile(a,c);
 if(reason==='identity')f.setAccount('b');else f.resetCache();
 f.finish({file:{...file,name:'late'}});await assert.rejects(work,error=>error.name==='AbortError');assert.equal(f.counts().writes,1);
});
test('old-context rename is rejected before any remote mutation',async()=>{
 const f=await fixture();f.setAccount('b');await assert.rejects(f.renameCloudFile(a,c,file,'new'),error=>error.name==='AbortError');assert.equal(f.counts().renames,0);
});
test('rename passes its cancellation signal through and never retains a late result after pause',async()=>{
 const f=await fixture(),ctl=new AbortController();const work=f.renameCloudFile(a,c,file,'new',ctl.signal);assert.equal(f.signal(),ctl.signal);
 ctl.abort();f.finish({...file,name:'new'});await assert.rejects(work,error=>error.name==='AbortError');assert.equal(f.counts().writes,0);
});
