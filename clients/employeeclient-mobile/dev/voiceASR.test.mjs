import test from 'node:test';import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';import {createHash} from 'node:crypto';
import {createRuntimeHandler} from '../server/business/runtime.mjs';import {createGateway} from '../server/gateway.mjs';import {PROJECT} from '../server/business/native-authority.mjs';
import {createVoiceASRJobs} from '../server/business/voice-asr-jobs.mjs';import {createPrivateAttachments} from '../server/business/private-attachments.mjs';
import {encryptedSource} from '../shared/private-media.mjs';import {createVoiceASRProvider,VOICE_LIMIT} from '../server/business/voice-asr-provider.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex');
const actors=['a','b','c'].map(actor_id=>({actor_id,display_name:actor_id,project_id:PROJECT,can_read:true,can_write:true}));
async function fixture(t){
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());let bytes,fixed,sends=0,recognize=async()=>({text:'合成语音文字'}),metadata={purpose:'voice',mime:'audio/wav'},disabled=false;
 const sessionFactory=async cookie=>({context:{...actors.find(x=>x.actor_id===cookie),...disabled?{can_read:false,can_write:false}:{}},directory:async()=>actors,rpc:async name=>name==='mem.version.read'?{fixed_ref:fixed}:{properties:{employeeclient:metadata}},fileStream:async()=>new Response(bytes)});
 const handler=createRuntimeHandler(db,{sessionFactory,voiceProviderLoader:async()=>({recognize:async(...args)=>{sends++;return recognize(...args);}})});t.after(()=>handler.close());
 const server=createGateway({publicOrigin:'https://test.invalid',businessHandler:handler});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{server.closeAllConnections();server.close();});
 const call=(actor,path,body,key='operation')=>fetch('http://127.0.0.1:'+server.address().port+'/business/v1/'+path,{method:body===undefined?'GET':'POST',headers:{cookie:actor,origin:'https://test.invalid',...(body===undefined?{}:{'content-type':'application/json','idempotency-key':key})},...(body===undefined?{}:{body:JSON.stringify(body)})});
 const setFixed=()=>fixed={project_id:PROJECT,material_id:'cfe3f0af-af84-4c63-a0d6-2d0677caaddd',version_id:'8662ae87-2e86-405e-aa76-c2b6e807b0b1',sha256:sha(bytes),size:bytes.length};
 async function upload(){
  const original=Buffer.from('synthetic voice bytes');const grant=await(await call('a','private-attachments',{peer:'b',name:'voice.wav',mime:'audio/wav',size:original.length,sha256:sha(original),purpose:'voice',duration_ms:2000},'upload')).json();
  const encrypted=await encryptedSource(new Blob([original]),grant);bytes=Buffer.from(await(await encrypted.readPart(0,encrypted.size)).arrayBuffer());setFixed();
  const attachment=(await(await call('a','private-attachments/'+grant.id+'/bind',{fixed_ref:fixed})).json()).attachment;
  const sent=await call('a','messages',{body:'',attachment_ids:[attachment.id],recipient_username:'b'},'send');assert.equal(sent.status,201);const message=(await sent.json()).message;
  return {original,grant,attachment,message,input:{project_id:PROJECT,private_attachment_id:attachment.id,sha256:sha(original)}};
 }
 const prepare=async(actor,input,key='prepare')=>{const response=await call(actor,'voice-asr/prepare',{input,external_audio_release:true},key);return {status:response.status,...await response.json()};};
 return {db,call,prepare,upload,sends:()=>sends,recognize:fn=>recognize=fn,disable:()=>disabled=true,corrupt:()=>bytes[0]^=1,group:()=>{bytes=Buffer.from('group synthetic audio');setFixed();return {...fixed};},metadata:m=>metadata=m};
}
test('private HTTP voice flow sends authenticated plaintext once and keeps results in the requesting personal record',async t=>{
 const f=await fixture(t),{input,original}=await f.upload();
 f.recognize(async(bytes,mime)=>{assert.deepEqual(bytes,original);assert.equal(mime,'audio/wav');return {text:'合成语音文字'};});
 const j=await f.prepare('b',input);assert.equal(j.state,'prepared');assert.equal(f.sends(),0);
 assert.equal((await f.prepare('c',input,'third')).status,404);
 assert.equal((await f.call('a','voice-asr/status?job_id='+j.job_id)).status,404);
 const done=await(await f.call('b','voice-asr/start',{job_id:j.job_id})).json();assert.equal(done.state,'completed');assert.equal(done.result.text,'合成语音文字');assert.equal(done.scope,'personal');assert.equal(done.result.fixed_ref,undefined);
 await f.call('b','voice-asr/start',{job_id:j.job_id});assert.equal(f.sends(),1);
 assert.equal((await(await f.call('b','voice-asr/status?job_id='+j.job_id)).json()).result.text,done.result.text);
 assert.deepEqual((await(await f.call('b','files')).json()).files,[]);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM personal_voice_asr_jobs WHERE actor=?').get('c').n,0);
});
test('overlapping conversions share one send and a hidden attachment cannot reveal the saved result',async t=>{
 const f=await fixture(t),{input,original,message}=await f.upload();let release;const gate=new Promise(r=>release=r);
 f.recognize(async(bytes,mime)=>{assert.deepEqual(bytes,original);assert.equal(mime,'audio/wav');await gate;return {text:'private result'};});
 const j=await f.prepare('b',input);const one=f.call('b','voice-asr/start',{job_id:j.job_id}),two=f.call('b','voice-asr/start',{job_id:j.job_id});
 for(let i=0;i<100&&f.sends()===0;i++)await new Promise(r=>setTimeout(r,2));assert.equal(f.sends(),1);
 await f.call('b','messages/'+message.id+'/hide',{},'hide');release();assert.equal((await one).status,404);assert.equal((await two).status,404);assert.equal(f.sends(),1);
 assert.equal((await f.call('b','voice-asr/status?job_id='+j.job_id)).status,404);
});
test('unknown supplier outcome never dispatches again; definite refusal can retry the same original job',async t=>{
 const f=await fixture(t),{input}=await f.upload();const j=await f.prepare('a',input);
 f.recognize(async()=>{throw Object.assign(Error('lost'),{code:'voice_asr_submission_unconfirmed',not_started:false});});
 assert.equal((await(await f.call('a','voice-asr/start',{job_id:j.job_id})).json()).state,'submission_unknown');
 await f.call('a','voice-asr/start',{job_id:j.job_id});assert.equal(f.sends(),1);
 const g=await fixture(t),v=await g.upload(),k=await g.prepare('a',v.input);
 g.recognize(async()=>{throw Object.assign(Error('refused'),{code:'voice_asr_provider_busy',not_started:true});});
 assert.equal((await(await g.call('a','voice-asr/start',{job_id:k.job_id})).json()).state,'blocked');
 g.recognize(async()=>({text:'ok'}));assert.equal((await(await g.call('a','voice-asr/start',{job_id:k.job_id})).json()).state,'completed');assert.equal(g.sends(),2);
});
test('corrupt source and revoked account stop before model send; group source uses the same private result ledger',async t=>{
 const f=await fixture(t),{input}=await f.upload(),j=await f.prepare('a',input);f.corrupt();
 assert.equal((await(await f.call('a','voice-asr/start',{job_id:j.job_id})).json()).state,'blocked');assert.equal(f.sends(),0);f.disable();assert.equal((await f.call('a','voice-asr/start',{job_id:j.job_id})).status,403);
 const g=await fixture(t),source=g.group(),job=await g.prepare('c',source);assert.equal(job.status,200);
 assert.equal((await(await g.call('c','voice-asr/start',{job_id:job.job_id})).json()).state,'completed');assert.equal(g.sends(),1);
 assert.equal((await g.call('a','voice-asr/status?job_id='+job.job_id)).status,404);
 g.metadata({internal_encrypted:true,mime:'audio/wav'});assert.equal((await g.prepare('b',source,'bad')).status,422);
});
test('native supplier adapter sends inline audio once, stores the task, and reads the HTTPS result without credentials',async()=>{
 const calls=[],task='cfe3f0af-af84-4c63-a0d6-2d0677caaddd';let accepted;
 const provider=createVoiceASRProvider({api_key:'synthetic-test-key'},{fetcher:async(url,options={})=>{
  calls.push({url,options});
  if(url.endsWith('/transcription')){const body=JSON.parse(options.body);assert.equal(body.model,'qwen3-asr-flash-filetrans');assert.equal(body.input.file_url,'data:audio/wav;base64,eA==');return Response.json({output:{task_id:task,task_status:'PENDING'}});}
  if(url.includes('/tasks/'))return Response.json({output:{task_id:task,task_status:'SUCCEEDED',result:{transcription_url:'http://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/synthetic.json?signed=fixture'}}});
  assert.ok(url.startsWith('https://'));assert.equal(options.headers?.authorization,undefined);return Response.json({transcripts:[{text:'recognized speech'}]});
 }});
 const result=await provider.recognize(Buffer.from('x'),'audio/wav',{onAccepted:id=>accepted=id});assert.equal(result.text,'recognized speech');assert.equal(accepted,task);assert.equal(calls.length,3);
 assert.equal((await provider.resume(task)).text,result.text);assert.equal(calls.filter(x=>x.url.endsWith('/transcription')).length,1);
 await assert.rejects(provider.recognize(Buffer.alloc(VOICE_LIMIT+1),'audio/wav'),e=>e.not_started===true);
 for(const [status,safe] of [[403,true],[429,true],[500,false]]){const p=createVoiceASRProvider({api_key:'secret'},{fetcher:async()=>Response.json({message:'never expose supplier body'},{status})});await assert.rejects(p.recognize(Buffer.from('x'),'audio/wav'),e=>e.not_started===safe&&!e.message.includes('supplier body'));}
});

