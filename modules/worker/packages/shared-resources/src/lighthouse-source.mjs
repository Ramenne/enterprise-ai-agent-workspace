import {infrastructureFailure,domainErrorCode} from '../../platform/src/failure-contract.mjs';
import{createHash}from'node:crypto';import{pinnedRef}from'./custody-migration.mjs';
export function installLighthouseSource(app,{pool,runtime,serviceKey}){
 app.post('/internal/resource-lighthouse/source',{logLevel:'silent'},async(req,reply)=>{
  reply.header('cache-control','no-store');let value,stage='start';
  try{
   stage='service_key';
   if(!serviceKey||!([req.headers['x-hub-service-key'],req.headers['x-hub-resource-key']].includes(serviceKey)))throw Error('untrusted_service');
   stage='request_shape';
   const token=req.headers.authorization?.match(/^Bearer (.+)$/)?.[1],b=req.body;
   if(!token||!b||b.target_id!=='jiaxin-lighthouse-instance'||!['lighthouse.instance.describe','lighthouse.instance.start','lighthouse.instance.stop','lighthouse.instance.restart'].includes(b.action)||!['get','guard'].includes(b.mode)||!b.permit?.usage_id)throw Error('fixed_shared_lighthouse_required');
   stage='outer_permit';
   const proof=createHash('sha256').update(token).digest('hex'),p=b.permit;
   if(p.target_id!==b.target_id||p.project_id!==p.project_id||!p.usage_id)throw Error('outer_permit_binding_required');
   stage='vault_source';
   const src=(await pool.query('SELECT vault2.lighthouse_runtime_source($1) result',[proof])).rows[0].result;
   stage='secret_read';
   if(b.mode==='guard')return{state:'active',revision:src.revision};
   const data=await runtime.optionalSecret(pinnedRef(src.secret_ref));value=typeof data[src.value_field]==='string'?JSON.parse(data[src.value_field]):data[src.value_field];
   if(!value?.secret_id||!value.secret_key)throw Error('cloud_source_format_required');
   return{secret_id:value.secret_id,secret_key:value.secret_key,account_id:'100048716377',region:'ap-guangzhou',instance_id:'example-resource-id',source_revision:src.revision};
  }catch(e){const failure=infrastructureFailure(e,{permissionCode:e.message});console.error(JSON.stringify({event:'lighthouse_source_stage',stage,error_code:/^[a-z_]{1,120}$/.test(e.code??'')?e.code:'source_failed'}));reply.code(failure?.status??(['untrusted_service','fixed_shared_lighthouse_required'].includes(e.message)?403:503));return{state:'denied',error_code:failure?.code??domainErrorCode(e.message,'cloud_source_unavailable')};}
 });
}
