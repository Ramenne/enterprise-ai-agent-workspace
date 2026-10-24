import {infrastructureFailure,domainErrorCode} from '../../platform/src/failure-contract.mjs';
import{createHash,createHmac}from'node:crypto';
import{readFile}from'node:fs/promises';
const hash=t=>createHash('sha256').update(t).digest('hex');
export function installApplicationDevices(app,{pool}){
 const routes={pair:['application_device_pair',['application_id','label','idempotency_key']],check:['application_device_check',['application_id','action','binding_id','device_credential']],revoke:['application_device_revoke',['binding_id','expected_revision']]};
 for(const[route,[fn,keys]]of Object.entries(routes))app.post('/v2/authorization/application-devices/'+route,{logLevel:'silent'},async(req,reply)=>{
  reply.header('cache-control','no-store');
  try{
   const t=req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];if(!t||t.length>4096)return reply.code(401).send({error_code:'current_caller_required'});
   const input=req.body??{};if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!keys.includes(k)))return reply.code(400).send({error_code:'device_input_invalid'});
   let secret;const b={...input};
   if(route==='pair'){
    const i=(await pool.query('SELECT authz.authenticate($1) result',[hash(t)])).rows[0].result;
    const key=await readFile('/srv/workspace');
    const normalized=JSON.stringify({application_id:b.application_id,label:b.label,idempotency_key:b.idempotency_key});
    secret='device2_'+createHmac('sha256',key).update(i.actor_id+'\n'+normalized).digest('base64url');b.device_token_hash=hash(secret);b.digest=hash(normalized);
   }else if(route==='check'){
    if(typeof b.device_credential!=='string'||b.device_credential.length>1024)return reply.code(401).send({error_code:'device_credential_required'});
    b.device_token_hash=hash(b.device_credential);delete b.device_credential;
   }
   const result=(await pool.query('SELECT authz.'+fn+'($1,$2) result',[hash(t),b])).rows[0].result;
   return {...result,...(route==='pair'&&result.state==='active'?{device_credential:secret}:{})};
  }catch(e){const failure=infrastructureFailure(e,{permissionCode:e.message});return reply.code(failure?.status??(e.code==='40001'||e.code==='23505'?409:e.code==='22023'?400:503)).send({state:'failed',error_code:failure?.code??(['40001','23505','22023'].includes(e.code)?domainErrorCode(e.message,'application_device_dependency_unavailable'):'application_device_dependency_unavailable')});}
 });
}