test('supplier task is durably recorded before waiting; result re-entry never resubmits audio',async t=>{
 const f=await fixture(t),{input}=await f.upload(),j=await f.prepare('a',input),task='cfe3f0af-af84-4c63-a0d6-2d0677caaddd';
 f.recognize(async(_bytes,_mime,opts)=>{opts.onAccepted(task);throw Object.assign(Error('temporary result loss'),{code:'voice_asr_result_temporarily_unavailable',not_started:false});});
 const running=await(await f.call('a','voice-asr/start',{job_id:j.job_id})).json();assert.equal(running.state,'running');assert.equal(f.db.prepare('SELECT provider_task_id FROM personal_voice_asr_jobs WHERE id=?').get(j.job_id).provider_task_id,task);assert.equal(f.sends(),1);
 let reads=0;const restored=createVoiceASRJobs(f.db,{privateAttachments:createPrivateAttachments(f.db),providerLoader:async()=>({status:async id=>{assert.equal(id,task);reads++;return {state:'completed',result:{text:'original restored text'}};},recognize:()=>{throw Error('must not resubmit');}})});
 const complete=await restored.status(actors[0],j.job_id,{context:actors[0]});assert.equal(complete.result.text,'original restored text');assert.equal(reads,1);
 await restored.start(actors[0],j.job_id,{context:actors[0]});assert.equal(f.sends(),1);assert.equal(reads,1);
 await assert.rejects(restored.status(actors[1],j.job_id,{context:actors[1]}),e=>e.status===404);
});

