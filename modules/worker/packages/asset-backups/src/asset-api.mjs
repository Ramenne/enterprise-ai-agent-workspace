import {infrastructureFailure,domainErrorCode} from '../../platform/src/failure-contract.mjs';
import{createHash}from'node:crypto';
const hash=v=>createHash('sha256').update(v).digest('hex');
export function installAssetBackups(app,{pool,serviceKey,executorUrl='http://127.0.0.1:4636/execute'}){
 const fields={sources:['project_id'],list:['project_id','source_id'],create:['project_id','source_id','idempotency_key'],restore:['project_id','source_id','backup_id','idempotency_key'],operation:['project_id','source_id','operation_id']};
 const token=req=>{const t=req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];if(!t||t.length>4096)throw Object.assign(Error('unauthenticated'),{status:401});return t};
 const sql=async(name,t,args=[])=>(await pool.query('SELECT authz.'+name+'('+['$1',...args.map((_,i)=>'$'+(i+2))].join(',')+') result',[hash(t),...args])).rows[0].result;
 app.post('/v2/engineering/backups/assets/authority',{logLevel:'silent'},async(req,reply)=>{
  reply.header('cache-control','no-store');try{
   const b=req.body??{};if(Object.keys(b).some(k=>!['project_id','action'].includes(k)))throw Object.assign(Error('invalid_input'),{status:400});
   return await sql('asset_backup_authority',token(req),[b.project_id,b.action]);
  }catch(e){const failure=infrastructureFailure(e,{permissionCode:e.message});reply.code(e.status??failure?.status??(e.code?.startsWith('22')?400:503));return{state:'denied',error_code:failure?.code??(e.code?.startsWith('22')?domainErrorCode(e.message,'invalid_input'):'asset_backup_authority_unavailable')}}
 });
 for(const [action,allowed]of Object.entries(fields))app.post('/v2/engineering/backups/assets/'+action,{logLevel:'silent'},async(req,reply)=>{
  reply.header('cache-control','no-store');try{
   const b=req.body??{};if(!b||Array.isArray(b)||Object.keys(b).some(k=>!allowed.includes(k)))throw Object.assign(Error('invalid_asset_backup_input'),{status:400});
   const t=token(req),identity=await sql('asset_backup_authority',t,[b.project_id,action]);
   const response=await fetch(executorUrl,{method:'POST',redirect:'error',signal:AbortSignal.timeout(20000),headers:{authorization:'Bearer '+t,'content-type':'application/json','x-hub-resource-key':serviceKey},body:JSON.stringify({request:{...b,action},identity})});reply.code(response.status);return response.json();
  }catch(e){const failure=infrastructureFailure(e,{permissionCode:e.message});reply.code(e.status??failure?.status??(e.code?.startsWith('22')?400:503));return{state:'failed',error_code:failure?.code??(e.code?.startsWith('22')?domainErrorCode(e.message,'invalid_input'):'asset_backup_dependency_unavailable'),next_step:'query_original_asset_operation;private_data_never_exports_to_project_UID'}}
 });
}
