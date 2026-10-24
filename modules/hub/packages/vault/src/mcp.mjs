import {infrastructureFailure} from '../../platform/src/failure-contract.mjs';
import{randomUUID}from'node:crypto';
/** Can register into the existing 2.0 McpServer; actual auth token comes from MCP authInfo. */
import{VaultError}from'./service.mjs';import{validate}from'./http.mjs';
export const vaultTools=[
 {name:'hufu.vault.list',operation:'directory',readOnly:true,description:'List authorized credential metadata and current grants. Values and private OpenBao refs are omitted.'},
 {name:'hufu.vault.grants',operation:'grants',readOnly:true,description:'Inspect own grants or grants in the current manager scope.'},
 {name:'hufu.vault.apply',operation:'apply',readOnly:false,description:'Request a credential for this current member and client. Purpose is optional Agent judgment; no automatic score.'},
 {name:'hufu.vault.applications',operation:'applications',readOnly:true,description:'Read own requests or current manager pending requests.'},
 {name:'hufu.vault.decide',operation:'decide',readOnly:false,description:'Current manager or qualified delegate approves/rejects a specific CAS revision; server derives decision actor.'},
 {name:'hufu.vault.revoke',operation:'revoke',readOnly:false,description:'Current authorized manager revokes one grant by CAS. Values already delivered cannot be erased.'},
 {name:'hufu.vault.reveal',operation:'reveal',readOnly:false,description:'Use an existing current grant directly. Deliver the approved ordinary key original plaintext value after final authorization, without rotation or mandatory proxy/child key. Server/dns/COS-management retain their execution channel. Secrets belong only in authorized delivery/configuration, not ordinary reports or Git.'}
];
export const legacyVaultNames={'hufu_vault_list':'directory','hufu_vault_grants':'grants','hufu_vault_apply':'apply','hufu_vault_applications':'applications','hufu_vault_decide':'decide','hufu_vault_revoke':'revoke','hufu_vault_reveal':'reveal'};
export function registerVaultTools(mcp,{inputSchemas,service,legacyAliases=false}){
 const routes=legacyAliases?[...vaultTools,...Object.entries(legacyVaultNames).map(([name,operation])=>({...vaultTools.find(t=>t.operation===operation),name}))]:vaultTools;
 for(const tool of routes){
  if(!inputSchemas[tool.operation])throw Error('vault_input_schema_required');
  mcp.registerTool(tool.name,{description:tool.description,inputSchema:inputSchemas[tool.operation],annotations:{readOnlyHint:tool.readOnly,destructiveHint:tool.operation==='revoke',openWorldHint:false}},async(args,ctx)=>{
   const token=ctx.http?.authInfo?.token;
   if(!token)return {isError:true,content:[{type:'text',text:'{"state":"failed","error_code":"unauthenticated"}'}]};
   const input={...args};
   const hasLogicalKey=['apply','decide'].includes(tool.operation);
   if(hasLogicalKey)input.idempotency_key??=randomUUID();
   const logicalKey=hasLogicalKey?input.idempotency_key:undefined;
   const meta=logicalKey?{_meta:{'hub2/logical_invocation_key':logicalKey}}:{};
   try{
    const b=validate(tool.operation,input);
    const result=tool.operation==='reveal'?await service.reveal(token,b):await service.call(tool.operation,token,b);
    return{content:[{type:'text',text:JSON.stringify(result)}],structuredContent:result,...meta};
   }catch(e){
    const failure=infrastructureFailure(e);const status=e instanceof VaultError?e.status:failure?.status??(e.code==='40001'||e.code==='23505'?409:503);
    const supplied=e instanceof VaultError?e.code:failure?.code;
    const code=typeof supplied==='string'&&/^[a-z][a-z0-9_]{0,119}$/.test(supplied)?supplied:status===403?'forbidden':status===409?'conflict':'vault_dependency_unavailable';
    const unknownEffect=hasLogicalKey&&status>=500;
    const result={state:unknownEffect?'outcome_unknown':'failed',error_code:code,http_status:status,retryable:e instanceof VaultError?e.retryable:status>=500,retained_state:unknownEffect?'unknown_query_original_application':'unchanged_or_query_original_operation',...(logicalKey?{idempotency_key:logicalKey}:{}),next_step:unknownEffect?'query_original_application_or_retry_same_input_and_key':status===403?'check_current_grant_and_required_identity_confirmation':status===409?'query_original_application_before_retry':status<500?'correct_input_using_current_tool_help':'retry_read_or_inspect_dependency'};
    return{isError:true,content:[{type:'text',text:JSON.stringify(result)}],structuredContent:result,...meta};
   }
  });
 }
}
export function httpVaultClient({hufuURL,fetcher=fetch}){const base=new URL(hufuURL);if(base.protocol!=='http:'||!['127.0.0.1','[::1]','localhost'].includes(base.hostname)||base.username||base.password||base.search||base.hash)throw Error('protected_Hufu_endpoint_required');async function call(name,token,body){const r=await fetcher(new URL('/v2/vault/'+name,base),{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(25000)});const v=await r.json();if(!r.ok)throw new VaultError(v.error_code,r.status,v.retryable);return v;}return{call,reveal:(token,b)=>call('reveal',token,b)};}
