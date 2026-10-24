import {createCompatibilityObservation} from './compatibility-observation.mjs';
import {createMaterialList} from './application/material-list.mjs';
import{createUpload,uploadInvocationKey,uploadTool}from'./application/upload.mjs';
import {createMaterialMaintenance} from './application/material-maintenance.mjs';
import {createDomainInvoker} from './application/domain-client.mjs';
import {createEntryAuthentication} from './entry-authentication.mjs';
import{publicApiTransport}from'./public-api-transport.mjs';
import {withServiceProviderBoundary} from './service-boundary.mjs';
import {xingxiuTools,xingxiuRoute} from './xingxiu-tools.mjs';
import {controlTools,controlRoute} from './control-tools.mjs';
import{legacyToolName,isToolFailure,unknownTool,normalizeToolResponse}from'./tool-compatibility.mjs';
import{fileNumberTools,findFileNumber}from'./file-number-tools.mjs';
import{currentDocumentation as publishedDocumentationView}from'./documentation-view.mjs';
import {compatibleWorkArguments} from './reference-compatibility.mjs';
import {authorizationTools,authorizationRoute} from './authorization-tools.mjs';
import {databaseTools} from './database-tools.mjs';
import {serviceTools,serviceRegistry} from './service-registry.mjs';
import {disclosureTools,catalogue,defaultNames} from './disclosure.mjs';
import {materialTools,createMaterialTools}from'./material-tools.mjs';
import {createCurrentPaths} from './current-paths759.mjs';
import {currentContextRules} from './current-read758/current-context-rules.mjs';
import {createCurrentFileTools} from './current-read758/current-file-tools.mjs';
import {createLegacyMutations,mutationTools} from './mutations757/legacy-mutations.mjs';
import {createRegisteredSpaces} from './mutations757/registered-spaces.mjs';
import {createNativeStageTools} from './stage756/native-stage-tools.mjs';
import {createStageRoutes} from './stage756/routes.mjs';
import {createProcessingSource} from './stage756/processing-source.mjs';
import{createMappedPersonalTools}from'./mapped-personal-tools.mjs';
import {createLegacyHttpRead} from './legacy-http-read751.mjs';
import{createRegisteredPrivateReader}from'./private-alias-read.mjs';
import {createPersonalTools,parsePersonalLocator} from './personal/personal-tools.mjs';
import {tools as governanceMetadata} from './governance-metadata.mjs';
import {resolveFixedSource} from './gateway-fixed-source.mjs';
import {createNativeSharedTools} from './shared-write/native-shared-tools.mjs';
import {createSharedTools} from './shared-write/shared-tools.mjs';
import {createPrivateState} from './shared-write/private-state.mjs';
import {LegacyFileClient} from './legacy-client-v4.mjs';
import {createLegacyReadUpgrade} from './legacy-read-upgrade.mjs';
/** Original gradual-upgrade MCP gateway: caller identity stays attached to every upstream call. */
import http from 'node:http';
import {createHash,randomUUID} from 'node:crypto';
import {mkdir,readFile} from 'node:fs/promises';
import {workingFlows,workflowTools} from './workflows.mjs';
import {vaultUpgrade} from './vault-upgrade.mjs';
const cfg={port:Number(process.env.PORT||8939),oldMcp:process.env.LEGACY_MCP_URL||'http://127.0.0.1:8936/mcp',oldAuth:process.env.LEGACY_AUTH_URL||'http://127.0.0.1:8933',nextMcp:'http://127.0.0.1:4614/mcp',nextAuth:'http://127.0.0.1:4611',nextMem:'http://127.0.0.1:4612',nextV8:'http://127.0.0.1:4613',semantic:process.env.SEMANTIC_URL};
const cache=new Map(),flights=new Map();const hash=x=>createHash('sha256').update(x).digest('hex');
const journalRoot=process.env.JOURNAL_ROOT||'/var/lib/hub2-mcp-upgrade';
await mkdir(journalRoot,{recursive:true,mode:0o700});
const canonical=x=>x&&typeof x==='object'?(Array.isArray(x)?'['+x.map(canonical).join(',')+']':'{'+Object.keys(x).sort().map(k=>JSON.stringify(k)+':'+canonical(x[k])).join(',')+'}'):JSON.stringify(x);
const error=(message,status=400)=>Object.assign(Error(message),{status});
const compatibilityObservation=createCompatibilityObservation();
const compatibilityCaller=token=>!token.startsWith('hub2_')?'legacy_credential':entryAuthentication.currentIdentity(token)?.principal_kind==='member'?'native_member_principal':entryAuthentication.currentIdentity(token)?.principal_kind==='service'?'native_service_principal':'native_other_principal';
function write(res,status,value,headers={}){res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff',...headers});res.end(typeof value==='string'?value:JSON.stringify(value));}
async function input(req){let size=0,parts=[];for await(const p of req){size+=p.length;if(size>32*1024*1024)throw error('request_too_large',413);parts.push(p);}return JSON.parse(Buffer.concat(parts).toString('utf8')||'{}');}
async function api(base,path,token,body,idempotencyKey=body?.idempotency_key){const r=await fetch(new URL(path,base),{method:body?'POST':'GET',headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{}),...(typeof idempotencyKey==='string'?{'Idempotency-Key':idempotencyKey}:{})},...(body?{body:JSON.stringify(body)}:{}),redirect:'error',signal:AbortSignal.timeout(30000)});const data=await r.json();if(!r.ok)throw Object.assign(error(data.error_code||data.error||'upstream_rejected',r.status),{detail:data});return data;}
function rpcBody(text,type){if(type?.includes('text/event-stream')){for(const e of text.split(/\r?\n\r?\n/)){const s=e.split(/\r?\n/).filter(x=>x.startsWith('data:')).map(x=>x.slice(5).trimStart()).join('\n');if(s){const value=JSON.parse(s);if(value.id!==undefined)return value;}}return undefined;}return text?JSON.parse(text):undefined;}
async function rpc(endpoint,token,message,req){if(endpoint===cfg.oldMcp)compatibilityObservation.observe('backend:legacy_mcp',compatibilityCaller(token),req);const headers={authorization:'Bearer '+token,'content-type':'application/json',accept:'application/json, text/event-stream','MCP-Protocol-Version':req.headers['mcp-protocol-version']||'2025-11-25'};
 for(const name of ['mcp-session-id','last-event-id'])if(req.headers[name])headers[name]=req.headers[name];
 // Only our trusted ingress supplies the forwarding chain, never an arbitrary end user identity.
 if(req.headers['x-real-ip'])headers['x-real-ip']=req.headers['x-real-ip'];
 if(req.headers['x-forwarded-for'])headers['x-forwarded-for']=req.headers['x-forwarded-for'];
 const r=await fetch(endpoint,{method:'POST',headers,body:JSON.stringify(message),redirect:'error',signal:AbortSignal.timeout(120000)});const text=await r.text();if(!r.ok)throw Object.assign(error('MCP_upstream_rejected',r.status),{detail:rpcBody(text,r.headers.get('content-type'))});return rpcBody(text,r.headers.get('content-type'));
}
function unwrap(r){const result=r?.result;const data=result?.structuredContent||(result?.content?.[0]?.text?JSON.parse(result.content[0].text):result);if(result?.isError)throw Object.assign(error(data?.error_code||data?.state||'tool_rejected',data?.error_code==='forbidden'?403:data?.error_code==='unauthenticated'?401:data?.retryable?503:409),{detail:data});return data;}
async function verifiedLegacy(token){let access=token;if(token.split('.').length!==3){const d=await api(cfg.oldAuth,'/hufu/auth/exchange',null,{credential:token});access=d.token;if(!access)throw error('legacy_exchange_failed',401);}
 const id=await api(cfg.oldAuth,'/hufu/auth/verify',access);if(id.valid!==true||typeof id.username!=='string'||!Number.isFinite(id.expires_at)||id.expires_at<=Date.now())throw error('legacy_identity_invalid',401);return{access,identity:id};}
