import{createHash}from'node:crypto';import{VaultError}from'../../src/service.mjs';
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const canonicalDigest=v=>createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex');
const digest=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex'),prefix='bao:hub2/hufu/vault2/';
/** writer must be the scoped 2.0 SecretSDK with reconnect_budget_ms:0. No caller ref. */
export function createInitialSecretService({pool,writer}){
 if(!pool?.query||!writer?.readKV||!writer?.writeKV||writer.singleDispatch!==true)throw Error('scoped_writer_required');
 const sql=async(token,name,b)=>{if(!token)throw new VaultError('unauthenticated',401);const h=createHash('sha256').update(token).digest('hex');return(await pool.query('SELECT vault2.'+name+'($1,$2::jsonb) result',[h,JSON.stringify(b)])).rows[0].result;};
 const publicOp=o=>({state:o.state,operation_id:o.id,entry_id:o.entry_id,expected_revision:o.expected_revision,provider_version:o.provider_version,receipt:o.receipt});
 function fixedRef(ref,version){return{mount:'hub2',path:ref.slice('bao:hub2/'.length),version};}
 async function read(ref){try{return await writer.readKV(ref);}catch(e){if(e.code==='secret_not_found')return null;throw e;}}
 function matched(snapshot,op,fingerprint,expectedValue){if(!snapshot||snapshot.data.operation_id!==op.id||snapshot.data.value_fingerprint!==fingerprint||snapshot.data.value===undefined||canonicalDigest(snapshot.data.value)!==canonicalDigest(expectedValue))throw new VaultError('private_rotation_input_conflict',409);if(!Number.isSafeInteger(snapshot.metadata.version)||snapshot.metadata.version<1)throw new VaultError('private_version_unknown',503);return snapshot.metadata.version;}
 return{
  register:(token,b)=>sql(token,'registry',b),
  disable:(token,b)=>sql(token,'registry',{...b,active:false}),
  async status(token,b){return publicOp(await sql(token,'initial_secret_status',b));},
  async initialize(token,b){const{value,...meta}=b;if(value===undefined)throw new VaultError('secure_value_input_required');const fingerprint=digest(value);meta.value_fingerprint=fingerprint;let op=await sql(token,'initial_secret_prepare',meta);if(!op.target_ref?.startsWith(prefix)||op.target_ref.includes('..'))throw new VaultError('registered_private_ref_required',503);
   // Known replay verifies the pinned candidate, never creates a replacement or rewrites it.
   if(op.state==='known'){matched(await read(fixedRef(op.target_ref,op.provider_version)),op,fingerprint,value);return op.receipt;}
   if(op.state==='conflict')return publicOp(op);
   let snapshot;try{snapshot=await read(op.target_ref);}catch{throw new VaultError('private_candidate_lookup_unknown_no_write',503,true);}
   if(snapshot){const version=matched(snapshot,op,fingerprint,value);return sql(token,'initial_secret_finish',{operation_id:op.id,outcome:'known',provider_version:version});}
   op=await sql(token,'initial_secret_consume',{operation_id:op.id});if(!op.send_authorized)return{state:'unknown',operation_id:op.id,next_step:'query_same_operation_no_rewrite',candidate_stored:'not_proven'};
   try{const wrote=await writer.writeKV(op.target_ref,{value,operation_id:op.id,value_fingerprint:fingerprint,canonical_value_fingerprint:canonicalDigest(value)});const exact=await read(fixedRef(op.target_ref,wrote.metadata.version));const version=matched(exact,op,fingerprint,value);return await sql(token,'initial_secret_finish',{operation_id:op.id,outcome:'known',provider_version:version});}
   catch(e){await sql(token,'initial_secret_finish',{operation_id:op.id,outcome:'unknown'}).catch(()=>{});if(e instanceof VaultError&&e.status===409)throw e;return{state:'unknown',operation_id:op.id,next_step:'reconcile_same_operation_current_private_ref_no_rewrite',upstream_old_credential_revoked:false};}
  },
  async reconcile(token,b){const op=await sql(token,'initial_secret_status',b);if(op.state==='known'||op.state==='conflict')return publicOp(op);let found;try{found=await read(op.target_ref);}catch{throw new VaultError('private_candidate_lookup_unknown',503,true);}if(!found)return{state:'unknown',operation_id:op.id,candidate_present:false,next_step:'no_automatic_rewrite;current_manager_inspects_intent'};if(found.data.operation_id!==op.id||found.data.value===undefined||(found.data.canonical_value_fingerprint?found.data.canonical_value_fingerprint!==canonicalDigest(found.data.value):found.data.value_fingerprint!==digest(found.data.value)))throw new VaultError('candidate_binding_conflict',409);return sql(token,'initial_secret_finish',{operation_id:op.id,outcome:'known',provider_version:found.metadata.version});}
 };
}