test('overlapping restored status and poll share a supplier read, without caching access or sharing actors',async t=>{
 const f=await fixture(t),{input,message}=await f.upload(),j=await f.prepare('b',input),task='cfe3f0af-af84-4c63-a0d6-2d0677caaddd';
 f.db.prepare("UPDATE personal_voice_asr_jobs SET state='running',provider_task_id=? WHERE id=?").run(task,j.job_id);
 let reads=0,release,waiting;const started=new Promise(r=>waiting=r),gate=new Promise(r=>release=r);
 const jobs=createVoiceASRJobs(f.db,{privateAttachments:createPrivateAttachments(f.db),providerLoader:async()=>({status:async id=>{assert.equal(id,task);reads++;waiting();await gate;return {state:'completed',result:{text:'private restored result'}};}})});
 const session={context:actors[1]};
 const one=jobs.status(actors[1],j.job_id,session),two=jobs.poll(actors[1],j.job_id,session);await started;await new Promise(r=>setImmediate(r));
 const readCount=reads;
 await assert.rejects(jobs.status(actors[2],j.job_id,{context:actors[2]}),e=>e.status===404);
 await f.call('b','messages/'+message.id+'/hide',{},'hide-restored');release();
 const settled=await Promise.allSettled([one,two]);assert.ok(settled.every(x=>x.status==='rejected'&&x.reason.status===404));
 assert.equal(readCount,1);assert.equal(f.sends(),0);
 await assert.rejects(jobs.status(actors[1],j.job_id,session),e=>e.status===404);assert.equal(reads,1);
});

test('shared result observation reauthorizes each caller and a failed observation can be retried',async t=>{
 const f=await fixture(t),{input}=await f.upload(),j=await f.prepare('a',input),task='cfe3f0af-af84-4c63-a0d6-2d0677caaddd';
 f.db.prepare("UPDATE personal_voice_asr_jobs SET state='running',provider_task_id=? WHERE id=?").run(task,j.job_id);
 let reads=0,release,waiting;const started=new Promise(r=>waiting=r),gate=new Promise(r=>release=r);
 const jobs=createVoiceASRJobs(f.db,{privateAttachments:createPrivateAttachments(f.db),providerLoader:async()=>({status:async()=>{
  if(++reads===1)throw Object.assign(Error('temporary'),{code:'voice_asr_result_temporarily_unavailable'});
  waiting();await gate;return {state:'completed',result:{text:'saved result'}};
 }})});
 const session={context:actors[0]};await assert.rejects(jobs.status(actors[0],j.job_id,session),/temporary/);
 const one=jobs.status(actors[0],j.job_id,session),changed=jobs.poll(actors[0],j.job_id,{...session,reauthorize:async()=>({context:actors[1]})});
 await started;await new Promise(r=>setImmediate(r));release();
 const results=await Promise.allSettled([one,changed]);assert.equal(results[0].value.result.text,'saved result');assert.equal(results[1].reason.code,'session_changed');
 assert.equal(reads,2);assert.equal(f.sends(),0);
 assert.equal((await jobs.status(actors[0],j.job_id,session)).result.text,'saved result');assert.equal(reads,2);
});
