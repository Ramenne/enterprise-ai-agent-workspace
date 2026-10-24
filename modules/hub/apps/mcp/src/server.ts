import {createHash as operationKeyHash} from 'node:crypto';
import {registerTierTools} from '../../../packages/storage-tiers/src/register-mcp.mjs';
import {z} from 'zod';
import {registerVaultTools,httpVaultClient} from '../../../packages/vault/src/mcp.mjs';
import {vaultInputSchemas} from '../../../packages/vault/src/schemas.mjs';
import { McpServer, createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { server, bearer, DomainError } from '../../../packages/platform/src/http.js';
import { tools, type ToolRoute } from './tools.js';
import { inputFor,businessInput } from './schemas.js';
import {capabilities,toolHelp,capabilitySchema,helpSchema,destructiveHint} from './capabilities.js';
import {randomUUID} from 'node:crypto';

// The adapter supplies a logical key to APIs that accept it. Recovery returns it to the caller.
const operationHeaderKey=(k:string)=>/^[\x20-\x7e]{1,200}$/.test(k)?k:'utf8-'+operationKeyHash('sha256').update(k).digest('hex');
const acceptsBusinessKey=new Set(['mem.object.probe','mem.object.repair','mem.compensation.apply','mem.material.move_scope','provider.management.plan','mem.legacy.reference_import','mem.asr.prepare','mem.asr.start','mem.gc.plan','mem.description.save','mem.description.vector_index','mem.url.import','resource.execute','mem.write_text','mem.processing.start','mem.processing.resume','mem.processing.cancel','mem.collection.create','mem.metadata.patch','mem.batch','mem.upload.begin','mem.upload.rebase','mem.placement.patch','mem.material.trash','mem.material.restore_content','mem.disclosure.create','mem.disclosure.revoke','mem.source.invalidate','mem.material_equivalence.create','mem.material_equivalence.undo','mem.vector.index']);

export interface McpConfig { urls: Record<'hufu'|'mem'|'v8',string>; semantic_url?:string; url_import_url?:string; maxResultBytes?:number; oauth?:{issuer:string;resource:string}; }

type JsonRecord=Record<string,unknown>;
function isJsonRecord(value:unknown):value is JsonRecord{return Boolean(value&&typeof value==='object'&&!Array.isArray(value));}

/** Keep every upstream failure a valid MCP tool result. */
export function normalizeUpstreamResult(route:ToolRoute,response:Response,text:string,logicalKey?:string,payload:JsonRecord={}):{isError:true,content:[{type:'text';text:string}],structuredContent:JsonRecord}{
 let parsed:unknown;
 try{parsed=JSON.parse(text);}catch{parsed=undefined;}
 const result:JsonRecord=isJsonRecord(parsed)?{...parsed}:{
  state:'failed', error_code:response.status===403?'forbidden':'upstream_invalid_result',
  retryable:response.status>=500, retained_state:route.readOnly?'unchanged':'unchanged_or_query_operation',
  next_step:response.status===403?'check_current_member_project_qualification':logicalKey?'query_original_operation_or_replay_same_input_and_key':'inspect_error',
  ...(logicalKey?{idempotency_key:logicalKey}:{}),
 };
 if(!isJsonRecord(parsed))result['http_status']=response.status;
 const forbidden=response.status===403||(isJsonRecord(parsed)&&parsed['error_code']==='forbidden');
 if(forbidden&&route.service==='v8'&&(route.name==='v8.work.save'||route.name==='v8.work.commit')){
  result['authorization']={required_action:'v8.work.commit',project_id:typeof payload['project_id']==='string'?payload['project_id']:undefined,reason:'project_read_does_not_imply_work_commit'};
  if(result['next_step']==='inspect_error')result['next_step']='check_current_member_project_qualification';
 }
 return {isError:true,content:[{type:'text',text:JSON.stringify(result)}],structuredContent:result};
}
export function createServer(config:McpConfig) {
 if(config.semantic_url){const endpoint=new URL(config.semantic_url);if(!['http:','https:'].includes(endpoint.protocol)||!['127.0.0.1','localhost','[::1]'].includes(endpoint.hostname)||endpoint.username||endpoint.password||endpoint.search||endpoint.hash||endpoint.pathname!=='/')throw new Error('semantic_endpoint_requires_protected_loopback');}
 if(config.url_import_url){const u=new URL(config.url_import_url);if(!['http:','https:'].includes(u.protocol)||!['127.0.0.1','localhost','[::1]'].includes(u.hostname)||u.username||u.password||u.search||u.hash||u.pathname!=='/')throw new Error('url_import_endpoint_requires_loopback');}
 const app=server('mcp');
 if(config.oauth){const oauth=config.oauth;for(const value of [oauth.issuer,oauth.resource])if(new URL(value).protocol!=='https:')throw new Error('oauth_public_https_required');
  app.get('/.well-known/oauth-protected-resource/mcp',async()=>({resource:oauth.resource,authorization_servers:[oauth.issuer],scopes_supported:['hub2.read','hub2.work'],bearer_methods_supported:['header']}));
  const resourcePath=new URL(oauth.resource).pathname.replace(/\/$/,'');
  const metadataUrl=new URL('/.well-known/oauth-protected-resource'+resourcePath,oauth.resource).href;
  app.addHook('onSend',async(request,reply,payload)=>{if(request.url.split('?')[0]==='/mcp'&&reply.statusCode===401)reply.header('www-authenticate','Bearer resource_metadata="'+metadataUrl+'", scope="hub2.work"');return payload;});
 }
 for(const url of Object.values(config.urls))if(!['127.0.0.1','localhost','[::1]'].includes(new URL(url).hostname))throw new Error('MCP domain endpoints must use protected local channel');
 const handler=createMcpHandler(()=>{
  const mcp=new McpServer({name:'workspace-hub2',version:'2.0.0-dev.1'});
registerTierTools(mcp,z,config.urls.mem);
 registerVaultTools(mcp,{inputSchemas:vaultInputSchemas(z),service:httpVaultClient({hufuURL:config.urls.hufu})});
  mcp.registerTool('hub.capabilities',{description:'Discover implemented tools by intent/domain. This catalog does not grant permissions or claim live provider readiness.',inputSchema:capabilitySchema,annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false}},async args=>{
   const result=capabilities(args);return {content:[{type:'text',text:JSON.stringify(result)}],structuredContent:result};
  });
  mcp.registerTool('hub.help',{description:'Get the actual tool route, known minimum inputs, input schema and recovery guidance without extra workflow approvals.',inputSchema:helpSchema,annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false}},async args=>{
   const result=toolHelp(args.tool);return {isError:result.state==='unknown_tool',content:[{type:'text',text:JSON.stringify(result)}],structuredContent:result};
  });
  for(const route of tools)mcp.registerTool(route.name,{description:route.description,inputSchema:inputFor(route.name),
   annotations:{readOnlyHint:route.readOnly,destructiveHint:destructiveHint(route.name),openWorldHint:false,idempotentHint:false}},async(args,ctx)=>{
    let payload:Record<string,unknown>;
    try{payload=businessInput(args);}catch{return {isError:true,content:[{type:'text',text:JSON.stringify({state:'failed',error_code:'mixed_input_conflict',retryable:false,next_step:'provide_one_consistent_business_input'})}]};}
    let logicalKey=args.idempotency_key??(typeof payload['idempotency_key']==='string'?payload['idempotency_key']:undefined);
    if(!logicalKey&&route.method==='POST'&&(!route.readOnly||route.name==='mem.object.probe')){logicalKey=typeof args.source_context?.invocation_id==='string'?args.source_context.invocation_id:randomUUID();}
    if(logicalKey&&route.method==='POST'&&(acceptsBusinessKey.has(route.name)||route.name.startsWith('hufu.project.privacy.')||(route.service==='v8'&&!route.readOnly)))payload['idempotency_key']=logicalKey;
    // Preserve the live append_only compatibility hotfix in maintained source.
    if(['v8.work.save','v8.work.commit'].includes(route.name)&&payload['write_mode']!==undefined){
     if(payload['write_mode']!=='append_only')return {isError:true,content:[{type:'text',text:JSON.stringify({state:'failed',error_code:'unsupported_write_mode',next_step:'use_append_only_or_omit_the_compatibility_field'})}]};
     delete payload['write_mode'];
    }
    // Envelope keys travel in headers; only declared business-key routes get a body key.
    if(!(acceptsBusinessKey.has(route.name)||(route.service==='v8'&&!route.readOnly)))delete payload['idempotency_key'];
    let path=route.path;
    if(route.pathParameter){const value=payload[route.pathParameter];if(typeof value!=='string'||!/^[0-9a-f-]{36}$/i.test(value))return {isError:true,content:[{type:'text',text:JSON.stringify({error_code:'invalid_path_parameter',state:'failed'})}]};path=path.replace(':'+route.pathParameter,value);delete payload[route.pathParameter];}
    const currentToken=ctx.http?.authInfo?.token;
    if(!currentToken)return {isError:true,content:[{type:'text',text:JSON.stringify({error_code:'unauthenticated',state:'failed'})}]};
    const endpoint=route.endpointKey==='semantic'?config.semantic_url:route.endpointKey==='url_import'?config.url_import_url:config.urls[route.service];
    const transportMeta=route.endpointKey&&logicalKey?{'hub2/logical_invocation_key':logicalKey}:undefined;
    if(!endpoint&&route.endpointKey==='url_import'){const result={state:'capability_unavailable',error_code:'url_import_unconfigured',retryable:false,fallback_tools:['mem.write_text','mem.upload.begin']};return{isError:true,content:[{type:'text',text:JSON.stringify(result)}],structuredContent:result,...(transportMeta?{_meta:transportMeta}:{})};}
    if(!endpoint){const result={state:'capability_unavailable',capability:'mem.semantic',error_code:'semantic_unconfigured',retryable:false,fallback_tools:['mem.search','mem.version.read'],next_step:'continue_authorized_original_work_or_configure_optional_semantic_service'};return {isError:true,content:[{type:'text',text:JSON.stringify(result)}],structuredContent:result,...(transportMeta?{_meta:transportMeta}:{})};}
    try {
     const key=logicalKey;
     if(route.service==='hufu'&&route.name!=='resource.execute'&&route.name!=='provider.management.plan'&&!route.name.startsWith('hufu.project.privacy.'))delete payload['idempotency_key']; // Management idempotency travels in the header, not a strict work-preset body.
     if(['mem.gc.scan','mem.gc.destroy','mem.gc.retry','mem.gc.status'].includes(route.name))delete payload['idempotency_key'];
     if(route.endpointKey==='semantic'||route.name==='mem.url.resume'||route.name==='mem.url.status'||route.readOnly&&route.name.startsWith('mem.description.'))delete payload['idempotency_key'];
     let response=await fetch(new URL(path,endpoint),{method:route.method,
      headers:{authorization:'Bearer '+currentToken,'content-type':'application/json',...(key?{'idempotency-key':operationHeaderKey(key)}:{}),
       ...(args.source_context?{'x-hub-source-context':Buffer.from(JSON.stringify(args.source_context)).toString('base64url')}:{})},
      ...(route.method==='POST'?{body:JSON.stringify(payload)}:{}),...(route.endpointKey?{redirect:'error' as const}:{}),signal:AbortSignal.timeout(route.endpointKey==='url_import'?70000:25000)});
     let text=await response.text();
     // A byte chunk can expand through JSON escaping. Reduce the same read in the transport layer.
     // The returned range/coverage remain those actually delivered; the Agent need not debug budgets.
     if(route.name==='mem.version.read')for(let attempt=0;Buffer.byteLength(text)>(config.maxResultBytes??256*1024)&&attempt<4;attempt++){
      payload['limit']=Math.max(1024,Math.floor((typeof payload['limit']==='number'?payload['limit']:65536)/2));
      response=await fetch(new URL(path,config.urls.mem),{method:'POST',headers:{authorization:'Bearer '+currentToken,'content-type':'application/json',
       ...(args.source_context?{'x-hub-source-context':Buffer.from(JSON.stringify(args.source_context)).toString('base64url')}:{})},body:JSON.stringify(payload),signal:AbortSignal.timeout(25000)});
      text=await response.text();
     }
     if(Buffer.byteLength(text)>(config.maxResultBytes??256*1024))return {isError:true,content:[{type:'text',text:JSON.stringify({state:'result_requires_expansion',error_code:'result_too_large',coverage:{complete:false,reason:'tool_result_budget'},next_step:'read_smaller_page_or_fixed_range'})}],...(transportMeta?{_meta:transportMeta}:{})};
     if(!response.ok)return {...normalizeUpstreamResult(route,response,text,logicalKey,payload),...(transportMeta?{_meta:transportMeta}:{})};
     let result:unknown;
     try{result=JSON.parse(text);}catch{return {...normalizeUpstreamResult(route,response,text,logicalKey,payload),...(transportMeta?{_meta:transportMeta}:{})};}
     if(!isJsonRecord(result))return {...normalizeUpstreamResult(route,response,text,logicalKey,payload),...(transportMeta?{_meta:transportMeta}:{})};
     return {isError:false,content:[{type:'text',text:JSON.stringify(result)}],structuredContent:result,...(transportMeta?{_meta:transportMeta}:{})};
    }catch{if(route.endpointKey==='url_import'){const result={state:'capability_unavailable',error_code:'url_import_dependency_unavailable',retryable:true,next_step:'query_or_resume_same_import_id;retain_original_key',fallback_tools:['mem.write_text','mem.upload.begin']};return{isError:true,content:[{type:'text',text:JSON.stringify(result)}],structuredContent:result,...(transportMeta?{_meta:transportMeta}:{})};}if(route.endpointKey==='semantic'){const result={state:'capability_unavailable',capability:'mem.semantic',error_code:'semantic_dependency_unavailable',retryable:true,fallback_tools:['mem.search','mem.version.read'],next_step:route.readOnly?'continue_authorized_original_work_or_retry_query':'read_or_save_Agent_description_then_retry_same_fixed_ref;retain_original_description_revision'};return {isError:true,content:[{type:'text',text:JSON.stringify(result)}],structuredContent:result,...(transportMeta?{_meta:transportMeta}:{})};}const result={state:'unknown',error_code:'dependency_unavailable',retryable:true,...(logicalKey?{idempotency_key:logicalKey}:{}),next_step:logicalKey?'query_original_operation_or_replay_same_input_and_key':'query_original_operation_before_retry'};return {isError:true,content:[{type:'text',text:JSON.stringify(result)}],structuredContent:result};}
  });
  return mcp;
 },{legacy:'stateless'});
 const node=toNodeHandler(handler);
 app.all('/mcp',async(request,reply)=>{
  const token=bearer(request);
  let member:Record<string,unknown>;
  try {const response=await fetch(new URL('/whoami',config.urls.hufu),{headers:{authorization:'Bearer '+token},signal:AbortSignal.timeout(5000)});
   if(!response.ok)throw new DomainError('unauthenticated',401);
   member=await response.json() as Record<string,unknown>;
  }catch(error){if(error instanceof DomainError)throw error;throw new DomainError('identity_unavailable',503,true);}
  reply.hijack();
  await node(Object.assign(request.raw,{method:request.method,url:request.url,auth:{token,clientId:String(member['client_id']),scopes:['hub2'],extra:{actor_id:member['actor_id'],assurance:'member_client_authenticated'}}}),reply.raw,request.body);
 });
 return app;
}
