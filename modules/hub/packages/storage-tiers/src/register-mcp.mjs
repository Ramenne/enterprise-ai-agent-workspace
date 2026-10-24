import {storageTierTools} from './mcp-storage-tier-schemas.mjs';
import {archiveLifecycleTools} from './archive-lifecycle-http.mjs';
import {randomUUID} from 'node:crypto';
export function registerTierTools(mcp,z,url){
 for(const t of [...storageTierTools(z),...archiveLifecycleTools(z)]){const logicalKey=t.name==='mem.object.archive'||t.name==='mem.object.restore';mcp.registerTool(t.name,{description:'Archive or restore a registered fixed document version. Platform resolves object locations; bucket/key and credentials are never caller inputs.',inputSchema:!logicalKey?t.schema:t.schema.extend({idempotency_key:z.string().min(1).max(200).optional()}),annotations:{readOnlyHint:t.name.endsWith('status')||t.name.endsWith('storage_info'),destructiveHint:false,openWorldHint:false}},async(args,ctx)=>{
  const token=ctx.http?.authInfo?.token;
  if(!token)return {isError:true,content:[{type:'text',text:'{"state":"failed","error_code":"unauthenticated"}'}]};
  const input={...args};if(logicalKey)input.idempotency_key??=randomUUID();
  try{
   const response=await fetch(new URL(t.path,url),{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify(input),signal:AbortSignal.timeout(65000)});
   const result=await response.json();return{isError:!response.ok,content:[{type:'text',text:JSON.stringify(result)}],structuredContent:result};
  }catch{return{isError:true,content:[{type:'text',text:JSON.stringify({state:'outcome_unknown',error_code:'storage_tier_unavailable',idempotency_key:input.idempotency_key,next_step:'query_same_operation_before_any_effect_retry'})}]};}
 });}
}