const entryAuthentication=createEntryAuthentication({resolveNative:token=>api(cfg.nextAuth,'/whoami',token),resolveLegacy:verifiedLegacy});
async function nextIdentity(token){
 if(token.startsWith('hub2_'))return{token,identity:entryAuthentication.currentIdentity(token)??await api(cfg.nextAuth,'/whoami',token)};
 // Validate the original proof on every request, including an existing cached bridge.
 const verified=await verifiedLegacy(token),key=hash(token);compatibilityObservation.observe('identity:legacy_bridge','legacy_credential');const old=cache.get(key);
 if(old&&old.subject===verified.identity.username&&old.expires>Date.now()+10000){await api(cfg.nextAuth,'/whoami',old.token);return old;}
 if(flights.has(key))return flights.get(key);
 const job=(async()=>{const client_label='MCP-1.0-compatible-upgrade',client_actions=[];const begin=await api(cfg.nextAuth,'/v2/auth/legacy/start',null,{client_label,client_actions,audience:'hub2'});
  const finish=await api(cfg.nextAuth,'/v2/auth/legacy/finish',verified.access,{...begin.binding,challenge_id:begin.challenge_id,nonce:begin.nonce});if(!finish.credential)throw error('bridge_failed',503);
  const result={token:finish.credential,identity:finish,subject:verified.identity.username,expires:Date.parse(finish.expires_at)};cache.set(key,result);return result;
 })();flights.set(key,job);try{return await job;}finally{flights.delete(key);}
}
// Forwarding does not grant authority: the destination validates the original credential.
const nextCredential=token=>token.startsWith('hub2_')?Promise.resolve({token}):nextIdentity(token);
const call=(endpoint,token,name,args,req,id=randomUUID())=>rpc(endpoint,token,{jsonrpc:'2.0',id,method:'tools/call',params:{name,arguments:args}},req);
const nativeIdentityAliases=[
 {name:'hufu_whoami',description:'Verify the current native member or software identity and its current scope.',inputSchema:{type:'object',properties:{}}},
 {name:'hufu_context',description:'Current native infrastructure context, usable workflows and remaining legacy compatibility coverage.',inputSchema:{type:'object',properties:{}}},
 {name:'hufu_vault_list',description:'List the visible credential directory under your own current native grants; values remain masked.',inputSchema:{type:'object',properties:{}}},
 {name:'hufu_vault_reveal',description:'Use an already granted native ordinary credential; retained high-sensitive entries return the actual channel boundary.',inputSchema:{type:'object',properties:{key_id:{type:'string'}},required:['key_id']}},
 {name:'mengchu_get',description:'Read authorized native shared or personal files, and registered migrated fixed history.',inputSchema:{type:'object',properties:{file_id:{type:'string'},ver:{type:'number'}},required:['file_id']}},
 uploadTool,
 {name:'mengchu_note',description:'Maintain the fixed native document introduction or the migrated shared registration.',inputSchema:{type:'object',properties:{file_id:{type:'string'},note:{type:'string'}},required:['file_id','note']}},
 {name:'mengchu_search',description:'Find authorized personal or shared materials and introductions; coverage identifies migrated and remaining legacy results.',inputSchema:{type:'object',properties:{space:{enum:['shared','personal']},scope:{enum:['files','knowledge']},project_id:{type:'string',description:'个人空间限定项目ID'},project_name:{type:'string',description:'个人空间限定本人项目名称'},project:{type:'string',description:'个人空间项目名称兼容字段'},q:{type:'string'},limit:{type:'number'}}}}
];
const clientLookupTools=[{name:'hufu.client.lookup',description:'只读查询客户端ID对应的成员身份、客户端名称、状态、epoch和权限主体。需要主管客户端能力；不返回邮箱、密钥或令牌。',inputSchema:{type:'object',properties:{client_id:{type:'string'}},required:['client_id'],additionalProperties:false}}];
const futureApiSchema={name:'hub2_api',description:'Access 2.0 public /v2 APIs with your current member identity; old hub_api routes remain available. Never use /internal or a shared controller identity.',inputSchema:{type:'object',properties:{system:{enum:['hufu','meng','v8']},method:{enum:['GET','POST']},path:{type:'string'},body:{type:'object'}},required:['system','method','path']}};
const upgradeContext={name:'hub2_context',description:'Discover your current 2.0 member identity, available enhanced tools and the preserved 1.0 workflow. Ordinary Vault runs on Jiaxin; old sensitive access and V8 business remain compatible. Migrated shared files use current 2.0 reads and MCP writes; remaining old spaces and upper products retain their original channels.',inputSchema:{type:'object',properties:{}}};
import {fullReadTool as fullRead,createOriginalReader} from './application/read-original.mjs';
import {documentSave} from './document-contract.mjs';
import {createDocumentSave} from './application/document.mjs';
import {createMaterialDetail,materialDetailTool} from './application/material-detail.mjs';
const domainRoutes=JSON.parse(await readFile(new URL('./application/domain-routes.json',import.meta.url),'utf8')).routes;
const invokeUsecase=createDomainInvoker({routes:domainRoutes,endpoints:{semantic:cfg.semantic},request:(auth,route,body)=>api(route.baseUrl||{hufu:cfg.nextAuth,mem:cfg.nextMem,v8:cfg.nextV8}[route.service],route.path,auth.token,body,route.idempotencyHeaderKey),fallback:async(auth,name,args,req)=>unwrap(await call(cfg.nextMcp,auth.token,name,args,req))});
const findMaterialPath=(auth,body)=>api(cfg.nextMem,'/v2/materials/by-path',auth.token,body);
const saveDocument=createDocumentSave({journalRoot,error,invokeNext:invokeUsecase,findPath:findMaterialPath});
const materialDetail=createMaterialDetail({mem:(auth,path,body)=>api(cfg.nextMem,path,auth.token,body)});
const materialList=createMaterialList({mem:(auth,path,body)=>api(cfg.nextMem,path,auth.token,body),v8:(auth,path,body)=>api(cfg.nextV8,path,auth.token,body)});
async function context(token,req){let next=null,limitation=null;try{next=await nextIdentity(token);}catch(e){limitation=e.message;}
 const documentation=await publishedDocumentationView();let updates=null;if(next)try{updates=await api(cfg.nextAuth,'/v2/releases/updates',next.token);}catch{}
 return withServiceProviderBoundary({state:next?'ready':'authentication_required',version:documentation.system_version||'2.0-current-onboarding',context_schema:'2.0-current-onboarding',updates,identity:next?.identity||null,preserved_identity:null,entry:'https://hufu.example.invalid/mcp',documentation,
 deployment:{entry_server:'Jiaxin',old_main_services:'stopped_retained_code_and_data',shared_migration:{registered_sources:true,coverage:'per_file_and_version_registry;recent_batch_and_history_are_separate',counts_source:'current_registry'},personal:{native_MCP_read_write:true,coverage:'current_member_authorized_registered_sources'},software:{until_revoked:true,project_and_Vault_filters:true},fixed_history_tool:'mengchu_get(file_id,ver)'},
 workflow:{ordinary:['hufu_whoami','hufu_context','mengchu_search','mengchu_get','mengchu_upload','mengchu_note','v8_project_create','v8_work_open','v8_work_save','v8_work_read'],credentials:['hufu_vault_list','hufu_vault_reveal'],enhanced:['hub.project.open','hub.document.save','hub.work.resume','hub.material.govern','mem.semantic.query','v8.context.materialize']},
 dialogue_recording:{mode:'existing_v8_work_and_memstore',native_id_optional:true,transcript_coverage:'complete_export_or_visible_fragment_or_agent_summary;state_actual_coverage',receipts:'append_at_stage_report_material_direction_change_handoff_or_end',automatic_full_client_capture:false,preset:'documentation.agent_preset'},
 rules:['在本人已有权限内自主工作，架构和逻辑通畅、实际使用与随用随改优先。','按任务做必要检查，不把全量验收、封包或版本归一设为普遍前置。','沿用已有工作与对话关联，在阶段报告后留存真实回执。','原文与总结分别留存，来源缺失和覆盖范围明确标注。','资料采用固定版本，新的文件版本不会自动替换旧引用。','重要性、相关性与采用由成员和Agent判断；缺少简介不阻塞原件存取。','只为明确重要的文件按需建立简介向量；非热用资料按实际状态归档与恢复。','软件配置、成员资格与资源权限由当前服务校验；说明书和来源记录不会扩大授权。'],
 governance_contract:{importance:'Agent_or_member_judgment',new_vectors:'explicitly_important_descriptions_only',archive:'actual_storage_tier_state',storage_policy:{tiers:['standard','archive'],idle_days:14,warm_uses:3,legacy_infrequent:'migrate_to_archive',classification_pending:'/v2/materials/classification/pending',automatic_logical_deletion:false}},authority:{business:'native_v8',files:'native_memstore_and_registered_fixed_history',credentials:'current_native_hufu_directory;retained_high_sensitive_entries_may_be_pending',backend:'Jiaxin_PostgreSQL_and_COS',upper_products:'per_product_release_state'},...(limitation?{enhancement_error:limitation,next_step:'use_current_member_email_login_and_own_software_configuration'}:{})});}

