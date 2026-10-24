import{createHash}from'node:crypto';
export class VaultError extends Error{constructor(code,status=400,retryable=false){super(code);this.code=code;this.status=status;this.retryable=retryable;}}
export const originalValueDelivery=Object.freeze({mode:'original_plaintext',requires_current_entry_grant:true,automatic_rotation:false,provider_key_changed:false,proxy_required:false,scope:'approved_entry_recipient_and_use',rotation:'separate_explicit_operation'});
const publicCalls=new Set(['directory','apply','applications','decide','grants','revoke']);
/** SQL holds current authority only for each bounded call. No Bao IO inside a transaction. */
export function createVaultService({pool,secretRuntime,secretRefPrefix='bao:hub2/hufu/vault2/'}){
 if(!pool?.query||!secretRuntime?.optionalSecret||!secretRefPrefix.startsWith('bao:hub2/hufu/vault2/'))throw Error('scoped_pool_and_secret_runtime_required');
 async function sql(token,name,body){if(typeof token!=='string'||!token)throw new VaultError('unauthenticated',401);const proof=createHash('sha256').update(token).digest('hex');const r=await pool.query('SELECT vault2.'+name+'($1,$2::jsonb)AS result',[proof,JSON.stringify(body)]);return r.rows[0].result;}
 return{
  async call(name,token,body){if(!publicCalls.has(name))throw new VaultError('invalid_vault_operation');const result=await sql(token,name,body);if(name==='directory'&&Array.isArray(result.items))return{...result,items:result.items.map(item=>({...item,value_delivery:item.execution_channel_only?{mode:'execution_channel',plaintext_returned:false}:originalValueDelivery})),receipt_semantics:'catalogue_does_not_grant_access'};return result;},
  async reveal(token,body){const prepared=await sql(token,'reveal_prepare',body);if(prepared.state==='use_execution_channel')return prepared;
   if(prepared.state!=='authorized_prepare'||typeof prepared.secret_ref!=='string'||!prepared.secret_ref.startsWith(secretRefPrefix)||prepared.secret_ref.includes('..'))throw new VaultError('registered_private_ref_required',503);
   let data,value;try{data=await secretRuntime.optionalSecret(prepared.secret_ref);if(!data||!Object.hasOwn(data,prepared.value_field)||data[prepared.value_field]===undefined)throw new VaultError('secret_unavailable',503,true);value=data[prepared.value_field];
    const released=await sql(token,'reveal_finish',{ticket_id:prepared.ticket_id,result:'released'});if(released.state!=='authorized_release')throw new VaultError('current_vault_release_required',403);
    return{state:'revealed',entry_id:prepared.entry_id,value,...(typeof data.manual==='string'&&data.manual?{manual:data.manual}:{}),usage_hint:{manual_available:Boolean(data.manual),blocks_authorized_delivery:false},secret_origin:'OpenBao_private_ref',audit_receipt:{ticket_id:prepared.ticket_id,stage:'authorized_release'},delivery:'response_prepared;not_proof_of_client_receipt',cacheable:false,value_delivery:originalValueDelivery,plaintext_returned:true};
   }catch(e){await sql(token,'reveal_finish',{ticket_id:prepared.ticket_id,result:'failed'}).catch(()=>{});if(e?.code==='42501'||e instanceof VaultError)throw e;throw new VaultError('secret_runtime_unavailable',503,true);
   }finally{data=undefined;value=undefined;}
  }
 };
}
