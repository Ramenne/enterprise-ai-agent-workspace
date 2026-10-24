import {infrastructureFailure,domainErrorCode} from '../../platform/src/failure-contract.mjs';
/** Approved entry -> private fixed claim snapshot -> existing member email OTP.
 * Server-only writer dependency; no manager register, primary proof, or user locator.
 */
import{createHash}from'node:crypto';
const hash=t=>createHash('sha256').update(t).digest('hex');
const prefix='bao:hub2/hufu/vault2/';
export function installNativeVaultEntryClaims(app,{pool,runtime,vaultNext}){
 const writer=vaultNext?.deliveryWriter;
 if(!writer?.readKV||!writer?.writeKV)throw Error('existing_scoped_delivery_writer_required');
 const sql=async(t,name,b)=>(await pool.query('SELECT vault2.'+name+'($1,$2::jsonb) result',[hash(t),b])).rows[0].result;
 const identity=async t=>(await pool.query("SELECT vault2.current_identity($1,'{}'::jsonb) result",[hash(t)])).rows[0].result;
 async function source(ref){
  if(typeof ref!=='string'||!ref.startsWith(prefix)||ref.includes('..'))throw Error('registered_private_source_required');
  const pinned=/^(bao:hub2\/hufu\/vault2\/operations\/[0-9a-f-]{36})\?version=([1-9][0-9]*)$/.exec(ref);
  if(pinned){const snapshot=await writer.readKV({mount:'hub2',path:pinned[1].slice('bao:hub2/'.length),version:Number(pinned[2])});return{data:snapshot.data,source_version:Number(pinned[2])};}
  return{data:await runtime.optionalSecret(ref),source_version:null};
 }
 async function prepare(t,b){
  const p=await sql(t,'entry_claim_prepare',b);
  if(p.state==='ready')return{state:'verification_required',item_id:p.item_id,entry_id:p.entry_id,grant_id:p.grant_id,expires_at:p.expires_at,challenge_path:'/v2/vault/deliveries/challenge',verify_path:'/v2/vault/deliveries/verify',replayed:true};
  let snapshot,data,value,content_base64;
  try{
   try{snapshot=await writer.readKV(p.secret_ref);}catch(e){if(e.code!=='secret_not_found')throw e;}
   if(!snapshot){
    const s=await source(p.source_ref);data=s.data;
    if(!data||!Object.hasOwn(data,p.value_field)||data[p.value_field]===undefined||data[p.value_field]===null)throw Object.assign(Error('approved_entry_source_unavailable'),{status:503});
    value=data[p.value_field];
    const bytes=Buffer.from(JSON.stringify({format:'hufu.approved-entry-claim.v1',entry_id:p.entry_id,key:p.key,kind:p.kind,value,source_version:s.source_version,claim_expires_at:p.expires_at,external_credential_lifecycle:'provider-controlled;platform revocation does not invalidate prior external copies'},null,2));
    if(!bytes.length||bytes.length>256*1024)throw Object.assign(Error('entry_snapshot_size_unavailable'),{status:503});
    content_base64=bytes.toString('base64');bytes.fill(0);
    // Recheck current exact entry authority immediately before private value write.
    await sql(t,'entry_claim_revalidate',{item_id:p.item_id});
    await writer.writeKV(p.secret_ref,{item_id:p.item_id,filename:p.filename,entry_id:p.entry_id,content_base64});
    snapshot=await writer.readKV(p.secret_ref);
   }
   if(snapshot.data.item_id!==p.item_id||snapshot.data.filename!==p.filename||snapshot.data.entry_id!==p.entry_id||!snapshot.data.content_base64)throw Object.assign(Error('private_claim_binding_conflict'),{status:409});
   return await sql(t,'entry_claim_finish',{item_id:p.item_id,secret_version:snapshot.metadata.version});
  }finally{data=undefined;value=undefined;content_base64=undefined;snapshot=undefined;}
 }
 app.post('/v2/vault/entry-deliveries/prepare',{logLevel:'silent'},async(req,reply)=>{
  reply.header('cache-control','no-store').header('pragma','no-cache');
  try{
   const t=req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];if(!t||t.length>4096)return reply.code(401).send({state:'failed',error_code:'current_caller_required'});
   const b=req.body??{};if(!b||typeof b!=='object'||Array.isArray(b)||Object.keys(b).some(k=>!['entry_id','key','purpose','idempotency_key'].includes(k))||[b.entry_id,b.key].filter(x=>x!==undefined).length!==1||b.entry_id!==undefined&&!/^[a-f0-9-]{36}$/i.test(b.entry_id)||b.key!==undefined&&(typeof b.key!=='string'||!b.key)||b.purpose!==undefined&&(typeof b.purpose!=='string'||b.purpose.length>2000))return reply.code(400).send({state:'failed',error_code:'entry_claim_input_invalid'});
   return await prepare(t,b);
  }catch(e){const failure=infrastructureFailure(e,{permissionCode:e.message});return reply.code(e.status??failure?.status??(e.code==='23505'||e.code==='40001'?409:e.code==='22023'?400:503)).send({state:'failed',error_code:failure?.code??(e.status||['23505','40001','22023'].includes(e.code)?domainErrorCode(e.message,'native_claim_dependency_unavailable'):'native_claim_dependency_unavailable'),next_step:'query_original_entry_grant_and_claim;never_repeat_unknown_secret_release'});}
 });
 // Original legacy MCP reveal already calls this exact base object dynamically.
 // Keep low-risk direct reveal and service execution routes intact.
 const original=vaultNext.base.reveal.bind(vaultNext.base);
 vaultNext.base.reveal=async(t,b)=>{
  const result=await original(t,b);
  if(result.state!=='use_execution_channel')return result;
  const i=await identity(t);if(i.kind!=='member')return result;
  return{...await prepare(t,{...(b.entry_id?{entry_id:b.entry_id}:{key:b.key}),purpose:'approved_entry_native_email_verified_claim'}),delivery:'native_member_email_OTP;no_manual_file_upload',maximum_claim_hours:2};
 };
 app.get('/v2/vault/entry-deliveries/help',{logLevel:'silent'},async(_req,reply)=>{
  reply.header('cache-control','no-store');return{workflow:['current Vault apply/decide/grant when needed','prepare approved entry automatically','existing deliveries.challenge','existing deliveries.verify','existing authenticated one-time download'],prepare:{method:'POST',path:'/v2/vault/entry-deliveries/prepare',fields:['entry_id OR key','purpose?','idempotency_key?']},scope:'same current member,client,credential and original entry grant/filter;no primary substitution;no manager registration',lifetime:'maximum 2h and no longer than current grant/source/credential',revocation:'every new claim/OTP/download rechecks current entry and original grant;already copied external credentials retain provider lifecycle'};
 });
 return{prepare};
}