function toolResult(id,data,isError=false){isError=isError||isToolFailure(data);return{jsonrpc:'2.0',id,result:{content:[{type:'text',text:JSON.stringify(data)}],structuredContent:data,...(isError?{isError:true}:{})}};}
const readOriginal=createOriginalReader({mem:(auth,path,body)=>api(cfg.nextMem,path,auth.token,body),error});
const readFull=(auth,args,req)=>readOriginal(auth,args,{eventKey:req?.materialUseKey780});
const flows=workingFlows({findPath:findMaterialPath,governState:await createPrivateState(journalRoot+'/material-maintenance'),searchMetadata:async(auth,input)=>api(cfg.nextMem,'/v2/materials/retrieve',auth.token,input),invokeNext:invokeUsecase,invokeOld:async(name,args,req)=>unwrap(await call(cfg.oldMcp,req.headers.authorization.slice(7),name,args,req)),readFull,error});
async function saveByName(auth,args,req){const project=args.project_id?{id:args.project_id}:await flows.resolveProject(auth,args,req);const body={...args,project_id:project.id||project.project_id};for(const k of ['project_name','project','create_if_missing','visibility','kind','manager_id'])delete body[k];return{...await saveDocument(auth,body,req),project:{id:project.id||project.project_id,title:project.title}};}
let managedKeyList=[];try{managedKeyList=JSON.parse(await readFile(new URL('./managed-vault-keys.json',import.meta.url),'utf8')).keys||[];}catch{}
const upgradedVault=vaultUpgrade({managedKeys:new Set(managedKeyList),nextIdentity,newApi:(path,token,body)=>api(cfg.nextAuth,path,token,body),oldTool:async(token,name,args,req)=>{if(name==='hufu_vault_list'){const own=await verifiedLegacy(token);return api(cfg.oldAuth,'/hufu/vault/list',own.access);}return unwrap(await call(cfg.oldMcp,token,name,args,req));},oldApi:async(token,path,body)=>{const own=await verifiedLegacy(token);return api(cfg.oldAuth,path,own.access,body);},error});
const currentPaths759=createCurrentPaths({memberMem:(a,path,body)=>api(cfg.nextMem,path,a.token,body),aliases:JSON.parse(await readFile(new URL('./current-read758/registered-aliases.json',import.meta.url),'utf8')),originalPaths:[...JSON.parse(await readFile(new URL('./shared-write/catalog.json',import.meta.url),'utf8')).files,...JSON.parse(await readFile(new URL('./private-write-catalog.json',import.meta.url),'utf8')).files].map(x=>x.path)});
const sharedTools=createSharedTools({
 currentPaths:currentPaths759,
 control:JSON.parse(await readFile(new URL('./shared-write/control.json',import.meta.url),'utf8')),
 state:await createPrivateState('/var/lib/hub2-mcp-upgrade/shared-write'),
 nextIdentity:async caller=>{const a=await nextIdentity(caller.token);return{...a,actor_id:a.identity.actor_id,legacy_username:a.subject,request:caller.req};},
 memberMem:(a,path,body)=>api(cfg.nextMem,path,a.token,body),
 readFull:async(a,args)=>{const r=await readFull(a,{...args,encoding:'base64'},a.request);return{bytes:Buffer.from(r.bytes_base64,'base64')};},
 makeClient:async a=>new LegacyFileClient({base:'http://127.0.0.1:'+(cfg.nextMem.includes('14612')?'14682':'18478')+'/',getCredential:()=>a.token}),
 invocationKey:async(caller,tool,args)=>uploadInvocationKey(caller,tool,args,()=>hash(canonical([caller.req.headers['mcp-session-id']||'stateless',caller.message_id,tool,args]))),
 indexDescription:(a,args)=>invokeUsecase(a,'mem.semantic.index_fixed',args,a.request),
 searchUnmigrated:async(caller,args)=>{if(caller.token.startsWith('hub2_'))return null;const r=unwrap(await call(cfg.oldMcp,caller.token,'mengchu_search',args,caller.req));return{items:(r.files||r.knowledge||r.items||[]).filter(x=>x.space==='shared')};}
});
const nativeSharedTools=createNativeSharedTools({
 currentPaths:currentPaths759,
 control:JSON.parse(await readFile(new URL('./shared-write/control.json',import.meta.url),'utf8')),
 state:await createPrivateState('/var/lib/hub2-mcp-upgrade/native-shared-write'),
 nextIdentity:async caller=>{const a=await nextIdentity(caller.token);return{...a,actor_id:a.identity.actor_id,legacy_username:a.subject,request:caller.req};},
 memberMem:(a,path,body)=>api(cfg.nextMem,path,a.token,body),
 saveDocument:(a,body)=>saveDocument(a,body,a.request),
 readFull:(a,args)=>readFull(a,args,a.request),
 makeClient:async a=>new LegacyFileClient({base:'http://127.0.0.1:'+(cfg.nextMem.includes('14612')?'14682':'18478')+'/',getCredential:()=>a.token}),
 invocationKey:async(caller,tool,args)=>uploadInvocationKey(caller,tool,args,()=>hash(canonical([caller.req.headers['mcp-session-id']||'stateless',caller.message_id,tool,args]))),
 addressFor:id=>(id.startsWith('m2_')||id.startsWith('m2p_')?'https://hufu.example.invalid/files/':'https://mengchu.example.invalid/f/')+id,
 indexDescription:(a,args)=>invokeUsecase(a,'mem.semantic.index_fixed',args,a.request)
});
const personalTools=createPersonalTools({
 currentPaths:currentPaths759,
 control:JSON.parse(await readFile(new URL('./personal/control.json',import.meta.url),'utf8')),
 state:await createPrivateState('/var/lib/hub2-mcp-upgrade/personal'),
 nextIdentity:async caller=>{const a=await nextIdentity(caller.token);return{...a,actor_id:a.identity.actor_id,request:caller.req};},
 memberV8:(a,path,body)=>api(cfg.nextV8,path,a.token,body),memberMem:(a,path,body)=>api(cfg.nextMem,path,a.token,body),
 saveDocument:(a,body)=>saveDocument(a,body,a.request),readFull:(a,args)=>readFull(a,args,a.request),
 makeClient:async a=>new LegacyFileClient({base:'http://127.0.0.1:'+(cfg.nextMem.includes('14612')?'14682':'18478')+'/',getCredential:()=>a.token}),
 invocationKey:async(caller,tool,args)=>uploadInvocationKey(caller,tool,args,()=>hash(canonical([caller.req.headers['mcp-session-id']||'stateless',caller.message_id,tool,args]))),
 hasOriginalCredential:async caller=>!caller.token.startsWith('hub2_'),
 oldPersonalPathExists:async(caller,path)=>{const r=unwrap(await call(cfg.oldMcp,caller.token,'mengchu_search',{space:'personal',scope:'files',q:path,limit:500},caller.req));return(r.files||r.items||[]).some(x=>x.path===path||x.path?.endsWith('/'+path));},
 addressFor:id=>(id.startsWith('m2_')||id.startsWith('m2p_')?'https://hufu.example.invalid/files/':'https://mengchu.example.invalid/f/')+id,
 indexDescription:(a,args)=>invokeUsecase(a,'mem.semantic.index_fixed',args,a.request)
});
const mappedPersonalTools=createMappedPersonalTools({
 currentPaths:currentPaths759,
 control:{mode:'next_personal_mapped_mcp',space:'personal',project_id:'6aedbc32-3768-47cc-a1e2-ff4297be5be7',source_system:'legacy-mengstore-personal-demo',fenced_file_ids:['6M94j2RoxkoY','kZ3tXcnFYQsh']},
 state:await createPrivateState('/var/lib/hub2-mcp-upgrade/mapped-personal-write'),
 nextIdentity:async caller=>{const a=await nextIdentity(caller.token);return{...a,actor_id:a.identity.actor_id,legacy_username:a.subject,request:caller.req};},
 memberMem:(a,path,body)=>api(cfg.nextMem,path,a.token,body),
 readFull:async(a,args)=>{const r=await readFull(a,{...args,encoding:'base64'},a.request);return{bytes:Buffer.from(r.bytes_base64,'base64')};},
 makeClient:async a=>new LegacyFileClient({base:'http://127.0.0.1:'+(cfg.nextMem.includes('14612')?'14682':'18478')+'/',getCredential:()=>a.token}),
 invocationKey:async(caller,tool,args)=>uploadInvocationKey(caller,tool,args,()=>hash(canonical([caller.req.headers['mcp-session-id']||'stateless',caller.message_id,tool,args]))),
 indexDescription:(a,args)=>invokeUsecase(a,'mem.semantic.index_fixed',args,a.request),
 searchUnmigrated:async(caller,args)=>{const r=await personalTools.search(caller,args);return{items:(r.result?.items||[]).filter(x=>!['6M94j2RoxkoY','kZ3tXcnFYQsh'].includes(x.file_id||x.id))};}
});
const uploadApplication=createUpload({identity:caller=>nextIdentity(caller.token),describe:(a,ref,text,key)=>materialMaintenance(a,'description',{material_id:ref.material_id,version_id:ref.version_id,text,idempotency_key:key},{}),state:await createPrivateState(journalRoot+'/upload-intents'),routes:[(c,a)=>mappedPersonalTools.intercept('mengchu_upload',c,a),(c,a)=>personalTools.upload(c,a),(c,a)=>sharedTools.intercept('mengchu_upload',c,a),(c,a)=>nativeSharedTools.upload(c,a)]});
const readMigratedLegacy=createLegacyReadUpgrade({
 locateFile:async()=>({project_id:'d5027a95-f21b-483d-a9f1-06a91db45551',source_system:'legacy-mengstore-shared'}),
 nextIdentity:async caller=>{const auth=await nextIdentity(caller.token);return{...auth,actor_id:auth.identity.actor_id,request:caller.req};},
 memberMem:(auth,path,body)=>api(cfg.nextMem,path,auth.token,body),
 readFull:async(auth,args)=>{const r=await readFull(auth,{...args,encoding:'base64'},auth.request);return{bytes:Buffer.from(r.bytes_base64,'base64')};}
});
const readRegisteredPrivate=createRegisteredPrivateReader({
 nextIdentity:async caller=>{const auth=await nextIdentity(caller.token);return{...auth,actor_id:auth.identity.actor_id,request:caller.req};},
 memberMem:(auth,path,body)=>api(cfg.nextMem,path,auth.token,body),
 readFull:(auth,args)=>readFull(auth,args,auth.request)
});


