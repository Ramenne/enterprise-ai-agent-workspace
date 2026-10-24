import {infrastructureFailure,domainErrorCode} from '../../platform/src/failure-contract.mjs';
import{createHash}from'node:crypto';
const hash=s=>createHash('sha256').update(s).digest('hex');
const fields={list:['project_id'],create:['project_id','idempotency_key'],restore:['project_id','backup_id','idempotency_key'],operation:['project_id','operation_id'],resume:['project_id','operation_id','backup_id']};
// Hufu owns current identity/project authority. Installer supplies fixed 10-project target map.
export function installProjectBackups(app,{pool,serviceKey,executorUrl='http://127.0.0.1:4634/execute'}){
 const call=async(name,args)=>(await pool.query('select authz.'+name+'('+args.map((_,i)=>'$'+(i+1)).join(',')+') result',args)).rows[0].result;
 const proof=req=>{const t=req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];if(!t||t.length>4096)throw Object.assign(Error('unauthenticated'),{status:401});return t};
 const mode=action=>['list','operation'].includes(action)?'read':'write';
 for(const action of Object.keys(fields))app.post('/v2/engineering/backups/'+action,{logLevel:'silent'},async(req,reply)=>{
  reply.header('cache-control','no-store');try{
   const b=req.body??{};if(!b||Array.isArray(b)||Object.keys(b).some(k=>!fields[action].includes(k)))throw Object.assign(Error('invalid_backup_input'),{status:400});
   const token=proof(req),identity=await call('engineering_access',[hash(token),b.project_id,mode(action)]);
   const response=await fetch(executorUrl,{method:'POST',redirect:'error',signal:AbortSignal.timeout(15000),headers:{'content-type':'application/json','x-hub-resource-key':serviceKey,authorization:'Bearer '+token},body:JSON.stringify({request:{...b,action},identity:{...identity,project_id:b.project_id}})});
   reply.code(response.status);return await response.json();
  }catch(e){const failure=infrastructureFailure(e,{permissionCode:e.message});reply.code(e.status??failure?.status??503);return{state:'failed',error_code:failure?.code??(e.status?domainErrorCode(e.message,'project_backup_dependency_unavailable'):'project_backup_dependency_unavailable'),next_step:'query_original_operation;backup_is_workspace_only'}}
 });
 // Protected callback keeps original member alive/current before a queued effect or replay.
 app.post('/internal/project-backups/check',{logLevel:'silent'},async(req,reply)=>{
  if(!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.ip)||req.headers['x-hub-resource-key']!==serviceKey)return reply.code(403).send({state:'denied'});
  const b=req.body??{};return call('engineering_access',[hash(proof(req)),b.project_id,mode(b.action)]);
 });
 app.post('/v2/engineering/backups/platform/status',{logLevel:'silent'},async(req,reply)=>{
  reply.header('cache-control','no-store');try{
   if(req.body&&Object.keys(req.body).length)throw Object.assign(Error('no_platform_input_allowed'),{status:400});
   const token=proof(req),identity=await call('platform_backup_authority',[hash(token)]);
   const response=await fetch(executorUrl.replace('/execute','/platform-status'),{method:'POST',redirect:'error',signal:AbortSignal.timeout(15000),headers:{'content-type':'application/json','x-hub-resource-key':serviceKey,authorization:'Bearer '+token},body:JSON.stringify({identity})});reply.code(response.status);return response.json();
  }catch(e){const failure=infrastructureFailure(e,{permissionCode:e.message});reply.code(e.status??failure?.status??503);return{state:'failed',error_code:failure?.code??'platform_backup_status_unavailable'}}
 });
 for(const [action,allowed] of Object.entries({create:['repo','mode','idempotency_key'],restore:['repo','backup_id','idempotency_key'],operation:['operation_id']}))app.post('/v2/engineering/backups/platform/'+action,{logLevel:'silent'},async(req,reply)=>{
  reply.header('cache-control','no-store');try{
   const b=req.body??{};if(!b||Array.isArray(b)||Object.keys(b).some(k=>!allowed.includes(k)))throw Object.assign(Error('invalid_platform_backup_input'),{status:400});
   const token=proof(req),identity=await call('platform_backup_authority',[hash(token)]);
   const response=await fetch(executorUrl.replace('/execute','/platform-execute'),{method:'POST',redirect:'error',signal:AbortSignal.timeout(15000),headers:{'content-type':'application/json','x-hub-resource-key':serviceKey,authorization:'Bearer '+token},body:JSON.stringify({request:{...b,action:'platform_'+action},identity})});reply.code(response.status);return response.json();
  }catch(e){const failure=infrastructureFailure(e,{permissionCode:e.message});reply.code(e.status??failure?.status??503);return{state:'failed',error_code:failure?.code??'platform_backup_dependency_unavailable',next_step:'query_original_platform_operation;no_production_overwrite'}}
 });
 app.post('/internal/platform-backups/check',{logLevel:'silent'},async(req,reply)=>{
  if(!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.ip)||req.headers['x-hub-resource-key']!==serviceKey)return reply.code(403).send({state:'denied'});
  return call('platform_backup_authority',[hash(proof(req))]);
 });
 app.get('/v2/engineering/backups/help',async()=>({state:'ready',scope:'registered_project_workspace_regular_files_only',endpoints:fields,excludes:['symlinks','special_files','.hufu-restores','.hufu-backup-stage'],workspace_not_covered:['database_data','COS_objects','supplier_credentials'],platform:{requires:'current_controller_management_source_and_explicit_current_actions',endpoints:{status:[],create:['repo','mode','idempotency_key'],restore:['repo','backup_id','idempotency_key'],operation:['operation_id']},scope:'registered_pgbackrest_repositories_only',restore:'fixed_nonproduction_environment_files;current_authority_checkpoint;no_automatic_PostgreSQL_start',capacity:'returns_needed_and_available_bytes_before_clone'},restore:'new_project_owned_directory_only;never_overwrites_production',logs:'use_existing_runtime_logs',lifecycle:'same member/current project and software;original operation journal;new unauthorized requests denied'}));
}
