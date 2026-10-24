import test from 'node:test';import assert from 'node:assert/strict';
import {routeProjectASR} from '../server/hub-asr.mjs';
const json=(v,status=200)=>new Response(JSON.stringify(v),{status,headers:{'content-type':'application/json'}});
const headers={authorization:'Bearer synthetic-member-session',origin:'https://hufu.example.invalid/','content-type':'application/json'};
test('original actor and original run bind through registered use before ASR dispatch',async()=>{
 const calls=[];const fetcher=async(url,opts)=>{calls.push({url,opts});return json(url.endsWith('/directory')?{items:[{project_id:'p',use_id:'registered',name:'bailian-beijing-asr',mode:'asr',expires_at:'2099-01-01T00:00:00Z'}]}:{state:'authorized'});};
 await routeProjectASR('mem.asr.poll',{project_id:'p',run_id:'original'},{fetcher,headers,target:'bailian-beijing-asr'});
 assert.equal(calls.length,2);assert.ok(calls[1].url.endsWith('/project-use/execute'));
 const b=JSON.parse(calls[1].opts.body);assert.equal(b.parameters.job_id,'original');assert.equal(b.parameters.run_id,undefined);assert.equal(b.use_id,'registered');assert.equal(b.action,'poll');assert.equal(calls[1].opts.headers.authorization,headers.authorization);
});
test('missing, expired, wrong-project or ambiguous use never dispatches',async()=>{
 for(const items of [[],[{project_id:'other',use_id:'u',name:'asr',mode:'asr',expires_at:'2099-01-01T00:00:00Z'}],[{project_id:'p',use_id:'u',name:'asr',mode:'asr',expires_at:'2000-01-01T00:00:00Z'}]]){
 let calls=0;await assert.rejects(routeProjectASR('mem.asr.start',{project_id:'p',run_id:'original'},{headers,target:'asr',fetcher:async()=>{calls++;return json({items});}}),e=>e.code==='current_registered_asr_use_required');assert.equal(calls,1);
 }
});
test('directory denial has no direct-Mem fallback and a mismatched run never dispatches',async()=>{
 let calls=0;await assert.rejects(routeProjectASR('mem.asr.prepare',{project_id:'p',provider_target_id:'asr'},{headers,fetcher:async()=>{calls++;return json({error_code:'forbidden'},403);}}),e=>e.status===403);assert.equal(calls,1);
 const fetcher=async()=>json({items:[{project_id:'p',use_id:'u',name:'asr',mode:'asr',expires_at:'2099-01-01T00:00:00Z'}]});await assert.rejects(routeProjectASR('mem.asr.start',{project_id:'p',job_id:'one',run_id:'two'},{fetcher,headers,target:'asr'}),e=>e.code==='asr_job_identity_mismatch');
});

test('native start recovers expired fixed original behind existing registered use',async()=>{
 const source={material_id:'m',version_id:'v',sha256:'a'.repeat(64)};let statuses=0;const calls=[];
 const fetcher=async(url,opts)=>{
  const b=JSON.parse(opts.body);calls.push({url,b,headers:opts.headers});
  if(url.endsWith('/directory'))return json({items:[{project_id:'p',use_id:'registered',name:'asr',mode:'asr',expires_at:'2099-01-01T00:00:00Z'}]});
  if(url.endsWith('/asr/status'))return json({state:'continuation_authorized',technical_state:'prepared',send_authorized:true,input_fixed_ref:source,attempt:++statuses});
  if(url.endsWith('/processing-runs/query'))return json({run_id:'original',semantic_kind:'asr_transcription',technical_state:'prepared',revision:1,attempt:1,lease_until:'2000-01-01T00:00:00Z',inputs:[source],outputs:[]});
  if(url.endsWith('/processing-runs/resume'))return json({run_id:'original',attempt:2});
  assert.ok(url.endsWith('/project-use/execute'));assert.equal(b.use_id,'registered');assert.equal(b.parameters.job_id,'original');assert.equal(b.idempotency_key,'qn-asr-start:original:2');return json({state:'known'});
 };
 const result=await routeProjectASR('mem.asr.start',{project_id:'p',run_id:'original'},{fetcher,headers,target:'asr'});
 assert.equal((await result.json()).state,'known');assert.equal(calls.length,6);assert.ok(calls.every(c=>c.headers.authorization===headers.authorization));
});

test('failed model state reaches the ASR state machine; status needs no new model dispatch',async()=>{
 const calls=[];const response=await routeProjectASR('mem.asr.status',{project_id:'p',run_id:'original'},{headers,fetcher:async(url,opts)=>{calls.push(url);assert.equal(JSON.parse(opts.body).job_id,'original');return json({state:'failed',technical_state:'failed'});}});
 assert.equal((await response.json()).state,'failed');assert.equal(calls.length,1);assert.ok(calls[0].endsWith('/mem/v2/asr/status'));
});

test('pre-dispatch denial is retryable, lost execute reply remains unknown',async()=>{
 const items=[{project_id:'p',use_id:'registered',name:'asr',mode:'asr',expires_at:'2099-01-01T00:00:00Z'}];
 await assert.rejects(routeProjectASR('mem.asr.start',{project_id:'p',job_id:'original'},{headers,target:'asr',fetcher:async()=>json({error_code:'forbidden'},403)}),e=>e.not_started===true&&e.code==='forbidden');
 const source={material_id:'m',version_id:'v',sha256:'a'.repeat(64)};
 for(const failAt of ['query','execute']){
 const calls=[];const fetcher=async(url,o)=>{calls.push(url);if(url.endsWith('/directory'))return json({items});if(url.endsWith('/asr/status'))return json({state:'authorized',technical_state:'prepared',dispatch_state:'prepared',send_authorized:true,input_fixed_ref:source,attempt:1});
 if(url.endsWith('/processing-runs/query')){if(failAt==='query')throw Error('connection lost');return json({attempt:1,lease_until:'2099-01-01T00:00:00Z'});}
 throw Error('connection lost');};
 await assert.rejects(routeProjectASR('mem.asr.start',{project_id:'p',job_id:'original'},{headers,target:'asr',fetcher}),e=>failAt==='query'?e.not_started===true:e.not_started!==true);
 assert.equal(calls.filter(u=>u.endsWith('/execute')).length,failAt==='execute'?1:0);
 }
});
