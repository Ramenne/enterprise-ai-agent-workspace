import {infrastructureFailure,domainErrorCode} from '../../platform/src/failure-contract.mjs';
import{createHash}from'node:crypto';
import{createSecretClient}from'../../secrets/src/index.js';
import{createVaultWriter}from'../../vault/next/src/scoped-writer.mjs';
const sha=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
export function pinnedRef(ref){const m=/^(bao:hub2\/hufu\/vault2\/operations\/[0-9a-f-]{36})\?version=([1-9][0-9]*)$/.exec(ref);return m?{mount:'hub2',path:m[1].slice('bao:hub2/'.length),version:Number(m[2])}:ref}
export async function installCustodyMigration(app,{pool,runtime,writer:providedWriter}){
 const writer=providedWriter??await createVaultWriter(createSecretClient,{bootstrap_file:process.env.HUB_BAO_BOOTSTRAP_FILE,ca_file:process.env.HUB_BAO_CA_FILE,...(process.env.HUB_BAO_URL?{base_url:process.env.HUB_BAO_URL}:{})});app.addHook('onClose',()=>writer.close());
 const token=req=>{const t=req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];if(!t)throw Object.assign(Error('unauthenticated'),{statusCode:401});return t};
 const sql=async(t,name,b)=>(await pool.query('select vault2.'+name+'($1::text,$2::jsonb)result',[createHash('sha256').update(t).digest('hex'),b])).rows[0].result;
 const entries=async t=>(await sql(t,'custody_inventory',{})).items;
 const readCurrent=async e=>{const data=await runtime.optionalSecret(pinnedRef(e.secret_ref));return data&&Object.hasOwn(data,e.value_field)};
 const safe=fn=>async(req,reply)=>{reply.header('cache-control','no-store');try{return await fn(req)}catch(e){const failure=infrastructureFailure(e,{permissionCode:e.message});const code=failure?.code??(e.code==='40001'||e.code==='23505'?domainErrorCode(e.message,'custody_dependency_unavailable'):domainErrorCode(e.code,'custody_dependency_unavailable'));reply.code(failure?.status??(e.code==='40001'||e.code==='23505'?409:e.statusCode??503));return{state:'failed',error_code:code,member_delivery:false,automatic_write_retry:false}}};
 app.post('/v2/vault/custody/inspect',{logLevel:'silent'},safe(async req=>{const es=await entries(token(req));const result=[];for(const e of es)result.push({entry_id:e.id,name:e.name,revision:e.revision,active:e.active,custody:await readCurrent(e)?'present_preserve_current':'missing'});return{state:'read',items:result,secret_values_included:false}}));
 app.post('/v2/vault/custody/migrate',{logLevel:'silent',bodyLimit:2*1024*1024},safe(async req=>{
  const t=token(req),b=req.body;if(!b||b.value===undefined||Object.keys(b).some(k=>!['entry_id','expected_revision','source','legacy_key_id','legacy_updated_at','encrypted_record_sha256','idempotency_key','value'].includes(k)))throw Object.assign(Error('custody_input_invalid'),{statusCode:400});
  const e=(await entries(t)).find(x=>x.id===b.entry_id&&x.name===b.legacy_key_id);if(!e)throw Object.assign(Error('exact_original_registered_entry_required'),{statusCode:403});
  if(await readCurrent(e))return{state:'existing_current_custody_preserved',entry_id:e.id,name:e.name,active:e.active,member_delivery:false};
  const{value,...meta}=b,op=await sql(t,'custody_prepare',meta);let candidate;try{candidate=await writer.readKV(op.target_ref)}catch(err){if(err.code!=='secret_not_found')throw err}
  const verify=v=>{if(v.data.operation_id!==op.id||v.data.value_fingerprint!==sha(value)||v.data.value===undefined||sha(v.data.value)!==sha(value))throw Object.assign(Error('custody_candidate_conflict'),{statusCode:409});return v.metadata.version};
  if(candidate)return sql(t,'custody_finish',{operation_id:op.id,outcome:'known',provider_version:verify(candidate)});
  const admitted=await sql(t,'custody_consume',{operation_id:op.id});if(!admitted.send_authorized)return{...admitted,automatic_write_retry:false};
  try{const written=await writer.writeKV(op.target_ref,{value,operation_id:op.id,value_fingerprint:sha(value),migration_source:op.source_metadata});const exact=await writer.readKV({mount:'hub2',path:op.target_ref.slice('bao:hub2/'.length),version:written.metadata.version});return await sql(t,'custody_finish',{operation_id:op.id,outcome:'known',provider_version:verify(exact)});}catch(err){await sql(t,'custody_finish',{operation_id:op.id,outcome:'unknown'}).catch(()=>{});throw err}
 }));
}
