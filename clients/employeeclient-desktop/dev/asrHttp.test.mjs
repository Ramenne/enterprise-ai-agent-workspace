import test from 'node:test';import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';
import {createGateway} from '../server/gateway.mjs';import {createRuntimeHandler} from '../server/business/runtime.mjs';import {createASRJobs} from '../server/business/asr-jobs.mjs';import {transcribeOperation} from '../src/chat/transcription-operation.mjs';
const project='ad44cc0e-159e-4e0f-a5ca-73d3920240d9';
const input={project_id:project,material_id:'cfe3f0af-af84-4c63-a0d6-2d0677caaddd',version_id:'8662ae87-2e86-405e-aa76-c2b6e807b0b1',sha256:'a'.repeat(64)};
const remote='29c081d9-ff48-41c9-adbf-31b0b19c36b4';const output={material_id:'e42b7954-4934-4a5e-a23e-dcbc1ffd7b1f',version_id:'4bbf924c-a36c-4a86-ac04-7effd6c51110',sha256:'b'.repeat(64)};
test('single product HTTP chain prepares, starts, displays and restores; retired RPC cannot dispatch',async t=>{
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());let sends=0,done=false,upstream=0;
 const jobs=createASRJobs(db,{verifySource:async()=>{},readOutput:async()=>JSON.stringify({transcripts:[{text:'English result'}]})});
 const sessionFactory=async cookie=>({context:{actor_id:cookie,project_id:project,can_read:true,can_write:true},directory:async()=>[],asr:async action=>{if(action==='prepare')return {job_id:remote};if(action==='start'){sends++;done=true;}return done?{state:'completed',outputs:[output]}:{state:'authorized'};}});
 const server=createGateway({publicOrigin:'https://test.invalid',businessHandler:createRuntimeHandler(db,{sessionFactory,asrJobs:jobs}),fetcher:async()=>{upstream++;throw Error('retired path must not contact hub');}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{server.closeAllConnections();server.close();});const base='http://127.0.0.1:'+server.address().port;
 const request=async(method,action,options)=>{const url=new URL(base+'/business/v1/asr/'+action);if(options.query)for(const [k,v] of Object.entries(options.query))url.searchParams.set(k,String(v));const response=await fetch(url,{method,headers:{cookie:'a',origin:'https://test.invalid','content-type':'application/json',...(options.idempotencyKey?{'idempotency-key':options.idempotencyKey}:{})},...(options.body?{body:JSON.stringify(options.body)}:{})});const result=await response.json();assert.equal(response.status,200);return result;};
 let saved=null;const opts={load:()=>saved,save:s=>saved=structuredClone(s)};assert.equal((await transcribeOperation(request,input,opts)).text,'English result');assert.equal((await transcribeOperation(request,input,opts)).text,'English result');assert.equal(sends,1);
 const other=await fetch(base+'/business/v1/asr/status?job_id='+saved.job,{headers:{cookie:'b'}});assert.equal(other.status,404);
 for(const name of ['mem.asr.prepare','mem.asr.start','mem.asr.status','mem.asr.poll']){const denied=await fetch(base+'/native/rpc',{method:'POST',headers:{origin:'https://test.invalid','content-type':'application/json'},body:JSON.stringify({name,arguments:{project_id:project}})});assert.equal(denied.status,400);}
 assert.equal(upstream,0);
});
