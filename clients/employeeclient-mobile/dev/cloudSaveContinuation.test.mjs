import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
test('personal saves retain pending recovery and single-flight after the obsolete forward writer is deleted',async()=>{
 const storage=new Map(),a={id:'file-1',name:'原件.txt'},c={account:'a',thread:'t'};
 let finish,count=0,renames=0;
 const saveCloudFile=async()=>{count++;return new Promise(resolve=>{finish=resolve;});};
 const source=ts.transpileModule(readFileSync(new URL('../src/files/cloudJobs.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText.replace(/^import .*;\r?\n/gm,'').replace(/^export /gm,'');
 const api=new Function('saveCloudFile','renameCloudFile','verifyCloudContent','sourceIdentity','localStorage','window',source+';return {startCloudJob,pendingCloudJob,cloudJobKey};')(saveCloudFile,async(_a,_c,file,name)=>{renames++;return {...file,name};},async()=>{},(a,c)=>[c.account,c.thread,a.id],{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},{dispatchEvent(){}});
 const own=api.cloudJobKey(a,c);
 storage.set('qn.cloud-pending:a',JSON.stringify([{key:own,forward:false,targetName:a.name,createdAt:Date.now(),state:'error'},{key:own.replace(':personal:',':group:'),forward:true,targetName:a.name,createdAt:Date.now(),state:'running'}]));
 assert.equal(api.pendingCloudJob(a,c).state,'error','an obsolete group intent cannot shadow a recoverable personal save');
 const job=api.startCloudJob(a,c,undefined,undefined,'新名称.txt');assert.equal(api.startCloudJob(a,c,undefined,undefined,'新名称.txt'),job);assert.equal(count,1);
 finish({id:'saved',name:a.name});const result=await job.promise;assert.equal(result.file.name,'新名称.txt');assert.equal(renames,1);assert.equal(result.attachment,undefined);assert.equal(storage.get('qn.forward:a'),undefined);assert.equal(api.pendingCloudJob(a,c).state,'error','an unrelated earlier save remains recoverable');
});