const sharedControl758=JSON.parse(await readFile(new URL('./shared-write/control.json',import.meta.url),'utf8'));
const nativePersonalControl758=JSON.parse(await readFile(new URL('./personal/control.json',import.meta.url),'utf8'));
const privateControl758={project_id:'6aedbc32-3768-47cc-a1e2-ff4297be5be7',source_system:'legacy-mengstore-personal-demo',fenced_file_ids:['6M94j2RoxkoY','kZ3tXcnFYQsh']};
const aliasRows758=JSON.parse(await readFile(new URL('./current-read758/registered-aliases.json',import.meta.url),'utf8'));
const registered758=JSON.parse(await readFile(new URL('./stage756/registrations.json',import.meta.url),'utf8'));
const managed758=[...(sharedControl758.fenced_file_ids||[]),...privateControl758.fenced_file_ids];
const identity758=async caller=>{const a=await nextIdentity(caller.token);return{...a,actor_id:a.identity.actor_id,request:caller.req};};
const memberMem758=(a,path,body)=>api(cfg.nextMem,path,a.token,body);
const memberV8758=(a,path,body)=>api(cfg.nextV8,path,a.token,body);
const invocation758=async(caller,name,args)=>hash(canonical([caller.req.headers['mcp-session-id']||'stateless',caller.message_id,name,args]));
const currentFiles758=createCurrentFileTools({nextIdentity:identity758,memberMem:memberMem758,readFull:(a,args)=>readFull(a,args,a.request),managedIds:managed758,state:await createPrivateState('/var/lib/hub2-mcp-upgrade/current-read758'),invocationKey:invocation758,indexDescription:(a,args)=>invokeUsecase(a,'mem.semantic.index_fixed',args,a.request)});
const mutations757=createLegacyMutations({nextIdentity:identity758,memberMem:memberMem758,locateMaterial:(a,material_id)=>memberMem758(a,'/v2/materials/locate',{material_id}),resolveRegisteredFile:async(a,id)=>{const r=await currentFiles758.alias(id);if(!r)throw error('registered_material_required',409);return{material_id:r.material_id};},isRegisteredFile:async id=>currentFiles758.isManaged(id),resolveSpace:createRegisteredSpaces({sharedControl:sharedControl758,personalControl:nativePersonalControl758,memberV8:memberV8758}),state:await createPrivateState('/var/lib/hub2-mcp-upgrade/mutations757'),invocationKey:invocation758});
const stageRoutes756=createStageRoutes({registered:registered758,nextIdentity:identity758,memberMem:memberMem758,resolvePersonalProject:async(caller,args)=>{const a=await identity758(caller),p=await personalTools.selectProject(a,args);return{handled:true,project_id:p.id};}});
const processingSource756=createProcessingSource({memberMem:memberMem758});
const stageTools756=createNativeStageTools({root:'/var/lib/hub2-mcp-upgrade/staging756',nextIdentity:identity758,locateFile:async(caller,file_id)=>{const r=await currentFiles758.locate(caller,{file_id});return r.handled?{handled:true,fixed_ref:r.location.fixed_ref}:{handled:false};},locateTarget:stageRoutes756.locateTarget,resolveFixed:async(a,ref)=>(await memberMem758(a,'/v2/materials/locate',{material_id:ref.material_id,version_id:ref.version_id})).fixed_ref,readChunk:async(a,body)=>unwrap(await call(cfg.nextMcp,a.token,'mem.version.read',body,a.request)),makeClient:async a=>new LegacyFileClient({base:'http://127.0.0.1:'+(cfg.nextMem.includes('14612')?'14682':'18478')+'/',getCredential:()=>a.token}),state:await createPrivateState('/var/lib/hub2-mcp-upgrade/stage-operations756'),invocationKey:invocation758,...processingSource756});
const stageMetadata756=[{name:'mengchu_stage_fetch',description:'Stream an authorized fixed original into your controlled64MiB server inbox; no body in MCP response.',inputSchema:{type:'object',properties:{file_id:{type:'string'}},required:['file_id']}},{name:'mengchu_stage_upload',description:'Publish your own controlled staged bytes and preserve their processing Source; no arbitrary server paths.',inputSchema:{type:'object',properties:{src_path:{type:'string'},path:{type:'string'},space:{type:'string'},note:{type:'string'}},required:['src_path','path','space']}}];

