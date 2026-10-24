import test from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
import {readFile} from 'node:fs/promises';
async function fixture(overrides={}){
 const storage=new Map(),events=[];
 const deps={sourceIdentity:(a,c)=>[c.account,a.id],saveCloudFile:async()=>({name:'file'}),renameCloudFile:async(_a,_c,f,name)=>({...f,name}),verifyCloudContent:async()=>{},localStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},window:{dispatchEvent:e=>events.push({state:e.detail.state,key:e.detail.key})},CustomEvent:class{constructor(_name,{detail}){this.detail=detail;}},...overrides};
 const source=await readFile(new URL('../src/files/cloudJobs.ts',import.meta.url),'utf8');
 const js=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText.replace(/^import[^\n]*\n/gm,'').replace(/^export /gm,'');
 const mod=new Function(...Object.keys(deps),js+';return {startCloudJob,clearCloudJobs,getCloudJob,pendingCloudJob};')(...Object.values(deps));
 return {...mod,storage,events};
}
const attachment={id:'original',name:'file'},context={account:'a'};
test('cancel after verifying an existing file stops before remote rename or completion',async()=>{
 let release,renames=0;
 const f=await fixture({verifyCloudContent:()=>new Promise(resolve=>release=resolve),renameCloudFile:async()=>{renames++;return {name:'renamed'};}});
 const job=f.startCloudJob(attachment,context,{size:4},{name:'file'},'renamed');
 f.clearCloudJobs('a');release();await assert.rejects(job.promise,error=>error.name==='AbortError');
 assert.equal(renames,0);assert.equal(f.storage.size,0);assert.ok(!f.events.some(e=>e.state==='complete'));
});
test('an old rejected job cannot overwrite its replacement recovery intent',async()=>{
 const pending=[];
 const f=await fixture({saveCloudFile:(_a,_c,signal)=>new Promise((resolve,reject)=>pending.push({signal,resolve,reject}))});
 const old=f.startCloudJob(attachment,context);f.clearCloudJobs('a');const replacement=f.startCloudJob(attachment,context);
 pending[0].reject(Error('old network failure'));await assert.rejects(old.promise);
 assert.equal(f.pendingCloudJob(attachment,context).state,'running');assert.equal(f.getCloudJob(attachment,context),replacement);
 f.clearCloudJobs('a');pending[1].reject(pending[1].signal.reason);await assert.rejects(replacement.promise);
});
test('stale completion cleanup cannot remove a replacement cancellation controller',async()=>{
 const pending=[];
 const f=await fixture({saveCloudFile:(_a,_c,signal)=>new Promise((resolve,reject)=>pending.push({signal,resolve,reject}))});
 const old=f.startCloudJob(attachment,context);f.clearCloudJobs('a');const replacement=f.startCloudJob(attachment,context);
 pending[0].resolve({name:'file'});await old.promise.catch(()=>{});
 f.clearCloudJobs('a');assert.equal(pending[1].signal.aborted,true);
 pending[1].reject(pending[1].signal.reason);await assert.rejects(replacement.promise);
});
