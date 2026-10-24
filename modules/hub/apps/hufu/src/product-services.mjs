import {infrastructureFailure,domainErrorCode} from '../../../packages/platform/src/failure-contract.mjs';
import {createHash,createHmac} from 'node:crypto';
const hash=x=>createHash('sha256').update(x).digest('hex');
const uuid=x=>typeof x==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(x);
const commands={
 ...Object.fromEntries(['request','read','list','decide','delivery'].map(mode=>['/v2/services/resource-packages/'+mode,['service_resource_package',[...(mode==='request'?['project_id','service_id','summary','resources','source_ref']:mode==='read'?['package_id','project_id']:mode==='list'?['project_id','service_id','state','limit','cursor','view']:mode==='decide'?['package_id','expected_revision','decision','note']:['package_id','expected_revision','items'])]]])),
 '/v2/services/authorize':['service_authorize',['project_id','service_id','name','resource_selector','expires_at','until_revoked','application_project_id','profile']],
 '/v2/services/credentials':['service_credential_issue',['service_id','project_ids','label','expires_at','until_revoked']],
 '/v2/services/revoke':['service_authorization_revoke',['authorization_id','expected_revision']],
 '/v2/services/authorizations':['service_authorizations_read',['project_id','service_id']]
};
export function serviceInput(path,b){
 const descriptor=commands[path];if(!descriptor||!b||typeof b!=='object'||Array.isArray(b)||Object.keys(b).some(k=>!descriptor[1].includes(k)))throw Object.assign(Error('invalid_service_input'),{status:400});
 for(const key of ['project_id','service_id','authorization_id','application_project_id','package_id'])if(key in b&&!uuid(b[key]))throw Object.assign(Error('invalid_service_input'),{status:400});
 if(path.endsWith('/authorize')&&b.profile!==undefined&&!['full_foundation','task_hall'].includes(b.profile))throw Object.assign(Error('invalid_service_profile'),{status:400});
 if(path.endsWith('/authorize')&&(!uuid(b.project_id)||(!b.service_id&&!(typeof b.name==='string'&&b.name.length>0&&b.name.length<=200))))throw Object.assign(Error('service_identity_required'),{status:400});
 if(path.endsWith('/credentials')&&(!uuid(b.service_id)||!Array.isArray(b.project_ids)||b.project_ids.length<1||b.project_ids.length>200||b.project_ids.some(x=>!uuid(x))))throw Object.assign(Error('service_projects_required'),{status:400});
 if(path.endsWith('/revoke')&&(!uuid(b.authorization_id)||!Number.isInteger(b.expected_revision)||b.expected_revision<1))throw Object.assign(Error('service_revision_required'),{status:400});
 return descriptor[0];
}
function metadataOnly(value){
 if(!value||typeof value!=='object')return;
 for(const[k,v]of Object.entries(value)){if(/^(secret_value|password|token|private_key|api_key|credential)$/i.test(k))throw Object.assign(Error('secret_values_use_private_delivery'),{status:400});metadataOnly(v);}
}
export function installProductServices(app,{pool,bearer,credentialKey}){
 const sql=async(name,args)=>(await pool.query('SELECT authz.'+name+'('+args.map((_,i)=>'$'+(i+1)).join(',')+') result',args)).rows[0].result;
 app.get('/v2/services/capabilities',{logLevel:'silent'},async()=>({state:'ready',version:'product-service-v1',authorization_mode:'product_service',default_profile:'full_foundation',profiles:['full_foundation','task_hall'],task_hall_actions:['hufu.taskhall.sso','v8.board.read','v8.board.claim','v8.board.receipt'],abilities:['storage','resource_use','context','optional_work_functions'],agent_work_required:false,per_action_approval:false,internal_file_source_task_required:false,identity:'registered_product_service',scope:'declared_project_and_resource_scope',routes:Object.keys(commands)}));
 for(const path of Object.keys(commands))app.post(path,{logLevel:'silent'},async(req,reply)=>{
  reply.header('cache-control','no-store');
  try{
   const name=serviceInput(path,req.body),proof=hash(bearer(req)),body=req.body;
   if(name==='service_resource_package'){
    metadataOnly(body);
    const mode=path.split('/').at(-1),key=['read','list'].includes(mode)?null:req.headers['idempotency-key'];
    if(!['read','list'].includes(mode)&&(typeof key!=='string'||key.length<1||key.length>200))throw Object.assign(Error('idempotency_key_required'),{status:400});
    return await sql(name,[proof,mode,body,key,['read','list'].includes(mode)?null:hash(JSON.stringify({path,body}))]);
   }
   if(name==='service_authorizations_read')return await sql(name,[proof,body]);
   const key=req.headers['idempotency-key'];if(typeof key!=='string'||key.length<1||key.length>200)throw Object.assign(Error('idempotency_key_required'),{status:400});
   const digest=hash(JSON.stringify({path,body}));
   if(name==='service_credential_issue'){
    if(!credentialKey||credentialKey.length<32)throw Object.assign(Error('service_credential_issuance_unconfigured'),{status:503});
    const identity=await sql('authenticate',[proof]);
    const credential='hub2_'+createHmac('sha256',credentialKey).update('product-service-v1\n'+identity.actor_id+'\n'+key+'\n'+digest).digest('base64url');
    const r=await sql(name,[proof,body,key,digest,hash(credential)]);
    return {...r,...(r.credential_delivery==='available'?{credential}:{})};
   }
   return await sql(name,[proof,body,key,digest]);
  }catch(e){
   const failure=infrastructureFailure(e,{permissionCode:e.message});const status=e.status??failure?.status??(e.code==='40001'||e.code==='23505'?409:e.code==='22023'||e.code==='22P02'?400:503);
   const code=failure?.code??domainErrorCode(e.message,'service_dependency_unavailable');
   return reply.code(status).send({state:'failed',error_code:code,effect:'no_partial_authorization',next_step:status===403?'check_service_identity_and_declared_scope':status===409?'reuse_original_operation_and_current_revision':'correct_input_or_inspect_dependency'});
  }
 });
}
