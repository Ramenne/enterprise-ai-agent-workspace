import {infrastructureFailure,domainErrorCode} from '../../platform/src/failure-contract.mjs';
import{createHash}from'node:crypto';
const hash=t=>createHash('sha256').update(t).digest('hex');
export function installSqliteDatabaseAccess(app,{pool,runtime}){
 const key=runtime.required('resource_execution_key','HUFU_RESOURCE_EXECUTION_KEY');
 const sql=async(name,args)=>(await pool.query('SELECT authz.'+name+'('+args.map((_,i)=>'$'+(i+1)).join(',')+') result',args)).rows[0].result;
 for(const action of ['execute','inspect'])app.post('/v2/database-access/sqlite/'+action,{bodyLimit:1024*1024,logLevel:'silent'},async(req,reply)=>{
  reply.header('cache-control','no-store');
  try{
   const token=req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];if(!token||token.length>4096)return reply.code(401).send({error_code:'current_caller_required'});
   const b=req.body??{},keys=action==='inspect'?['project_id','schema','table']:['project_id','schema','sql','parameters','idempotency_key'];
   if(!b||typeof b!=='object'||Array.isArray(b)||Object.keys(b).some(k=>!keys.includes(k)))return reply.code(400).send({error_code:'sqlite_input_invalid'});
   if(action==='execute'&&(typeof b.sql!=='string'||!b.sql||b.sql.length>200000))return reply.code(400).send({error_code:'bounded_single_SQL_required'});
   const proof=hash(token),digest=hash(JSON.stringify(b));let permit;
   if(b.idempotency_key){
    const reservation=await sql('database_sqlite_effect_prepare',[proof,b,digest]);
    if(reservation.state!=='dispatch_once')return reservation;
    permit=reservation.permit;
   }else permit=await sql('database_sqlite_permit',[proof,b]);
   const request={project_id:b.project_id,action:action==='inspect'?'inspect':'execute',...(action==='inspect'?{table:b.table}:{sql:b.sql,parameters:b.parameters??[],idempotency_key:b.idempotency_key})};
   // Existing authenticated engineering relay dispatches only registered loopback hosts.
   const r=await fetch('http://127.0.0.1:4619/execute',{method:'POST',headers:{'content-type':'application/json','x-hub-resource-key':key},body:JSON.stringify({request:{project_id:b.project_id,action:'database_sqlite',parameters:request},identity:permit}),signal:AbortSignal.timeout(18000)});
   const out=await r.json();
   if(b.idempotency_key)await sql('database_sqlite_effect_finish',[proof,b,digest,out]);
   reply.code(out.state==='failed'?403:r.status);return{...out,operation_id:b.idempotency_key??null};
  }catch(e){const failure=infrastructureFailure(e,{permissionCode:e.message});return reply.code(failure?.status??(e.code==='23505'||e.code==='40001'?409:e.code?.startsWith('22')?400:503)).send({state:'failed',error_code:failure?.code??(['23505','40001','22023'].includes(e.code)?domainErrorCode(e.message,'sqlite_dispatch_dependency_unavailable'):'sqlite_dispatch_dependency_unavailable'),next_step:'query_original_effect_before_retry;no_SQL_parameters_or_private_rows_in_audit'});}
 });
 app.get('/v2/database-access/sqlite/help',{logLevel:'silent'},async()=>({backend:'sqlite',workflow:'existing database objects/apply/requests/decide/revoke;explicit whole_table approval then SQL execute',execute:{path:'/v2/database-access/sqlite/execute',fields:['project_id','schema','sql','parameters?','idempotency_key:required_for_writes']},notes:['Root never executes user SQL as root. Fixed project service UID and inaccessible host/private DB paths.','Single normal SQL statement, SQLite authorizer checks every actual table/action including triggers/cascades.','PRAGMA/ATTACH/DDL/extension/file functions not available.','Private original/audio/transcript/source-authorization tables remain inspect/business_API only;project engineering/manager status does not replace owner consent.','Whole-table data approvals explicitly include all member/private rows;not just caller rows.','Ordinary tables do not permit ownership identifier updates.','Unknown effects are retained and not blindly redispatched;SELECT results only current caller,never shared audit.']}));
}
