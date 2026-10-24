import {infrastructureFailure,domainErrorCode} from '../../platform/src/failure-contract.mjs';
import {createHash} from 'node:crypto';
export function installControlInbox(app,{pool}){
 const proof=req=>{const t=req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];if(!t||t.length>4096)throw Object.assign(Error('current_caller_required'),{status:401});return{token:t,hash:createHash('sha256').update(t).digest('hex')};};
 const safe=fn=>async(req,reply)=>{reply.header('cache-control','no-store');try{return await fn(req);}catch(e){const failure=infrastructureFailure(e,{permissionCode:e.message});return reply.code(e.status??failure?.status??(e.code==='40001'?409:e.code?.startsWith('22')?400:503)).send({state:'failed',error_code:failure?.code??(e.status||['40001','22023'].includes(e.code)?domainErrorCode(e.message,'control_dependency_unavailable'):'control_dependency_unavailable')});}};
 const v8=async(id,path,b)=>{const r=await fetch('http://127.0.0.1:4613'+path,{method:'POST',headers:{authorization:'Bearer '+id.token,'content-type':'application/json',...(b.idempotency_key?{'idempotency-key':b.idempotency_key}:{})},body:JSON.stringify(b),signal:AbortSignal.timeout(30000),redirect:'error'});const d=await r.json();if(!r.ok)throw Object.assign(Error(d.error_code||'cooperation_request_failed'),{status:r.status});return d;};
 app.post('/v2/control/submit',{logLevel:'silent'},safe(async req=>{
  const id=proof(req),b=req.body;
  if(!b||Array.isArray(b)||Object.keys(b).some(k=>!['project','project_id','work_item_id','work_no','to_actor_id','rationale','next_actions','context','idempotency_key'].includes(k))||typeof b.idempotency_key!=='string'||!b.idempotency_key)throw Object.assign(Error('invalid_input'),{status:400});
  const located=(await pool.query('SELECT authz.authorization_resolve($1,$2) result',[id.hash,{project:b.project,project_id:b.project_id}])).rows[0].result;
  if(located.state!=='resolved')return{...located,next_step:'choose_actual_project'};
  const pid=located.project.project_id||located.project.id,view=await v8(id,'/v2/projects/read',{project_id:pid});
  let wid=b.work_item_id;
  if(!wid){
   if(!Number.isSafeInteger(b.work_no)||b.work_no<1)throw Object.assign(Error('work_reference_required'),{status:400});
   const found=await v8(id,'/v2/work-items/search',{project_id:pid,query:'W-'+b.work_no,limit:100});
   const matches=(found.items||[]).filter(x=>Number(x.short_no)===b.work_no);if(matches.length!==1)throw Object.assign(Error('work_not_uniquely_located'),{status:404});wid=matches[0].id||matches[0].work_item_id;
  }
  const recipient=b.to_actor_id||view.project.manager_id;if(!recipient)throw Object.assign(Error('project_manager_required'),{status:409});
  const result=await v8(id,'/v2/handoffs',{project_id:pid,work_item_id:wid,to_actor_id:recipient,rationale:b.rationale??'',next_actions:b.next_actions??[],...(b.context?{context:b.context}:{}),idempotency_key:b.idempotency_key});
  return{...result,project_id:pid,work_item_id:wid,to_actor_id:recipient,permission_effect:'none',next_step:'sender_tracks_sent_inbox;recipient_tracks_received_inbox'};
 }));
 app.post('/v2/control/inbox',{logLevel:'silent'},safe(async req=>{
  const id=proof(req),b=req.body??{};
  if(!b||Array.isArray(b)||Object.keys(b).some(k=>!['view','project_id','state','limit','offset','include_permissions'].includes(k)))throw Object.assign(Error('invalid_input'),{status:400});
  const args={...b};delete args.include_permissions;
  const cooperation=(await pool.query('SELECT v8.handoff_inbox_for_member($1,$2) result',[id.hash,args])).rows[0].result;
  let permissions={state:'not_requested'},complete=cooperation.complete;
  if(b.include_permissions!==false){
   try{
    const r=await fetch('http://127.0.0.1:4611/v2/authorization/applications',{method:'POST',headers:{authorization:'Bearer '+id.token,'content-type':'application/json'},body:JSON.stringify({view:b.view==='sent'?'mine':'pending'}),signal:AbortSignal.timeout(30000),redirect:'error'});
    if(!r.ok)throw Error('authorization_inbox_unavailable');permissions=await r.json();complete=complete&&permissions.complete===true;
   }catch{permissions={state:'unavailable',error_code:'authorization_inbox_unavailable'};complete=false;}
  }
  return{state:'read',cooperation,permissions,complete,policy:'one_inbox;original_authorities_retained;coordination_status_is_not_permission_or_execution',next_step:'use_handoff_record_for_cooperation;permission_requests_use_Hufu;progress_and_results_use_handoff_progress'};
 }));
 app.post('/v2/control/resolve-engineering',{logLevel:'silent'},safe(async req=>{
  const id=proof(req),b=req.body;
  if(!b||Array.isArray(b)||Object.keys(b).some(k=>!['request_id','expected_revision','result'].includes(k)))throw Object.assign(Error('invalid_input'),{status:400});
  return(await pool.query('SELECT authz.control_resolve_engineering($1,$2) result',[id.hash,b])).rows[0].result;
 }));
 app.get('/v2/control/help',{logLevel:'silent'},async()=>({state:'ready',version:'control-cooperation-v1',submit:{system:'hufu',path:'/v2/control/submit',tool:'hub.cooperation.submit',fields:['project OR project_id','work_no OR work_item_id','to_actor_id?:defaults_to_current_project_manager','rationale?','next_actions?','context?','idempotency_key'],underlying:'existing_V8_handoff_record;not_a_second_work_ledger'},inbox:{system:'hufu',path:'/v2/control/inbox',views:['received','sent']},progress:{system:'v8',path:'/v2/handoffs/progress',fields:['project_id','handoff_id','expected_revision','handling_state','summary?','outputs?','limitations?','idempotency_key']},states:['submitted','in_progress','needs_information','waiting_external','delivered','confirmed','declined','withdrawn'],rules:['Reuse actual project/work;platform derives caller.','Sender submits/withdraws/confirms;recipient handles/delivers.','Current source/qualification/software scope applies;no credential transfer.','Permissions remain original Hufu approvals;resources are created via actual project engineering.','Delivered is executor declaration with fixed outputs and limitations,not automatic product acceptance.'],resolve_engineering:{path:'/v2/control/resolve-engineering',effect:'close_actual_execution_request_with_result_without_regranting_engineering'}}));
}
