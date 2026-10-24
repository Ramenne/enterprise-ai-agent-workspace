import test from 'node:test';import assert from 'node:assert/strict';
import {transcribeOperation} from '../src/chat/transcription-operation.mjs';
const input={project_id:'p',material_id:'m',version_id:'v',sha256:'a'.repeat(64)};
test('single product flow restores saved text without another start',async()=>{
 let state=null,starts=0,finished=false;const request=async(_method,action)=>{if(action==='prepare')return {job_id:'local'};if(action==='start'){starts++;finished=true;}return finished?{state:'completed',result:{text:'English result'}}:{state:'prepared'};};
 const opts={load:()=>state,save:s=>state=structuredClone(s)};
 assert.equal((await transcribeOperation(request,input,opts)).text,'English result');assert.equal((await transcribeOperation(request,input,opts)).text,'English result');assert.equal(starts,1);
});
test('old original run is an attach hint to the one prepare endpoint',async()=>{
 const calls=[];await transcribeOperation(async(method,action,opts)=>{calls.push({method,action,opts});return action==='prepare'?{job_id:'local'}:{state:'completed',result:{text:'Existing text'}};},input,{originalRun:'original'});
 assert.equal(calls[0].opts.body.original_run_id,'original');assert.deepEqual(calls.map(c=>c.action),['prepare','status']);
});
test('unknown send, unsupported state or empty completed result stops loading promptly',async()=>{
 const saved={identity:JSON.stringify(['p','m','v',input.sha256]),job:'local',prepareKey:'same'};
 for(const result of [{state:'submission_unknown'},{state:'surprise'},{state:'completed',result:{text:''}}]){
  let calls=0;await assert.rejects(transcribeOperation(async()=>{calls++;return result;},input,{load:()=>saved}));assert.equal(calls,1);
 }
});
test('queued progress differs from running, and cancellation does not create another request',async()=>{
 const saved={identity:JSON.stringify(['p','m','v',input.sha256]),job:'local',prepareKey:'same'},phases=[];let polls=0;
 const result=await transcribeOperation(async(_method,action)=>action==='status'?{state:'queued'}:++polls===1?{state:'running'}:{state:'completed',result:{text:'done'}},input,{load:()=>saved,wait:async()=>{},onProgress:s=>phases.push(s)});
 assert.equal(result.text,'done');assert.ok(phases.includes('正在等待转写服务…'));assert.ok(phases.includes('正在转文字…'));
 const abort=new AbortController();abort.abort();await assert.rejects(transcribeOperation(async()=>{throw Error('must not send');},input,{signal:abort.signal}),e=>e.name==='AbortError');
});

test('business transport preserves ASR domain failure for the single user-facing handler',async()=>{
 const {businessRequest}=await import('../src/native/business-transport.mjs');
 const saved={identity:JSON.stringify(['p','m','v',input.sha256]),job:'local',prepareKey:'same'};
 for(const v of [{job_id:'local',state:'failed',reason_code:'provider_failed'},{job_id:'local',state:'blocked',reason_code:'revision_conflict'}]){
  await assert.rejects(transcribeOperation((method,action,options)=>businessRequest('https://app.example.com',method,'/business/v1/asr/'+action,{lease:{valid:()=>true},query:options.query,fetcher:async()=>Response.json(v)}),input,{load:()=>saved}),/失败|版本已变化/);
 }
});

test('completed prepare response is reused without an extra status or model start',async()=>{const calls=[];const r=await transcribeOperation(async(_method,action)=>{calls.push(action);return {job_id:'local',state:'completed',result:{text:'already finished'}};},input);assert.equal(r.text,'already finished');assert.deepEqual(calls,['prepare']);});

test('private inline operation waits on its original start without a client polling timer',async()=>{
 const source={project_id:'p',private_attachment_id:'private:attachment',sha256:'a'.repeat(64)},calls=[];let saved;
 const request=async(_method,action)=>{calls.push(action);if(action==='prepare')return {job_id:'private-job',state:'prepared',transport:'inline'};return {job_id:'private-job',state:'completed',transport:'inline',result:{text:'private text'}};};
 assert.equal((await transcribeOperation(request,source,{inline:true,load:()=>saved,save:s=>saved=structuredClone(s)})).text,'private text');assert.deepEqual(calls,['prepare','start']);
 calls.length=0;assert.equal((await transcribeOperation(async(_method,action)=>{calls.push(action);return action==='status'?{state:'running',transport:'inline'}:{state:'completed',transport:'inline',result:{text:'recovered'}};},source,{inline:true,load:()=>saved,wait:()=>{throw Error('must not poll');}})).text,'recovered');assert.deepEqual(calls,['status','start']);
});
