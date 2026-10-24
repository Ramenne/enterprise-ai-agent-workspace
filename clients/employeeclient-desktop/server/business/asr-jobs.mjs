import {randomUUID,createHash} from 'node:crypto';
import {assertBusinessWrite} from './native-authority.mjs';
import {transcriptText} from '../../src/native/transcript-text.mjs';
const PROJECT='ad44cc0e-159e-4e0f-a5ca-73d3920240d9';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const fail=(code,status=400)=>{throw Object.assign(Error(code),{code,status});};
// One actor-bound product ledger. Keep the historical table name and records;
// all execution now uses the current member's registered hub ASR use.
export function createASRJobs(db,{verifySource,readOutput}={}){
 db.exec('CREATE TABLE IF NOT EXISTS qn_central_asr_jobs(id TEXT PRIMARY KEY,actor TEXT NOT NULL,source_key TEXT NOT NULL,source_json TEXT NOT NULL,prepare_key TEXT NOT NULL,remote_id TEXT,start_requested INTEGER NOT NULL DEFAULT 0,result_json TEXT,UNIQUE(actor,source_key),UNIQUE(actor,prepare_key))');
 // Share only overlapping remote observations for the same actor/run. Never
 // cache completed authority or coalesce another actor's private result.
 const remoteFlights=new Map(),startFlights=new Map();
 const observe=(ctx,row,session,action,args={project_id:PROJECT,job_id:row.remote_id})=>{
  const key=JSON.stringify([ctx.actor_id,row.remote_id||row.id,action]);
  if(remoteFlights.has(key))return remoteFlights.get(key);
  const flight=Promise.resolve().then(()=>session.asr(action,args)).finally(()=>{if(remoteFlights.get(key)===flight)remoteFlights.delete(key);});
  remoteFlights.set(key,flight);return flight;
 };
 const read=(ctx,id)=>{const r=db.prepare('SELECT * FROM qn_central_asr_jobs WHERE id=? AND actor=?').get(id,ctx.actor_id);if(!r)fail('asr_job_not_found',404);return r;};
 const check=async(ctx,row,session)=>{if(!ctx.can_read||ctx.project_id!==PROJECT)fail('project_read_denied',403);await verifySource(session,JSON.parse(row.source_json));};
 const view=async(ctx,row,session,action='status')=>{
  await check(ctx,row,session);
  if(row.result_json){
   const result=JSON.parse(row.result_json);
   if(!result.fixed_ref)fail('asr_result_reference_missing',502);
   await verifySource(session,{...result.fixed_ref,project_id:PROJECT});
   return {job_id:row.id,state:'completed',result};
  }
  if(!row.remote_id)return {job_id:row.id,state:'prepared'};
  const v=await observe(ctx,row,session,action);
  const outputs=v.outputs||v.fixed_refs;
  if(['published','completed'].includes(v.state)||['succeeded','completed'].includes(v.technical_state)){
   if(!Array.isArray(outputs)||!outputs.length)fail('asr_result_reference_missing',502);
   const f=outputs[0];if(!UUID.test(f.material_id||'')||!UUID.test(f.version_id||'')||!/^[a-f0-9]{64}$/.test(f.sha256||'')||(f.project_id&&f.project_id!==PROJECT))fail('asr_result_reference_invalid',502);
   const body=await readOutput(session,{...f,project_id:PROJECT});await check(ctx,row,session);
   const result={...transcriptText(body),fixed_ref:f,machineGenerated:true};
   db.prepare('UPDATE qn_central_asr_jobs SET result_json=? WHERE id=? AND actor=?').run(JSON.stringify(result),row.id,ctx.actor_id);
   return {job_id:row.id,state:'completed',result};
  }
  let state,error_code;
  if(['failed','canceled','cancelled'].includes(v.state)||v.technical_state==='failed'){state='failed';error_code=v.error_code||'asr_run_failed';}
  else if(['scope_needed','draft_ready_external_scope_needed','executor_unavailable'].includes(v.state)){state='blocked';error_code=v.state;}
  else if(['delivery_unknown','submission_unknown','submitting'].includes(v.state)||v.dispatch_state==='unknown'){state='submission_unknown';}
  else if(['running','processing'].includes(v.technical_state)||v.provider_task_status==='RUNNING'){state='running';}
  else if(v.intent_id||v.provider_task_id||v.dispatch_state==='known'){state='queued';}
  else if(v.dispatch_state==='prepared'&&v.technical_state==='prepared'&&!v.permit_id&&v.send_authorized===true&&['authorized','continuation_authorized'].includes(v.state)){state='prepared';}
  else if(row.start_requested){state='submission_unknown';}
  else {state='prepared';}
  return {job_id:row.id,state,...(error_code?{reason_code:error_code}:{})};
 };
 return {ready:true,
  async prepare(ctx,body,key,session){
   assertBusinessWrite(ctx,body);if(ctx.project_id!==PROJECT)fail('project_read_denied',403);if(!key||key.length>200||body.external_audio_release!==true)fail('asr_source_or_release_invalid');
   const input=body.input;if(!input||input.project_id!==PROJECT||!UUID.test(input.material_id||'')||!UUID.test(input.version_id||'')||!/^[a-f0-9]{64}$/.test(input.sha256||''))fail('asr_source_or_release_invalid');
   const source={project_id:PROJECT,material_id:input.material_id,version_id:input.version_id,sha256:input.sha256};await verifySource(session,source);
   const hash=createHash('sha256').update(JSON.stringify(source)).digest('hex');
   const keyed=db.prepare('SELECT * FROM qn_central_asr_jobs WHERE actor=? AND prepare_key=?').get(ctx.actor_id,key);if(keyed&&keyed.source_key!==hash)fail('idempotency_source_conflict',409);
   db.prepare('INSERT OR IGNORE INTO qn_central_asr_jobs(id,actor,source_key,source_json,prepare_key) VALUES(?,?,?,?,?)').run(randomUUID(),ctx.actor_id,hash,JSON.stringify(source),key);
   let row=db.prepare('SELECT * FROM qn_central_asr_jobs WHERE actor=? AND source_key=?').get(ctx.actor_id,hash);
   if(row.remote_id&&body.original_run_id&&body.original_run_id!==row.remote_id)fail('asr_original_binding_conflict',409);
   if(!row.remote_id){
    let id;
    if(body.original_run_id){
     if(!UUID.test(body.original_run_id))fail('asr_original_job_required');
     const original=await session.asr('status',{project_id:PROJECT,job_id:body.original_run_id});
     if(['material_id','version_id','sha256'].some(k=>original.input_fixed_ref?.[k]!==source[k]))fail('asr_original_source_mismatch',409);
     id=original.run_id||original.job_id;
     if(id!==body.original_run_id)fail('asr_original_source_mismatch',409);
    }else{
     const remote=await observe(ctx,row,session,'prepare',{project_id:PROJECT,input:{material_id:source.material_id,version_id:source.version_id,sha256:source.sha256},parameters:{},declaration:{source:'member_selected_voice_conversion'},idempotency_key:row.id});
     id=remote.job_id||remote.run_id;
    }
    if(!UUID.test(id||''))fail('asr_original_job_required',502);
    db.prepare('UPDATE qn_central_asr_jobs SET remote_id=? WHERE id=? AND remote_id IS NULL').run(id,row.id);row=read(ctx,row.id);
    if(row.remote_id!==id)fail('asr_original_binding_conflict',409);
   }return view(ctx,row,session);
  },
  async status(ctx,id,session){return view(ctx,read(ctx,id),session);},
  async poll(ctx,id,session){return view(ctx,read(ctx,id),session,'poll');},
  async start(ctx,id,session){
   let row=read(ctx,id);assertBusinessWrite(ctx,{});await check(ctx,row,session);
   if(!row.remote_id)fail('asr_prepare_not_complete',409);
   const key=JSON.stringify([ctx.actor_id,id]);
   const complete=async result=>{await check(ctx,read(ctx,id),session);if(result.result?.fixed_ref)await verifySource(session,{...result.result.fixed_ref,project_id:PROJECT});return result;};
   if(startFlights.has(key))return complete(await startFlights.get(key));
   const flight=(async()=>{
   const current=await view(ctx,row,session);if(current.state!=='prepared')return current;
   db.prepare('UPDATE qn_central_asr_jobs SET start_requested=1 WHERE id=? AND actor=? AND start_requested=0').run(id,ctx.actor_id);
   // The unique adapter rechecks the original run and uses the stable attempt key.
   // Explicit authoritative prepared state recovers a stale local claim.
   try{await session.asr('start',{project_id:PROJECT,job_id:row.remote_id,idempotency_key:row.id+'-start'});}catch(error){
    if(error.code==='revision_conflict'||error.not_started){
     db.prepare('UPDATE qn_central_asr_jobs SET start_requested=0 WHERE id=? AND actor=?').run(id,ctx.actor_id);
     return {job_id:id,state:'blocked',reason_code:error.code};
    }
    return {job_id:id,state:'submission_unknown'};
   }
   return view(ctx,read(ctx,id),session);
   })().finally(()=>{if(startFlights.get(key)===flight)startFlights.delete(key);});
   startFlights.set(key,flight);return complete(await flight);
  }
 };
}