const legacyHttpRead751=createLegacyHttpRead({readLatest:(caller,args)=>currentFiles758.get(caller,args),readFixed:(caller,args)=>currentFiles758.get(caller,args),error,streamFile:async(caller,args)=>{const l=await currentFiles758.locate(caller,args);if(!l.handled)throw error('current_file_unavailable',409);const r=await fetch(new URL('/v2/files/read',cfg.nextMem),{method:'POST',headers:{authorization:'Bearer '+l.auth.token,'content-type':'application/json'},body:JSON.stringify({project_id:l.location.project_id,material_id:l.location.material_id,version_id:l.location.fixed_ref.version_id}),redirect:'error',signal:AbortSignal.timeout(300000)});if(!r.ok){await r.body?.cancel();throw error('current_file_stream_unavailable',r.status);}return r;},isSelected:id=>currentFiles758.knows(id),selectedIds:['ABT5odW_QjdI','6M94j2RoxkoY','kZ3tXcnFYQsh']});
const materialFlows780=createMaterialTools({state:await createPrivateState('/var/lib/hub2-mcp-upgrade/material-attributes'),memberMem:(a,path,body)=>api(cfg.nextMem,path,a.token,body),memberHufu:(a,path,body)=>api(cfg.nextAuth,path,a.token,body),error});
const materialMaintenance=createMaterialMaintenance({govern:flows.govern,materials:materialFlows780,mem:(a,path,body)=>api(cfg.nextMem,path,a.token,body),invokeNext:invokeUsecase,error});
const compatibilityAliases=new Map([['capabilities','hub.tools'],['hub.capabilities','hub.tools'],['tool.help','hub.help'],['hub.tool.help','hub.help']]);
const canonicalToolName=name=>legacyToolName(compatibilityAliases.get(name)||name);
const intentWords=s=>{const aliases=[['权限','permission access authorization'],['项目','project'],['工程','engineering resource'],['申请','application request apply'],['审批','decide approve application'],['服务','service runtime'],['资料','material document file'],['文件','material document file'],['数据库','database table'],['凭据','credential vault'],['密钥','credential secret vault'],['交付','delivery'],['工作','work task'],['项目负责人','manager owner'],['权限分布','permission distribution overview'],['查询','read search list'],['读取','read get list'],['写入','write update'],['部署','deploy'],['运行','runtime status']];let text=String(s||'').toLocaleLowerCase();for(const [a,b] of aliases)text=text.split(a).join(' '+b+' ');return text.split(/[\s,，。；;:：/\\|]+/).map(x=>x.trim()).filter(x=>x.length>0);};
const resolveIntent=(all,args)=>{const intent=String(args?.intent||'').trim();const q=(intent+' '+String(args?.domain||'')).toLocaleLowerCase();const words=intentWords(q);const limit=Math.min(20,Math.max(1,Number(args?.limit)||8));const candidates=all.map(t=>{const text=(String(t.name||'')+' '+String(t.description||'')).toLocaleLowerCase();let score=0;for(const w of words){if(text.includes(w))score+=w.length>3?2:1;}if(text.includes(q)&&q)score+=5;return{score,name:t.name,purpose:t.description,read_only:t.annotations?.readOnlyHint??t.readOnly??null,destructive:t.annotations?.destructiveHint??null};}).filter(x=>x.score>0).sort((a,b)=>b.score-a.score||a.name.localeCompare(b.name)).slice(0,limit).map(({score,...x})=>({...x,match_score:score}));return{state:candidates.length?'resolved':'no_match',intent,mode:args?.mode||'read',candidates,next_step:candidates.length?'call hub.help for one candidate,then hub.invoke':'search hub.tools by group or query',catalog_scope:'current_authorized_tool_catalog'};};
const findWorkByShortNo=async(token,req,args)=>{const n=Number(args?.short_no);if(!Number.isSafeInteger(n)||n<1)throw error('invalid_work_short_no',400);const auth=await nextIdentity(token);const projects=[];if(typeof args?.project_id==='string'&&args.project_id)projects.push(args.project_id);else{let cursor;let guard=0;do{const page=await api(cfg.nextV8,'/v2/projects/search',auth.token,{limit:100,...(cursor?{cursor}:{})});for(const p of page.items||[])projects.push(p.project_id||p.id);cursor=page.next_cursor;guard++;if(guard>100)break;}while(cursor);}const maxProjects=Math.min(100,Math.max(1,Number(args?.limit_projects)||projects.length||1));const scanned=[];for(const pid of projects.slice(0,maxProjects)){let cursor;let pages=0;do{const page=await api(cfg.nextV8,'/v2/work-items/search',auth.token,{project_id:pid,query:'W-'+n,limit:100,...(cursor?{cursor}:{})});for(const item of page.items||[]){if(Number(item.short_no)===n)return{state:'found',short_no:n,project_id:pid,work_item:item,coverage:{projects_scanned:scanned.length+1,work_pages_scanned:pages+1,complete:true}};}cursor=page.next_cursor;pages++;if(pages>=20)break;}while(cursor);scanned.push(pid);}return{state:'not_found',short_no:n,coverage:{projects_scanned:scanned.length,project_count:projects.length,complete:scanned.length>=projects.length,work_page_cap:20},next_step:'check_project_scope_or_source_context'};};
const normalizeStructuredRequest=(all,args)=>{const r=(args&&args.request&&typeof args.request==='object')?args.request:args||{};const requested=typeof r.tool==='string'?r.tool:null;if(!requested){return resolveIntent(all,args||{});}const canonical=canonicalToolName(requested);const input=(r.arguments&&typeof r.arguments==='object'&&!Array.isArray(r.arguments))?r.arguments:{};const descriptor=all.find(t=>t.name===canonical);const allowed=descriptor&&descriptor.inputSchema&&descriptor.inputSchema.properties?Object.keys(descriptor.inputSchema.properties):null;const base=compatibilityArgs(canonical,input);const normalized={...base};const unknown=allowed?Object.keys(base).filter(k=>!allowed.includes(k)):[];const changes=[];if(canonical!==requested)changes.push({kind:'tool_alias',from:requested,to:canonical});for(const k of Object.keys(input))if(!(k in normalized))changes.push({kind:'argument_dropped',field:k});if(input.limit!==undefined&&normalized.limit!==input.limit)changes.push({kind:'limit_normalized',from:input.limit,to:normalized.limit??null});if(canonical==='hufu.access.overview'&&!input.view){normalized.view='managed';changes.push({kind:'default_filled',field:'view',value:'managed'});}return{state:unknown.length?'needs_input_review':'normalized',requested_tool:requested,canonical_tool:canonical,arguments:normalized,changes,...(unknown.length?{unrecognized_arguments:unknown,argument_policy:'preserved_for_domain_validation;never_silently_remove_requested_constraints'}:{}),next_step:unknown.length?'read hub.help and check unrecognized arguments before execution':'call hub.invoke with canonical_tool and arguments',catalog_scope:'current_authorized_tool_catalog'};};
const compatibilityArgs=(name,args)=>{const a=compatibleWorkArguments(name,{...(args||{})});if(name==='hub.tools'&&(a.domain||a.intent)){const knownDomain=typeof a.domain==='string'&&catalogue([],{}).groups?.some(g=>g.id===a.domain);if(knownDomain&&!a.group)a.group=a.domain;const q=[a.query,a.intent,...(knownDomain?[]:[a.domain])].filter(x=>typeof x==='string'&&x.trim()).join(' ');if(q)a.query=q;delete a.domain;delete a.intent;}if(name==='hub.work.find'&&typeof a.short_no==='string'&&/^(W-|#)[0-9]+$/i.test(a.short_no))a.short_no=Number(a.short_no.replace(/^(W-|#)/i,''));if(name==='hufu.access.applications'&&a.limit!==undefined&&!['project','database','delivery','service_resource'].includes(a.source_kind))delete a.limit;if(name==='provider.capabilities.enumerate'&&Number.isFinite(Number(a.limit))&&Number(a.limit)>100)a.limit=100;if(name==='hufu.access.overview'&&!a.view)a.view='managed';return a;};
async function fullTools(token,req){
 const isNext=token.startsWith('hub2_'),message={jsonrpc:'2.0',id:'tool-catalog',method:'tools/list',params:{}};
 const old=isNext?[]:(await rpc(cfg.oldMcp,token,message,req))?.result?.tools||[];let enhanced=[];
 try{const auth=await nextCredential(token);enhanced=(await rpc(cfg.nextMcp,auth.token,message,req))?.result?.tools||[];}catch(e){if(isNext)throw e;}
 const all=[...old.filter(t=>![...mutationTools,...stageMetadata756].some(x=>x.name===t.name)),...mutationTools,...stageMetadata756,...(isNext?nativeIdentityAliases:[]),...enhanced,...(isNext?clientLookupTools:[]),...governanceMetadata,materialDetailTool,...materialTools,upgradeContext,...(enhanced.length?[futureApiSchema,fullRead,documentSave,...workflowTools]:[]),...disclosureTools,...serviceTools,...fileNumberTools,...databaseTools,...authorizationTools,...controlTools,...xingxiuTools];
 return[...new Map(all.map(t=>[t.name,t])).values()];
}
async function dispatch(message,token,req){if(message.method==='tools/call'){const caller=compatibilityCaller(token);compatibilityObservation.tool(message.params?.name,caller,req);if(message.params?.name==='hub.invoke')compatibilityObservation.tool(message.params?.arguments?.tool,caller,req);}let catalogPromise;const requestTools=()=>catalogPromise??=fullTools(token,req);const isNext=token.startsWith('hub2_');const name=canonicalToolName(message.params?.name);if(message.method==='tools/call'&&name!==message.params?.name)message={...message,params:{...message.params,name}};
 if(message.method==='tools/list'){
  const full=await requestTools();const expanded=message._fullDisclosure===true||new URL(req.url||'/mcp','http://127.0.0.1').searchParams.get('tools')==='full'||req.headers['x-workspace-tools']==='full'||!isNext;
  return{jsonrpc:'2.0',id:message.id,result:{tools:expanded?full:full.filter(t=>defaultNames.has(t.name))}};
 }
 if(message.method==='tools/call'){
  const disclosureArgs=compatibilityArgs(name,message.params.arguments||{});message={...message,params:{...message.params,arguments:disclosureArgs}};
  if(['hub.help','hub.tools','hub.invoke'].includes(name)&&typeof disclosureArgs.tool==='string')disclosureArgs.tool=canonicalToolName(disclosureArgs.tool);
  if(name==='hub.help'&&controlTools.some(t=>t.name===disclosureArgs.tool)){const item=controlTools.find(t=>t.name===disclosureArgs.tool);return toolResult(message.id,{state:'documented_route',name:item.name,input_schema:item.inputSchema,purpose:item.description,http:controlRoute(item.name),invoke:{tool:'hub.invoke',arguments:{tool:item.name,arguments:{}}}});}
  if(name==='hub.help'&&(typeof disclosureArgs.tool!=='string'||!disclosureArgs.tool.trim()))return toolResult(message.id,{state:'failed',error_code:'invalid_input',missing_fields:['tool'],next_step:'hub.tools',required_arguments:{tool:'registered tool name'}},true);
  if(name==='mem.enumerate'){
   const direct=disclosureArgs.limit,wrapped=disclosureArgs.payload?.limit;
   if(direct!==undefined&&wrapped!==undefined&&direct!==wrapped)return toolResult(message.id,{state:'failed',error_code:'mixed_input_conflict',next_step:'provide_one_consistent_enumeration_page_limit'},true);
   const limit=direct??wrapped??100;
   if(!Number.isSafeInteger(limit)||limit<1||limit>500)return toolResult(message.id,{state:'failed',error_code:'invalid_input',validation_errors:[{path:direct!==undefined?'limit':'payload.limit',requirement:{type:'integer',minimum:1,maximum:500}}],next_step:'use_valid_page_limit;enumeration_freezes_scope_and_page_reads_the_items'},true);
   const args={...disclosureArgs};delete args.limit;if(args.payload&&Object.hasOwn(args.payload,'limit')){args.payload={...args.payload};delete args.payload.limit;}
   const auth=await nextCredential(token),response=await rpc(cfg.nextMcp,auth.token,{...message,params:{name,arguments:args}},req);
   if(response.result?.isError)return response;
   const data=unwrap(response),project=args.project_id??args.payload?.project_id;
   if(typeof data?.snapshot_id==='string'&&typeof project==='string')return toolResult(message.id,{...data,next_step:{tool:'mem.enumerate.page',arguments:{project_id:project,snapshot_id:data.snapshot_id,cursor:data.next_cursor??0,limit}},...(direct!==undefined||wrapped!==undefined?{compatibility:{state:'page_limit_forwarded_to_next_step',field:'limit',effect:'snapshot_scope_unchanged;no_item_bytes_read'}}:{})});
   return response;
  }
  if(name==='provider.capabilities.enumerate'&&!disclosureArgs.project_id&&!disclosureArgs.payload?.project_id)return toolResult(message.id,{state:'needs_project',required:['project_id'],requested_tool:name,effect:'none',next_step:{tool:'v8.project.search',arguments:{limit:10}},message:'先指定需要查询云能力的项目；目录不代表云账号执行授权。'});
  if(name==='hufu.access.overview'&&['mine','pending'].includes(disclosureArgs.view)){const auth=await nextCredential(token);const result=await api(cfg.nextAuth,'/v2/authorization/applications',auth.token,{view:disclosureArgs.view});return toolResult(message.id,{...result,compatibility:{state:'redirected',requested_tool:'hufu.access.overview',requested_view:disclosureArgs.view,canonical_tool:'hufu.access.applications',reason:'overview_mine_pending_are_application_views'}});}
  if(xingxiuTools.some(t=>t.name===name)){const auth=await nextCredential(token);return toolResult(message.id,await api('http://127.0.0.1:8943',xingxiuRoute(name),auth.token,disclosureArgs));}
  if(controlTools.some(t=>t.name===name)){const auth=await nextCredential(token),route=controlRoute(name);return toolResult(message.id,await api(route.system==='v8'?cfg.nextV8:cfg.nextAuth,route.path,auth.token,route.method==='GET'?undefined:disclosureArgs));}
  if(authorizationTools.some(t=>t.name===name)){const auth=await nextCredential(token);return toolResult(message.id,await api(cfg.nextAuth,'/v2/authorization/'+authorizationRoute(name),auth.token,name==='hufu.access.help'?undefined:disclosureArgs));}
  if(databaseTools.some(t=>t.name===name)){const auth=await nextCredential(token);return toolResult(message.id,await api(cfg.nextAuth,'/v2/database-access/'+name.split('.').pop(),auth.token,name==='database.help'?undefined:disclosureArgs));}
  if(name==='hub.services'){const auth=await nextCredential(token);return toolResult(message.id,await serviceRegistry(disclosureArgs,(path,body)=>api(cfg.nextV8,path,auth.token,body),(path,body)=>api(cfg.nextAuth,path,auth.token,body)));}
  if(name==='hub.file.find'){const auth=await nextCredential(token);return toolResult(message.id,await findFileNumber(disclosureArgs,(path,body)=>api(cfg.nextMem,path,auth.token,body)));}
  if(name==='hub.work.find'){return toolResult(message.id,await findWorkByShortNo(token,req,disclosureArgs));}
  if(name==='hub.resolve'){return toolResult(message.id,normalizeStructuredRequest(await requestTools(),disclosureArgs));}
  if(name==='hub.capabilities'){const a=disclosureArgs||{},q=[a.query,a.intent,a.domain].filter(x=>typeof x==='string'&&x.trim()).join(' ');return toolResult(message.id,{...catalogue(await requestTools(),{query:q,limit:a.limit}),compatibility:{requested:'hub.capabilities',canonical:'hub.tools'}});}
  if(name==='hub.tools'){const found=catalogue(await requestTools(),disclosureArgs);return toolResult(message.id,disclosureArgs.tool&&found.state==='not_found'?unknownTool(disclosureArgs.tool):found);}
  if(name==='hub.help'&&disclosureArgs.tool==='hufu.client.lookup'){
   const item=clientLookupTools[0];return toolResult(message.id,{state:'documented_route',name:item.name,purpose:item.description,http:{method:'POST',path:'/v2/client/lookup'},minimum_requirements:['client_id'],input_schema:item.inputSchema,authority:'current_caller_management_capability;no_secret_delivery',invoke:{tool:'hub.invoke',arguments:{tool:item.name,arguments:{}}}});
  }
  if(name==='hub.help'&&(await requestTools()).some(t=>t.name===disclosureArgs.tool)&&![...disclosureTools,...serviceTools,...fileNumberTools].some(t=>t.name===disclosureArgs.tool)){const item=(await requestTools()).find(t=>t.name===disclosureArgs.tool);const a=authorizationTools.some(t=>t.name===item.name);const d=databaseTools.some(t=>t.name===item.name);if(!a&&!d){const auth=await nextIdentity(token);try{const native=unwrap(await call(cfg.nextMcp,auth.token,'hub.help',{tool:item.name},req));if(native?.state==='documented_route')return toolResult(message.id,{...native,contract_source:'native_service_tool_help',invoke:{tool:'hub.invoke',arguments:{tool:item.name,arguments:{}}}});}catch(e){if(!['tool_not_found','unknown_tool'].includes(e.detail?.error_code||e.message))throw e;}}return toolResult(message.id,{state:'documented_route',name:item.name,purpose:item.description,input_schema:item.inputSchema,authority:'same_current_member_and_software;actual_service_rules_apply',invoke:{tool:'hub.invoke',arguments:{tool:item.name,arguments:{}}},...(a?{http:{method:item.name==='hufu.access.help'?'GET':'POST',system:'hufu',path:'/v2/authorization/'+authorizationRoute(item.name)}}:d?{http:{method:item.name==='database.help'?'GET':'POST',system:'hufu',path:'/v2/database-access/'+item.name.split('.').pop()}}:{})});}
  if(name==='hub.help'&&[...disclosureTools,...serviceTools,...fileNumberTools].some(t=>t.name===disclosureArgs.tool))return toolResult(message.id,{state:'help',...catalogue(await requestTools(),{tool:disclosureArgs.tool}),manual:{system:'hufu',method:'POST',path:'/v2/manuals/read',body:{id:'material-classification'}}});
  if(name==='hub.invoke'){
   if(typeof disclosureArgs.tool!=='string'||disclosureArgs.tool==='hub.invoke'||!disclosureArgs.arguments||Array.isArray(disclosureArgs.arguments)||typeof disclosureArgs.arguments!=='object')throw error('invalid_invocation',400);
   const allTools=await requestTools(),requestedTool=disclosureArgs.tool,canonicalTool=canonicalToolName(requestedTool);
   if(allTools.some(t=>t.name===canonicalTool)){return dispatch({...message,params:{name:canonicalTool,arguments:disclosureArgs.arguments}},token,req);}
   const suggestions=catalogue(allTools,{query:String(requestedTool).replace(/[._-]+/g,' '),limit:5});
   return toolResult(message.id,unknownTool(requestedTool,suggestions.items||[]),true);
  }
  if(name==='hub.material.designate'){
   const auth=await nextIdentity(token),loc=await memberMem758(auth,'/v2/materials/locate',{material_id:disclosureArgs.material_id});
   if(disclosureArgs.project_id&&disclosureArgs.project_id!==loc.project_id)throw error('permission_project_mismatch',409);
   const prior=await memberMem758(auth,'/v2/materials/attributes',{project_id:loc.project_id,material_id:disclosureArgs.material_id});
   return toolResult(message.id,await memberMem758(auth,'/v2/materials/importance-designate',{project_id:loc.project_id,material_id:disclosureArgs.material_id,special:disclosureArgs.special,human_instruction:disclosureArgs.human_instruction,reason:disclosureArgs.reason,importance_level:disclosureArgs.importance_level,expected_revision:disclosureArgs.expected_revision??prior.metadata_revision,idempotency_key:disclosureArgs.idempotency_key}));
  }

  req.materialUseKey780=hash(canonical([hash(token),message.id,message.params,new Date().toISOString().slice(0,13)]));
  if(name==='hub.material.detail')return toolResult(message.id,await materialDetail(await nextCredential(token),message.params.arguments||{}));
  if(materialTools.some(t=>t.name===name))return toolResult(message.id,await materialFlows780(name,await nextIdentity(token),message.params.arguments||{},req));
  if(isNext&&name==='hufu_whoami')return toolResult(message.id,await api(cfg.nextAuth,'/v2/me',token));
  if(isNext&&name==='hufu.client.lookup'){const auth=await nextCredential(token);return toolResult(message.id,await api(cfg.nextAuth,'/v2/client/lookup',auth.token,message.params?.arguments||{}));}
  if(isNext&&name==='hufu_context')return toolResult(message.id,await context(token,req));
  if(isNext&&name==='hufu_vault_list')return toolResult(message.id,await api(cfg.nextAuth,'/v2/vault/legacy/vault/list',token));
  if(isNext&&name==='hufu_vault_reveal')return toolResult(message.id,await api(cfg.nextAuth,'/v2/vault/legacy/vault/reveal',token,message.params?.arguments||{}));
  if(governanceMetadata.some(x=>x.name===name)){const a=message.params?.arguments||{},auth=await nextIdentity(token);const body={...a};if(name!=='hub.governance.inbox')body.idempotency_key??='governance:'+hash(canonical([auth.identity.actor_id,message.id,name,a]));return toolResult(message.id,await api(cfg.nextV8,'/v2/governance/'+name.split('.').pop(),auth.token,body));}
  if(name==='hub2_context')return toolResult(message.id,await context(token,req));
  if(name==='hufu_context'&&!isNext){const old=await rpc(cfg.oldMcp,token,message,req);try{const data=withServiceProviderBoundary(currentContextRules(unwrap(old)));data.upgrade=await context(token,req);old.result={content:[{type:'text',text:JSON.stringify(data)}],structuredContent:data};}catch{}return old;}
  if(name==='hufu_vault_list'&&!isNext&&managedKeyList.length)return toolResult(message.id,await upgradedVault.list(token,req));
  if(name==='hufu_vault_reveal'&&!isNext&&await upgradedVault.isManaged(token,message.params?.arguments?.key_id))return toolResult(message.id,await upgradedVault.reveal(token,message.params.arguments,req));
  if(name==='hufu_vault_reveal'&&!isNext){const old=await rpc(cfg.oldMcp,token,message,req);try{const data=unwrap(old);data.usage_hint={manual_available:Boolean(data.manual),blocks_authorized_delivery:false,next_step:data.manual?'follow_current_manual_and_actual_scope':'Agent_may_complete_usage_guidance_from_provider_docs;do_not_expose_secret_or_assume_broader_scope'};old.result={content:[{type:'text',text:JSON.stringify(data)}],structuredContent:data};}catch{}return old;}
  const b=message.params?.arguments||{};const a=b.payload?{...b.payload,...Object.fromEntries(Object.entries(b).filter(([k])=>k!=='payload'))}:b;
  const caller758={token,req,message_id:message.id};
  if(['mengchu_move','mengchu_trash','mengchu_restore'].includes(name)){const r=await mutations757.intercept(name,caller758,a);if(r.handled)return toolResult(message.id,r.result);}
  if(['mengchu_stage_fetch','mengchu_stage_upload'].includes(name)){const r=await stageTools756[name==='mengchu_stage_fetch'?'fetch':'upload'](caller758,a);if(r.handled)return toolResult(message.id,r.result);}
  if(name==='mengchu_upload'){const routed=await uploadApplication({token,req,message_id:message.id},a);if(routed.handled)return toolResult(message.id,routed.result);}
  if(name==='mengchu_get'||name==='mengchu_note'){const r=await currentFiles758[name==='mengchu_get'?'get':'note'](caller758,a);if(r.handled)return toolResult(message.id,r.result);if(r.prefer_live_legacy&&!isNext)return rpc(cfg.oldMcp,token,message,req);}

  if(['mengchu_note','mengchu_get','mengchu_search'].includes(name)){const routed=await mappedPersonalTools.intercept(name,{token,req,message_id:message.id},a);if(routed.handled){if(name==='mengchu_search')routed.result={...routed.result,files:routed.result.items,count:routed.result.items?.length};return toolResult(message.id,routed.result);}}
  if(['mengchu_note','mengchu_get','mengchu_search'].includes(name)){const body={...a};if(typeof body.file_id==='string'&&body.file_id.startsWith('https://hufu.example.invalid/files/'))body.file_id=new URL(body.file_id).pathname.split('/').pop();const method={mengchu_note:'note',mengchu_get:'get',mengchu_search:'search'}[name];const routed=await personalTools[method]({token,req,message_id:message.id},body);if(routed.handled){if(name==='mengchu_search'){const rows=routed.result.items||[];routed.result={...routed.result,count:rows.length,...(a.scope==='knowledge'?{knowledge:rows}:{files:rows})};}return toolResult(message.id,routed.result);}}
  if(['mengchu_note','mengchu_get','mengchu_search'].includes(name)){const routed=await sharedTools.intercept(name,{token,req,message_id:message.id},a);if(routed.handled){if(name==='mengchu_search'){const fresh=await nativeSharedTools.search({token,req,message_id:message.id},a);const rows=[...(fresh.result?.items||[]),...(routed.result.items||[])];const seen=new Set();const merged=rows.filter(x=>{const id=x.file_id||x.id;if(seen.has(id))return false;seen.add(id);return true;}).slice(0,a.limit||50);routed.result={...routed.result,items:merged,count:merged.length,...(a.scope==='knowledge'?{knowledge:merged}:{files:merged})};}return toolResult(message.id,routed.result);}}
  if(['mengchu_note','mengchu_get'].includes(name)){const method={mengchu_note:'note',mengchu_get:'get'}[name];const routed=await nativeSharedTools[method]({token,req,message_id:message.id},a);if(routed.handled)return toolResult(message.id,routed.result);}
  if(name==='mengchu_get'){const personal=await readRegisteredPrivate({token,req},a);if(personal.handled)return toolResult(message.id,personal.result);const routed=await readMigratedLegacy({token,req},a);if(routed.handled)return toolResult(message.id,routed.result);}
  if(name==='hub_api'&&a.system==='hufu'&&typeof a.path==='string'&&a.path.startsWith('/hufu/')&&managedKeyList.length){const routed=await upgradedVault.route(token,a.method,a.path,a.body,req);if(routed.handled)return toolResult(message.id,{status:200,body:routed.result,backend:'2.0_legacy_contract'});}
  if(name==='hub_api'&&a.system==='hufu'&&a.method==='GET'&&a.path==='/v2/context')return toolResult(message.id,{status:200,body:await context(token,req),backend:'2.0'});
  if(name==='hub_api'&&a.system==='meng'&&a.method==='POST'&&a.path==='/v2/documents/save'){const auth=await nextIdentity(token);return toolResult(message.id,{status:200,body:await saveByName(auth,a.body||{},req),backend:'2.0'});}
  if(name==='hub_api'&&a.system==='meng'&&a.method==='POST'&&a.path==='/v2/files/read-full'){const auth=await nextIdentity(token);return toolResult(message.id,{status:200,body:await readFull(auth,a.body||{},req),backend:'2.0'});}
  if(name==='mem.read_full'){const auth=await nextIdentity(token);return toolResult(message.id,await readFull(auth,a,req));}
  if(name==='hub.document.save'){const auth=await nextIdentity(token);return toolResult(message.id,await saveByName(auth,a,req));}
  const flowRoute=name==='hub_api'&&a.method==='POST'?({'/v2/projects/open':'hub.project.open','/v2/materials/find':'hub.materials.find','/v2/documents/open':'hub.document.open','/v2/work/resume':'hub.work.resume','/v2/materials/govern':'hub.material.govern'}[a.path]):name;
  // Already registered old IDs and native IDs use current member Mem authorization.
  // Unknown old files retain the original legacy path; never guess latest bytes.
  if(flowRoute==='hub.document.open'){
   const args=name==='hub_api'?(a.body||{}):a;
   if(args.file_id||args.address){
    const located=await currentFiles758.locate(caller758,{file_id:args.file_id||args.address,...(args.ver!==undefined?{ver:args.ver}:{})});
    if(located.handled){
     if(located.history_pending){const pending=await currentFiles758.get(caller758,{file_id:args.file_id||args.address,ver:args.ver});return toolResult(message.id,name==='hub_api'?{status:200,body:pending.result,backend:'working_flow'}:pending.result);}
     const fixed=located.location.fixed_ref;
     if(located.legacy_ver!==undefined&&args.version_id&&args.version_id!==fixed.version_id)throw error('conflicting_version_selection',409);
     const version_id=args.version_id||fixed.version_id;
     const nativeArgs={...args,file_id:undefined,address:undefined,project_id:located.location.project_id,material_id:located.location.material_id,version_id,...(!args.version_id?{sha256:args.sha256||fixed.sha256}:{})};
     const opened=await flows.openDocument(located.auth,nativeArgs,req,false);
     const data={...opened,file_id:located.file_id,old_writer_fenced:await currentFiles758.isManaged(located.file_id),source_version:{project_id:located.location.project_id,material_id:located.location.material_id,version_id,...(located.legacy_ver!==undefined?{legacy_ver:located.legacy_ver}:{})}};
     return toolResult(message.id,name==='hub_api'?{status:200,body:data,backend:'working_flow'}:data);
    }
   }
  }
  if(workflowTools.some(x=>x.name===flowRoute)){const args=name==='hub_api'?(a.body||{}):a;const legacyOnly=flowRoute==='hub.document.open'&&(args.file_id||args.address)||flowRoute==='hub.materials.find'&&args.scope==='legacy'||flowRoute==='hub.work.resume'&&args.task_id;const auth=legacyOnly?null:await (flowRoute==='hub.material.govern'?nextIdentity(token):nextCredential(token));let data;
   if(flowRoute==='hub.project.open')data={state:'project_available',project:await flows.resolveProject(auth,args,req)};
   if(flowRoute==='hub.materials.find')data=await flows.find(auth,args,req,!isNext);
   if(flowRoute==='hub.document.open')data=await flows.openDocument(auth,args,req,!isNext);
   if(flowRoute==='hub.work.resume'){
    let resumeArgs=args;
    if(args.work_no!==undefined&&!args.task_id&&!args.project_id&&!args.project_name&&!args.project){
     const found=await findWorkByShortNo(token,req,{short_no:args.work_no});
     if(found.state!=='found')return toolResult(message.id,name==='hub_api'?{status:200,body:found,backend:'working_flow'}:found);
     if(args.work_item_id&&args.work_item_id!==found.work_item.work_item_id)return toolResult(message.id,{state:'failed',error_code:'work_reference_mismatch',next_step:'use_consistent_work_no_and_work_item_id'},true);
     resumeArgs={...args,project_id:found.project_id,work_item_id:found.work_item.work_item_id};
    }
    data=await flows.resume(auth,resumeArgs,req,!isNext);
   }
   if(flowRoute==='hub.material.govern')data=await flows.govern(auth,args,req);
   return toolResult(message.id,name==='hub_api'?{status:200,body:data,backend:'working_flow'}:data);
  }
  if(name==='hub2_api'||name==='hub_api'&&typeof a.path==='string'&&a.path.startsWith('/v2/')){
   if(!['hufu','meng','v8'].includes(a.system)||!['GET','POST'].includes(a.method)||!/^\/v2\/[A-Za-z0-9_/-]+$/.test(a.path)||a.path.includes('..'))throw error('public_2_API_required');
   const auth=await nextCredential(token),url={hufu:cfg.nextAuth,meng:cfg.nextMem,v8:cfg.nextV8}[a.system],transport=publicApiTransport(a.path,a.method==='POST'?(a.body||{}):undefined);return toolResult(message.id,{status:200,body:await api(url,a.path,auth.token,transport.body,transport.idempotencyKey),backend:'2.0'});
  }
  if(name?.startsWith('hufu.project.privacy.')){const op=name.split('.').pop();if(!['apply','requests','decide','revoke'].includes(op))throw error('tool_not_found',404);const body={...(a.payload||{}),...a};delete body.payload;delete body.source_context;if(op!=='requests'&&!body.idempotency_key)body.idempotency_key=randomUUID();const auth=await nextIdentity(token);return toolResult(message.id,await api(cfg.nextAuth,'/v2/projects/privacy/'+op,auth.token,body));}
  if(name?.includes('.')&&!name.startsWith('hufu_')){const auth=await nextCredential(token);return rpc(cfg.nextMcp,auth.token,message,req);}
  if(isNext)throw error('legacy_tool_needs_original_member_credential',403);
  return rpc(cfg.oldMcp,token,message,req);
 }
 return rpc(isNext?cfg.nextMcp:cfg.oldMcp,token,message,req);
}
const server=http.createServer(async(req,res)=>{let message;try{
 const pathname=new URL(req.url,'http://127.0.0.1').pathname;
 // Protocol adapters share one application instance and its original recovery journal.
 if(pathname.startsWith('/v2/usecases/')){
  try{
   if(req.method!=='POST')return write(res,405,{state:'failed',error_code:'POST_required'});
   const token=req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];if(!token||token.length>4096)throw error('unauthenticated',401);
   const args=await input(req);
   const usecase={
    '/v2/usecases/materials/detail':(auth)=>materialDetail(auth,args),
    ...Object.fromEntries(['list','counts','rows'].map(operation=>['/v2/usecases/materials/'+operation,(auth)=>materialList(auth,operation,args)])),
    ...Object.fromEntries(['govern','attributes','description','index','storage','restore','restore-status','semantic'].map(operation=>['/v2/usecases/materials/'+operation,(auth)=>materialMaintenance(auth,operation,args,req)])),
    '/v2/usecases/documents/upload':async(auth)=>{const r=await uploadApplication({token:auth.token,req},args,{requireKey:true});if(!r.handled)throw error('upload_route_unavailable',409);return r.result;},
    '/v2/usecases/documents/save':(auth)=>saveByName(auth,args,req),
    '/v2/usecases/documents/read':(auth)=>readFull(auth,args,req),
    '/v2/usecases/work/resume':(auth)=>flows.resume(auth,args,req,false)
   }[pathname];
   if(!usecase)return write(res,404,{state:'failed',error_code:'usecase_not_found'});
   const result=await entryAuthentication.run(token,async()=>usecase(await nextIdentity(token)));
   return write(res,200,result);
  }catch(e){return write(res,e.status||502,{state:'failed',error_code:e.message,retryable:e.retryable??((e.status||500)>=500),...(e.detail?{detail:e.detail}:{})});}
 }
 if(pathname==='/ready'){return write(res,200,{state:'ready',version:'2.0-mcp-pilot.2',old_tools_preserved:true,caller_identity_only:true,phase:'gradual_upgrade'});}
 if(/^\/files\/(m2_[a-f0-9-]{36}|m2p_[a-f0-9-]{36}_[a-f0-9-]{36})$/.test(pathname)&&req.method==='GET'){
  const token=req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];if(!token)throw error('member_authorization_required',401);
  const auth=await nextIdentity(token);const id=pathname.split('/').pop(),loc=parsePersonalLocator(id)||{project_id:'d5027a95-f21b-483d-a9f1-06a91db45551',material_id:id.slice(3)};
  const data=await readFull(auth,{...loc,encoding:'base64'},req);
  const bytes=Buffer.from(data.bytes_base64,'base64');res.writeHead(200,{'content-type':'application/octet-stream','content-length':bytes.length,'cache-control':'no-store','x-content-type-options':'nosniff'});return res.end(bytes);
 }
 if(await legacyHttpRead751(req,res))return;
 if(pathname.startsWith('/hufu/')){const token=req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];if(!token)throw error('unauthenticated',401);await verifiedLegacy(token);compatibilityObservation.observe('http:legacy_auth','legacy_credential',req);const body=req.method==='POST'?await input(req):undefined;const routed=await upgradedVault.route(token,req.method,req.url,body,req);if(routed.handled)return write(res,200,routed.result);const own=await verifiedLegacy(token);return write(res,200,await api(cfg.oldAuth,req.url,own.access,body));}
 if(!['/mcp','/mcp-beta'].includes(pathname))return write(res,404,{error:'not_found'});
 const token=req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];if(!token||token.length>4096)throw error('unauthenticated',401);
 if(req.method!=='POST')return write(res,405,{error:'POST_required',stateless:true});
 message=await input(req);if(Array.isArray(message)||message.jsonrpc!=='2.0'||typeof message.method!=='string')throw error('invalid_JSON_RPC');
 // Every request authenticates; nested use cases reuse only this entry identity.
 const result=await entryAuthentication.run(token,()=>dispatch(message,token,req));if(message.id===undefined){res.writeHead(202);return res.end();}return write(res,200,message.method==='tools/call'?normalizeToolResponse(result,['hub.help','hub.tools','hub.invoke'].includes(canonicalToolName(message.params?.name))?(compatibilityArgs(canonicalToolName(message.params?.name),message.params?.arguments||{}).tool||message.params?.name):message.params?.name):result);
 }catch(e){if(message?.method==='tools/call'&&message.id!==undefined)return write(res,200,toolResult(message.id,{state:'failed',error_code:e.message,retryable:(e.status||500)>=500,...(e.detail?{detail:e.detail}:{})},true));return write(res,e.status||502,{jsonrpc:'2.0',id:message?.id??null,error:{code:-32000,message:e.message}});}
});
server.listen(cfg.port,'127.0.0.1',()=>{console.log('MCP upgrade gateway listening on loopback '+cfg.port);compatibilityObservation.started();});
setInterval(()=>{for(const[k,v]of cache)if(v.expires<=Date.now())cache.delete(k);},60000).unref();
process.on('SIGTERM',()=>{cache.clear();server.close(()=>process.exit(0));});

