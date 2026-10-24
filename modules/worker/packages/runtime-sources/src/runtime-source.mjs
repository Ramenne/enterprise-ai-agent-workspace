import {createHash,createPublicKey,verify} from 'node:crypto';
const hash=x=>createHash('sha256').update(x).digest('hex');
export const canonical=x=>x===null||typeof x!=='object'?JSON.stringify(x):Array.isArray(x)?'['+x.map(canonical).join(',')+']':'{'+Object.keys(x).sort().map(k=>JSON.stringify(k)+':'+canonical(x[k])).join(',')+'}';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function requestBinding({runtime_id,nonce,issued_at,method,path,body}){return {protocol:'hub2-runtime-source.v1',runtime_id,nonce,issued_at,method:method.toUpperCase(),path,body_sha256:hash(canonical(body??null))};}
const error=(code,status=400)=>Object.assign(Error(code),{code,status,statusCode:status});
function token(req,fail=error){const a=req.headers.authorization;if(typeof a!=='string'||!a.startsWith('Bearer '))throw fail('current_member_required',401);return a.slice(7);}
function object(x,keys){if(!x||typeof x!=='object'||Array.isArray(x)||Object.keys(x).some(k=>!keys.includes(k)))throw error('invalid_runtime_source_input');return x;}
/** Hufu scoped pool only. sql(name,args) uses existing sqlFunction, no peer/admin.
 * Optional hook authenticates current credential through every SQL operation. */
export function installRuntimeSources(app,{sql,DomainError}){
 const error=(code,status=400)=>DomainError?new DomainError(code,status):Object.assign(Error(code),{code,status,statusCode:status});
 app.post('/v2/runtime-sources/register',async req=>{
  const b=object(req.body,['public_key_pem','registration_kind','descriptor','work_context','target_client_id','target_credential_id']);
  if(typeof b.public_key_pem!=='string'||b.public_key_pem.length>512||createPublicKey(b.public_key_pem).asymmetricKeyType!=='ed25519')throw error('ed25519_public_key_required');
  if(b.work_context)object(b.work_context,['project_id','work_item_id']);
  if(canonical(b).length>8192)throw error('runtime_registration_too_large');
  return sql('authz.runtime_source_register',[hash(token(req,error)),b]);
 });
 app.post('/v2/runtime-sources/stop',async req=>{const b=object(req.body,['runtime_id']);if(!uuid.test(b.runtime_id))throw error('invalid_runtime_id');return sql('authz.runtime_source_stop',[hash(token(req,error)),b.runtime_id]);});
 app.addHook('preHandler',async(req,reply)=>{
  const header=req.headers['x-hub-runtime-signature'];if(header===undefined)return;
  if(typeof header!=='string'||header.length>4096)throw error('invalid_runtime_signature',403);
  let claim;try{claim=object(JSON.parse(Buffer.from(header,'base64url').toString('utf8')),['runtime_id','nonce','issued_at','signature']);}catch{throw error('invalid_runtime_signature',403);}
  if(!uuid.test(claim.runtime_id)||typeof claim.nonce!=='string'||!/^[a-zA-Z0-9_-]{32,100}$/.test(claim.nonce)||typeof claim.signature!=='string'||!Number.isFinite(Date.parse(claim.issued_at)))throw error('invalid_runtime_signature',403);
  const age=Date.now()-Date.parse(claim.issued_at);if(age>90000||age< -10000)throw error('runtime_nonce_expired',403);
  const h=hash(token(req,error)),r=await sql('authz.runtime_source_key',[h,claim.runtime_id]);
  const binding=requestBinding({...claim,method:req.method,path:req.raw.url,body:req.body});
  const data=Buffer.from(canonical(binding));const key=createPublicKey(r.public_key_pem);
  if(key.asymmetricKeyType!=='ed25519'||!verify(null,data,key,Buffer.from(claim.signature,'base64url')))throw error('runtime_signature_invalid',403);
  let proof;try{proof=await sql('authz.runtime_source_record',[h,claim.runtime_id,hash(claim.nonce),hash(data),claim.issued_at]);}catch(e){if(e.code==='23505')throw error('runtime_nonce_replayed',409);throw e;}
  // This is the verified transport request, not a claim of host/process control.
  req.runtimeSourceProof=proof;
  if(req.raw.url==='/internal/decision'&&req.body&&typeof req.body==='object'){req.body.source_context={provider:'registered_runtime',native_session_id:claim.runtime_id+':'+hash(claim.nonce),signed_request_sha256:proof.request_sha256,work_context_id:proof.work_context_id,declared_context:req.body.source_context??null};}
  reply.header('x-hub-source-assurance',proof.registration_kind);
  reply.header('x-hub-source-proof',Buffer.from(JSON.stringify(proof)).toString('base64url'));
 });
}
