import {createHash,randomUUID} from 'node:crypto';
import {PROJECT,assertBusinessWrite} from './native-authority.mjs';
import {VOICE_LIMIT,loadVoiceASRProvider} from './voice-asr-provider.mjs';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const fail=(code,status=400)=>{throw Object.assign(Error(code),{code,status,not_started:true});};
const sha=value=>createHash('sha256').update(value).digest('hex');
export function createVoiceASRJobs(db,{privateAttachments,verifyGroupSource,readGroupSource,legacyJobs,providerLoader=loadVoiceASRProvider}={}){
 // Each result belongs only to the authenticated requester. Personal data never
 // publishes into the group file/catalogue, even when its source was group audio.
 db.exec(`CREATE TABLE IF NOT EXISTS personal_voice_asr_jobs(id TEXT PRIMARY KEY,actor TEXT NOT NULL,source_key TEXT NOT NULL,source_json TEXT NOT NULL,prepare_key TEXT NOT NULL,state TEXT NOT NULL,result_json TEXT,reason_code TEXT,provider_task_id TEXT,UNIQUE(actor,source_key),UNIQUE(actor,prepare_key))`);
 db.exec('CREATE TABLE IF NOT EXISTS personal_voice_asr_keys(actor TEXT NOT NULL,prepare_key TEXT NOT NULL,source_key TEXT NOT NULL,PRIMARY KEY(actor,prepare_key))');
 if(!db.prepare('PRAGMA table_info(personal_voice_asr_jobs)').all().some(x=>x.name==='provider_task_id'))db.exec('ALTER TABLE personal_voice_asr_jobs ADD COLUMN provider_task_id TEXT');
 const flights=new Map(),observations=new Map();
 // Re-entry can overlap a status request from another view/device. Share only
 // its active supplier read, then recheck each caller's current source access.
 // No completed authorization or another actor's result enters this map.
 const observe=(ctx,row)=>{
  const key=JSON.stringify([ctx.actor_id,row.id,row.provider_task_id]);
  if(observations.has(key))return observations.get(key);
  const work=Promise.resolve().then(async()=>{
   const provider=await providerLoader();return provider.status(row.provider_task_id,{signal:AbortSignal.timeout(30000)});
  }).finally(()=>{if(observations.get(key)===work)observations.delete(key);});
  observations.set(key,work);return work;
 };
 const read=(ctx,id)=>db.prepare('SELECT * FROM personal_voice_asr_jobs WHERE id=? AND actor=?').get(id,ctx.actor_id);
 const checked=async(ctx,source,session)=>{
  if(!ctx.can_read||ctx.project_id!==PROJECT)fail('project_read_denied',403);
  if(source.private_attachment_id){
   const ref=source.private_attachment_id.replace(/^private:/,'');if(!UUID.test(ref))fail('voice_asr_source_invalid');
   const meta=privateAttachments.head(ctx,ref).attachment;
   if(meta.sha256!==source.sha256)fail('voice_asr_source_changed',409);
   if(meta.purpose!=='voice'&&!meta.mime.startsWith('audio/'))fail('voice_asr_source_invalid',422);
   if(meta.size>VOICE_LIMIT||meta.duration_ms>180000)fail('voice_asr_audio_too_large',413);
   return meta;
  }
  return verifyGroupSource(session,source);
 };
 const fresh=async(ctx,source,session)=>{
  const next=session.reauthorize?await session.reauthorize():session;
  if(next.context&&next.context.actor_id!==ctx.actor_id)fail('session_changed',401);
  const context=next.context||ctx;assertBusinessWrite(context,{});await checked(context,source,next);return next;
 };
 const view=row=>({job_id:row.id,state:row.state==='running'&&!row.provider_task_id&&!flights.has(row.id)?'submission_unknown':row.state,scope:'personal',transport:'inline',...(row.result_json?{result:JSON.parse(row.result_json)}:{}),...(row.reason_code?{reason_code:row.reason_code}:{})});
 return {
  async prepare(ctx,body,key,session){
   assertBusinessWrite(ctx,body);if(!key||key.length>200||body.external_audio_release!==true)fail('asr_source_or_release_invalid');
   const input=body.input;if(!input||input.project_id!==PROJECT||!/^[a-f0-9]{64}$/.test(input.sha256||''))fail('voice_asr_source_invalid');
   let source;
   if(input.private_attachment_id&&typeof input.private_attachment_id!=='string')fail('voice_asr_source_invalid');
   if(input.private_attachment_id)source={project_id:PROJECT,private_attachment_id:input.private_attachment_id,sha256:input.sha256};
   else{if(!UUID.test(input.material_id||'')||!UUID.test(input.version_id||''))fail('voice_asr_source_invalid');source={project_id:PROJECT,material_id:input.material_id,version_id:input.version_id,sha256:input.sha256};}
   await checked(ctx,source,session);const hash=sha(JSON.stringify(source));
   // Existing native runs stay attached, including ambiguous submissions. A new
   // interface must never silently create another paid run for the same source.
   if(!source.private_attachment_id&&body.original_run_id&&legacyJobs)return {...await legacyJobs.prepare(ctx,body,key,session),transport:'central'};
   if(!source.private_attachment_id&&legacyJobs&&db.prepare('SELECT 1 FROM qn_central_asr_jobs WHERE actor=? AND source_key=?').get(ctx.actor_id,hash))return {...await legacyJobs.prepare(ctx,body,key,session),transport:'central'};
   db.prepare('INSERT OR IGNORE INTO personal_voice_asr_keys VALUES(?,?,?)').run(ctx.actor_id,key,hash);
   const keyed=db.prepare('SELECT source_key FROM personal_voice_asr_keys WHERE actor=? AND prepare_key=?').get(ctx.actor_id,key);if(keyed.source_key!==hash)fail('idempotency_source_conflict',409);
   db.prepare("INSERT OR IGNORE INTO personal_voice_asr_jobs(id,actor,source_key,source_json,prepare_key,state) VALUES(?,?,?,?,?,'prepared')").run(randomUUID(),ctx.actor_id,hash,JSON.stringify(source),key);
   return view(db.prepare('SELECT * FROM personal_voice_asr_jobs WHERE actor=? AND source_key=?').get(ctx.actor_id,hash));
  },
  async status(ctx,id,session){
   let row=read(ctx,id);if(!row){if(legacyJobs)return {...await legacyJobs.status(ctx,id,session),transport:'central'};fail('asr_job_not_found',404);}
   const source=JSON.parse(row.source_json);await checked(ctx,source,session);
   if(row.state==='running'&&row.provider_task_id&&!flights.has(id)){
    let value;try{value=await observe(ctx,row);}catch(e){if(['voice_asr_run_failed','voice_asr_result_empty'].includes(e.code)){db.prepare("UPDATE personal_voice_asr_jobs SET state='failed',reason_code=? WHERE id=? AND actor=?").run(e.code,id,ctx.actor_id);return view(read(ctx,id));}throw e;}
    if(value.state==='completed'){if(typeof value.result?.text!=='string'||!value.result.text.trim()||Buffer.byteLength(value.result.text)>256*1024)fail('voice_asr_result_empty',502);db.prepare("UPDATE personal_voice_asr_jobs SET state='completed',result_json=?,reason_code=NULL WHERE id=? AND actor=?").run(JSON.stringify({...value.result,machineGenerated:true}),id,ctx.actor_id);}
    const next=session.reauthorize?await session.reauthorize():session;if(next.context&&next.context.actor_id!==ctx.actor_id)fail('session_changed',401);await checked(next.context||ctx,source,next);row=read(ctx,id);
   }
   return view(row);
  },
  async poll(ctx,id,session){const row=read(ctx,id);if(!row){if(legacyJobs)return {...await legacyJobs.poll(ctx,id,session),transport:'central'};fail('asr_job_not_found',404);}return this.status(ctx,id,session);},
  async start(ctx,id,session){
   const row=read(ctx,id);if(!row){if(legacyJobs)return {...await legacyJobs.start(ctx,id,session),transport:'central'};fail('asr_job_not_found',404);}
   assertBusinessWrite(ctx,{});const source=JSON.parse(row.source_json);await checked(ctx,source,session);
   const finish=async value=>{const next=session.reauthorize?await session.reauthorize():session;if(next.context&&next.context.actor_id!==ctx.actor_id)fail('session_changed',401);await checked(next.context||ctx,source,next);return value;};
   if(flights.has(id))return finish(await flights.get(id));
   if(row.state!=='prepared'&&!(row.state==='running'&&row.provider_task_id))return finish(view(row));
   if(flights.size>=3)fail('voice_asr_busy',429);
   const flight=(async()=>{
    // Loading, source access, and integrity failures happen before the single
    // persisted dispatch claim and remain safe to retry on the original job.
    let bytes,dispatch=!!row.provider_task_id;
    const ctl=new AbortController(),timer=setTimeout(()=>ctl.abort(),120000);
    try{
     const provider=await providerLoader();
     if(row.provider_task_id){await fresh(ctx,source,session);const result=await provider.resume(row.provider_task_id,{signal:ctl.signal});db.prepare("UPDATE personal_voice_asr_jobs SET state='completed',result_json=?,reason_code=NULL WHERE id=? AND actor=?").run(JSON.stringify({...result,machineGenerated:true}),id,ctx.actor_id);return view(read(ctx,id));}
     const current=await fresh(ctx,source,session);
     const audio=source.private_attachment_id?await privateAttachments.readVoice(current.context||ctx,source.private_attachment_id.replace(/^private:/,''),current,ctl.signal,VOICE_LIMIT):await readGroupSource(current,source,ctl.signal);
     bytes=audio.bytes;
     if(bytes.length>VOICE_LIMIT||sha(bytes)!==source.sha256)fail('voice_asr_source_changed',409);
     ctl.signal.throwIfAborted();await fresh(ctx,source,session);ctl.signal.throwIfAborted();
     const claim=db.prepare("UPDATE personal_voice_asr_jobs SET state='running',reason_code=NULL WHERE id=? AND actor=? AND state='prepared'").run(id,ctx.actor_id);
     if(!claim.changes)return view(read(ctx,id));
     dispatch=true;const result=await provider.recognize(bytes,audio.mime,{signal:ctl.signal,onAccepted:task=>{if(typeof task!=='string'||! /^[a-z0-9-]{16,100}$/i.test(task))throw Error('Invalid provider task');db.prepare('UPDATE personal_voice_asr_jobs SET provider_task_id=? WHERE id=? AND actor=?').run(task,id,ctx.actor_id);}});
     if(typeof result?.text!=='string'||!result.text.trim()||Buffer.byteLength(result.text)>256*1024)throw Object.assign(Error('voice_asr_result_empty'),{code:'voice_asr_result_empty'});
     db.prepare("UPDATE personal_voice_asr_jobs SET state='completed',result_json=?,reason_code=NULL WHERE id=? AND actor=?").run(JSON.stringify({...result,machineGenerated:true}),id,ctx.actor_id);
    }catch(e){
     const code=e.code||'voice_asr_submission_unconfirmed';
     const known=read(ctx,id).provider_task_id;
     const state=!dispatch||e.not_started===true?'prepared':['voice_asr_result_empty','voice_asr_run_failed'].includes(e.code)?'failed':known?'running':'submission_unknown';
     db.prepare('UPDATE personal_voice_asr_jobs SET state=?,reason_code=? WHERE id=? AND actor=?').run(state,code,id,ctx.actor_id);
     const value=view(read(ctx,id));return state==='prepared'?{...value,state:'blocked'}:value;
    }finally{clearTimeout(timer);bytes?.fill(0);}
    return view(read(ctx,id));
   })().finally(()=>{if(flights.get(id)===flight)flights.delete(id);});
   flights.set(id,flight);return finish(await flight);
  }
 };
}
