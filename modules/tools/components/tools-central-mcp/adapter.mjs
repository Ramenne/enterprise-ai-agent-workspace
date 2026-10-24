import {createHash} from 'node:crypto';

const API_BASE='https://tools.example.invalid/agent/v1';
const PREFIX='tools.api.';
const BLOCKED=new Set(['account_password_read','account_notes_read','account_history','account_save','account_members','account_group_delete','account_access_read','account_access_save','account_member_access_read','account_member_access_save','account_member_visibility_save','skill_package_read','hardware_file_read']);
const requestIdSchema={type:'string',minLength:8,maxLength:120,pattern:'^[a-zA-Z0-9_.:-]+$',description:'同一业务重试保持此标识与完整原参数；新的独立操作使用新标识。'};
const object=(properties={},required=[])=>({type:'object',properties,required,additionalProperties:false});
const problem=(code,status=503,state='unavailable')=>Object.assign(new Error(code),{code,status,state});
const isObject=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const keyFor=(actor,id)=>'tools-mcp:'+createHash('sha256').update(actor+'\0'+id).digest('hex');
function requestId(id){if(typeof id!=='string'||!/^[a-zA-Z0-9_.:-]{8,120}$/.test(id))throw problem('stable_mcpRequestId_required',400,'failed');return id;}
function exact(args,keys){if(!isObject(args)||Object.keys(args).some(k=>!keys.includes(k)))throw problem('invalid_arguments',400,'failed');}
function helper(name,description,inputSchema,write=false){return{name:PREFIX+name,description,inputSchema,annotations:{readOnlyHint:!write,destructiveHint:false,idempotentHint:true,openWorldHint:true}};}

/** Embed in the existing central MCP dispatcher. No listener or saved member credential.
 * context.authorization is taken from the incoming authenticated request by the host,
 * never from model tool arguments. context.actorId is the host's authenticated actor.
 */
export function createToolsAdapter({fetchImpl=globalThis.fetch,apiBase=API_BASE,allowLocalForTests=false,timeoutMs=300_000}={}){
 const url=new URL(apiBase);
 if(apiBase!==API_BASE&&!(allowLocalForTests&&url.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(url.hostname)&&url.pathname==='/agent/v1'&&!url.username&&!url.password&&!url.search&&!url.hash))throw Error('fixed_tools_api_origin_required');
 const helpers=[helper('catalog','发现当前成员可调用的TOOLS模块和完整工具契约；调用使用本人中枢身份。',object()),helper('request_status','核对当前成员原mcpRequestId的写入回执。pending不代表完成；不自动重提操作。',object({mcpRequestId:requestIdSchema},['mcpRequestId']))];
 function credentials(context){
  if(!isObject(context)||typeof context.authorization!=='string'||!/^Bearer [^\s]{1,4096}$/.test(context.authorization)||typeof context.actorId!=='string'||!context.actorId)throw problem('authenticated_member_context_required',401,'authentication_required');
  return{authorization:context.authorization,actorId:context.actorId};
 }
 async function http(c,path,{body,key,write=false}={}){
  let r;
  try{r=await fetchImpl(apiBase+path,{method:body===undefined?'GET':'POST',headers:{authorization:c.authorization,accept:'application/json',...(body===undefined?{}:{'content-type':'application/json'}),...(key?{'idempotency-key':key}:{})},...(body===undefined?{}:{body:JSON.stringify(body)}),redirect:'error',signal:AbortSignal.timeout(timeoutMs)});}
  catch{throw problem('tools_response_unconfirmed',503,write?'pending':'unavailable');}
  let data;try{data=await r.json();}catch{throw problem('tools_response_unconfirmed',503,write?'pending':'unavailable');}
  if(!r.ok||data?.ok===false){const status=r.ok?502:r.status;throw problem(status===401?'member_authentication_required':status===403?'current_member_operation_forbidden':status===409?'original_request_conflict':status===404?'current_member_request_not_found':'tools_api_failed',status,status===401?'authentication_required':status>=500?(write?'pending':'unavailable'):'failed');}
  const result=data?.result??data;if(!isObject(result))throw problem('tools_invalid_response',502,write?'pending':'unavailable');return result;
 }
 async function discover(c){
  const catalog=await http(c,'/capabilities');
  if(catalog.identity?.actorId!==c.actorId)throw problem('upstream_member_identity_mismatch',403,'failed');
  const definitions=new Map();
  for(const op of catalog.operations??[]){
   if(!isObject(op)||typeof op.name!=='string'||!/^[a-zA-Z0-9_-]{1,100}$/.test(op.name)||BLOCKED.has(op.name)||!op.agentAvailable||op.sensitive||!isObject(op.inputSchema)||op.inputSchema.type!=='object'||definitions.has(op.name))continue;
   definitions.set(op.name,structuredClone(op));
  }
  const tools=[...definitions.values()].map(op=>{
   const inputSchema=structuredClone(op.inputSchema);
   if(op.write){inputSchema.properties={...inputSchema.properties,mcpRequestId:requestIdSchema};inputSchema.required=[...new Set([...(inputSchema.required??[]),'mcpRequestId'])];}
   return{name:PREFIX+op.name,description:op.description??op.name,inputSchema,annotations:{readOnlyHint:!op.write,destructiveHint:!!op.write&&/(state_save|delete)/.test(op.name),idempotentHint:true,openWorldHint:true}};
  });
  return{catalog,definitions,tools:[...helpers,...tools]};
 }
 async function catalog(context){const c=credentials(context);const d=await discover(c);return{service:'协作平台TOOLS',transport:'central-mcp-to-tools-https',identity:d.catalog.identity,modules:d.catalog.modules??[],tools:d.tools,localFileAccess:false};}
 async function invoke(context,name,args={}){
  let id;
  try{
   const c=credentials(context);
   if(typeof name!=='string'||!name.startsWith(PREFIX))throw problem('unknown_tools_tool',404,'failed');
   if(name===PREFIX+'catalog'){exact(args,[]);return{value:await catalog(c),isError:false};}
   const d=await discover(c);
   if(name===PREFIX+'request_status'){
    exact(args,['mcpRequestId']);id=requestId(args.mcpRequestId);
    const value=await http(c,'/operations/'+encodeURIComponent(keyFor(c.actorId,id)));
    return{value:{...value,_toolsMcp:{mcpRequestId:id,transport:'central-mcp-to-tools-https'}},isError:false};
   }
   const operation=name.slice(PREFIX.length),definition=d.definitions.get(operation);
   if(!definition)throw problem('current_member_operation_forbidden',403,'failed');
   if(!isObject(args))throw problem('invalid_arguments',400,'failed');
   const nativeArgs={...args};
   if(definition.write){id=requestId(nativeArgs.mcpRequestId);delete nativeArgs.mcpRequestId;}
   if(JSON.stringify(nativeArgs).includes(c.authorization.slice(7)))throw problem('credential_in_arguments_forbidden',400,'failed');
   // Always send the original payload to the API: its durable fingerprint check
   // rejects a reused key with changed arguments, even after gateway restarts.
   const value=await http(c,'/call',{body:{operation,arguments:nativeArgs},...(id?{key:keyFor(c.actorId,id)}:{}),write:!!definition.write});
   return{value:{...value,...(id?{_toolsMcp:{mcpRequestId:id,transport:'central-mcp-to-tools-https'}}:{})},isError:false};
  }catch(e){return{value:{state:e.state??'unavailable',error_code:e.code??'tools_adapter_unavailable',httpStatus:e.status??503,...(id?{mcpRequestId:id}:{})},isError:true};}
 }
 return{prefix:PREFIX,catalog,invoke};
}
