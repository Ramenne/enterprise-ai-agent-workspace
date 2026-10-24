/** Original contract adapter. Migrated keys never fall back to the old grant/value store. */
export function vaultUpgrade({managedKeys,nextIdentity,newApi,oldTool,oldApi,error}){
 const managed=key=>typeof key==='string'&&managedKeys.has(key);
 async function isManaged(token,key){if(managed(key))return true;if(typeof key!=='string'||!key)return false;const own=await nextIdentity(token);const state=await newApi('/v2/vault/legacy-status',own.token,{key});if(state.authority==='vault2'){managedKeys.add(key);return true;}return false;}
 async function invoke(token,path,body){const own=await nextIdentity(token);return newApi(path,own.token,body);}
 async function list(token,req){
  let prior,enhanced;try{prior=await oldTool(token,'hufu_vault_list',{},req);}catch{prior={secrets:[],legacy_coverage:'unavailable'};}
  try{enhanced=await invoke(token,'/v2/vault/legacy/vault/list');}catch(e){if(managedKeys.size)throw e;enhanced={secrets:[]};}
  const old=(prior.secrets||prior.items||[]).filter(x=>!managed(x.key_id));
  for(const x of enhanced.items||[])if(x.authority==='vault2')managedKeys.add(x.key_id);const added=(enhanced.secrets||[]).filter(x=>managed(x.key_id));const secrets=[...old.filter(x=>!managed(x.key_id)),...added];
  return{...prior,secrets,total:secrets.length,visible:secrets.length,upgraded_credentials:added.length,authority:'per_key;vault2_for_managed_keys',entry_unchanged:true};
 }
 async function reveal(token,args,req){return await isManaged(token,args.key_id)?invoke(token,'/v2/vault/legacy/vault/reveal',args):oldTool(token,'hufu_vault_reveal',args,req);}
 async function applications(token,req){const old=await oldApi(token,'/hufu/applications').catch(()=>({applications:[]}));const next=await invoke(token,'/v2/vault/legacy/applications');return{...next,legacy_applications:old,authority:'old_integer_ids_remain_legacy;new_UUID_ids_use_vault2'};}
 async function route(token,method,path,body,req){const url=new URL(path,'http://127.0.0.1');const p=url.pathname;
  if(method==='GET'&&p==='/hufu/vault/list')return{handled:true,result:await list(token,req)};
  if(method==='GET'&&p==='/hufu/applications')return{handled:true,result:await applications(token,req)};
  if(p==='/hufu/vault/reveal'&&method==='GET'){const key=url.searchParams.get('key_id');if(await isManaged(token,key))return{handled:true,result:await invoke(token,'/v2/vault/legacy/vault/reveal',{key_id:key})};}
  if(p==='/hufu/apply'&&method==='POST'&&await isManaged(token,body?.key_id))return{handled:true,result:await invoke(token,'/v2/vault/legacy/apply',body)};
  if(p==='/hufu/admin/applications/decide'&&method==='POST'&&typeof body?.application_id==='string'&&/^[0-9a-f-]{36}$/i.test(body.application_id))return{handled:true,result:await invoke(token,'/v2/vault/legacy/admin/applications/decide',body)};
  if(p==='/hufu/admin/grants/set'&&method==='POST'&&await isManaged(token,body?.key_id))return{handled:true,result:await invoke(token,'/v2/vault/legacy/admin/grants/set',body)};
  return{handled:false};
 }
 return{managed,isManaged,list,reveal,route};
}
