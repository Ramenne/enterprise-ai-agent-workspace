import {createHash,createHmac,randomUUID} from 'node:crypto';
import {central} from './hufu-auth.mjs';
import {isAdmin} from './access-control.mjs';
import {createCloudLibrary} from './html-cloud.mjs';
import {createModuleAdapters,EXTRA_OPERATIONS,HARDWARE_DRAFT} from './agent-modules.mjs';
const failure=(status,message)=>Object.assign(Error(message),{status});
const schema=(properties={},required=[])=>({type:'object',properties,required,additionalProperties:false});
const str={type:'string'},num={type:'integer',minimum:1};
const BASE_OPERATIONS=[
 {name:'identity',description:'读取当前真实调用成员与可用操作。',inputSchema:schema()},
 {name:'projects_list',description:'列出当前成员可保存或读取的资料存储服务项目。',inputSchema:schema()},
 {name:'knowledge_list',description:'查询统一知识目录，可按标题、摘要、标签和来源检索。目录状态不是方法验证证明。',inputSchema:schema({query:str,category:str,status:str,includeArchived:{type:'boolean'}})},
 {name:'knowledge_read',description:'按当前成员权限读取知识正文和固定历史版本。',inputSchema:schema({id:str,version:num},['id'])},
 {name:'knowledge_save',description:'所有中枢成员均可新增知识文档，须填写sourceName来源说明或sourceUrl来源链接；原创可注明本人原创。系统记录真实上传者。本人或管理员可修订，更新提供id和revision；保存到资料存储服务并核对读回。',write:true,inputSchema:schema(Object.fromEntries(['id','projectId','projectName','title','body','category','summary','tags','status','sourceName','sourceUrl','scope','limitations','evidence','reportHref','reportTitle','skillId','skillTitle'].map(k=>[k,str]).concat([['revision',num]])),['projectId','title','body'])},
 {name:'html_list',description:'查询HTML管理库当前统一目录。',inputSchema:schema({query:str})},
 {name:'html_read',description:'按当前成员权限读取已入库HTML汇报原件。',inputSchema:schema({projectId:str,id:str},['projectId','id'])},
 {name:'html_save',description:'把完整HTML汇报保存到资料存储服务并纳入统一HTML管理库。已有不同内容不会被覆盖。',write:true,admin:true,inputSchema:schema({projectId:str,projectTitle:str,filename:str,path:str,title:str,content:str,kind:{type:'string',enum:['资料','作品','其他']},note:str},['projectId','filename','path','title','content'])},
 {name:'skill_list',description:'查询Skill目录，可搜索名称、用途、标签。',inputSchema:schema({query:str,includeArchived:{type:'boolean'}})},
 {name:'skill_read',description:'读取Skill说明、文件清单和历史版本。配套脚本不会执行。',inputSchema:schema({id:str,version:num},['id'])},
 {name:'skill_file_read',description:'读取指定Skill包内的单个文本文件。',inputSchema:schema({id:str,version:num,path:str},['id','path'])},
 {name:'skill_import',description:'导入一个完整Skill包，支持SKILL.md或ZIP的Base64原文件。只存储，不执行。',write:true,inputSchema:schema(Object.fromEntries(['filename','packageBase64','title','category','tags','note','versionLabel'].map(k=>[k,str])),['filename','packageBase64'])},
 {name:'skill_version_save',description:'为本人上传的Skill或管理员维护的Skill保存独立新版本。',write:true,inputSchema:schema(Object.fromEntries(['id','filename','packageBase64','versionLabel'].map(k=>[k,str]).concat([['revision',num]])),['id','revision','filename','packageBase64'])}
];
export const OPERATIONS=[...BASE_OPERATIONS,...EXTRA_OPERATIONS];
function validate(def,args){
 const inspect=(rule,value,label)=>{
  if(rule.type==='object'){if(!value||typeof value!=='object'||Array.isArray(value))throw failure(400,label+'须为对象');for(const k of Object.keys(value)){if(!rule.properties[k])throw failure(400,'参数不支持：'+k);inspect(rule.properties[k],value[k],k)}for(const k of rule.required||[])if(value[k]===undefined)throw failure(400,'缺少参数：'+k)}
  else if(rule.type==='array'){if(!Array.isArray(value)||(rule.minItems!==undefined&&value.length<rule.minItems)||(rule.maxItems!==undefined&&value.length>rule.maxItems))throw failure(400,label+'数组格式无效');for(const item of value)inspect(rule.items,item,label)}
  else if(rule.type==='integer'){if(!Number.isSafeInteger(value)||(rule.minimum!==undefined&&value<rule.minimum)||(rule.maximum!==undefined&&value>rule.maximum))throw failure(400,label+'须为有效整数')}
  else if(typeof value!==rule.type)throw failure(400,'参数格式无效：'+label);
  if(typeof value==='string'&&((rule.minLength!==undefined&&value.length<rule.minLength)||(rule.maxLength!==undefined&&value.length>rule.maxLength)))throw failure(400,label+'长度无效');if(rule.enum&&!rule.enum.includes(value))throw failure(400,'参数值无效：'+label);
 };inspect(def.inputSchema,args,'arguments');
}
const canonical=v=>JSON.stringify(v,(_,value)=>value&&typeof value==='object'&&!Array.isArray(value)?Object.fromEntries(Object.keys(value).sort().map(k=>[k,value[k]])):value);
export async function authenticateAgent(req,{verify=central}={}){
 const header=req.headers.authorization;if(typeof header!=='string'||!/^Bearer [^\s]+$/.test(header)||header.length>4096)throw failure(401,'请提供本人身份权限服务Bearer凭据');
 const token=header.slice(7),r=await verify('/v2/me',{token});if(!r.ok)throw failure([401,403].includes(r.status)?r.status:503,'成员身份暂时无法核验');const me=r.data;
 if(me?.principal_kind!=='member'||typeof me.actor_id!=='string')throw failure(403,'此入口使用真实成员身份，服务身份不得冒充成员');
 return {owner:me.actor_id,name:me.member_label||me.display_name||'成员',token};
}
export function createAgentApi(db,{knowledge,skills,html,rpc,vault,access,collector,members,extensions=[],verify=central}={}){
 const cloud=createCloudLibrary({cache:html.directoryCache,...(rpc?{rpc}:{})}),locks=new Set();
 db.exec('CREATE TABLE IF NOT EXISTS tools_api_operations(actor TEXT NOT NULL,operation_key TEXT NOT NULL,request_hash TEXT NOT NULL,operation TEXT NOT NULL,state TEXT NOT NULL,result TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(actor,operation_key))');
 const adapters=createModuleAdapters(db,{vault,access,collector,members,knowledge,skills,cloud});
 const moduleFor=name=>name.startsWith('skill_')?'skills':name.startsWith('knowledge_')?'knowledge':name.startsWith('html_')?'html':'core';
 const definitions=[...BASE_OPERATIONS.map(d=>({...d,module:moduleFor(d.name)})),...adapters.operations];
 const moduleNames={media:'视频图片下载',accounts:'账号管理',html:'HTML管理库',skills:'Skill管理库',knowledge:'知识文档管理库'};
 const extensionHandlers=new Map(),moduleVersions={};
 for(const extension of extensions){if(!extension||!/^[-a-z0-9]+$/.test(extension.id)||extension.id==='core'||Object.hasOwn(moduleNames,extension.id)||typeof extension.run!=='function'||!Array.isArray(extension.operations)||extension.ready!==true||!extension.version)throw Error('Invalid released tool adapter');for(const definition of extension.operations){if(!definition.name?.startsWith(extension.id+'_')||definitions.some(d=>d.name===definition.name)||!definition.inputSchema)throw Error('Invalid module operation');definitions.push({...definition,module:extension.id});extensionHandlers.set(definition.name,extension.run)}moduleNames[extension.id]=extension.title||extension.id;moduleVersions[extension.id]=extension.version;adapters.available[extension.id]=true;}
 const permitted=member=>definitions.filter(x=>!x.admin||isAdmin(member.owner)).map(x=>({...x,agentAvailable:x.agentAvailable!==false,method:'POST',endpoint:'/agent/v1/call'}));
 const moduleCatalog=member=>({service:'协作平台工具合集',version:'1.1',modules:[...Object.entries(moduleNames).map(([id,title])=>({id,title,...(moduleVersions[id]?{version:moduleVersions[id]}:{}),state:adapters.available[id]?'available':'integration_pending',callable:!!adapters.available[id],operations:permitted(member).filter(x=>x.module===id).map(x=>x.name)})), ...(!adapters.available.hardware?[{id:'hardware',...HARDWARE_DRAFT,operations:[]}]:[])],coverage:adapters.available.hardware?'六个工具已发布功能的真实接口；不代表未建设功能已完成':'当前五个已建工具的真实接口；第六个硬件模块在建，契约预留，未声明上线'});
 const catalog=member=>({...moduleCatalog(member),identity:{actorId:member.owner,name:member.name},operations:permitted(member)});
 async function call(member,name,args={},operationKey){
  if(typeof name==='string'&&name.startsWith('hardware_')&&!adapters.available.hardware)throw failure(503,'硬件管理平台仍在建设，此操作尚未接入');
  const def=definitions.find(x=>x.name===name);if(!def)throw failure(404,'操作不存在');validate(def,args);if(def.admin&&!isAdmin(member.owner))throw failure(403,'仅管理员可以维护该管理库');
  const payload=canonical({name,args}),legacyHash=createHash('sha256').update(payload).digest('hex'),master=Buffer.from(process.env.XIANYU_KEY||'','base64'),requestHash=master.length===32?'hmac:'+createHmac('sha256',master).update(payload).digest('hex'):legacyHash,lockKey=member.owner+'\0'+operationKey;let existing;
  if(def.write){if(typeof operationKey!=='string'||operationKey.length<8||operationKey.length>160||!/^[-a-zA-Z0-9_.:]+$/.test(operationKey))throw failure(400,'写入须提供稳定的Idempotency-Key（8至160字符）');existing=db.prepare('SELECT * FROM tools_api_operations WHERE actor=? AND operation_key=?').get(member.owner,operationKey);if(existing&&existing.request_hash!==requestHash&&existing.request_hash!==legacyHash)throw failure(409,'同一保存标识已用于其他内容');if(existing?.state==='completed')return {...JSON.parse(existing.result),replayed:true};if(locks.has(lockKey))throw failure(409,'原请求正在处理，请稍后使用原标识核对');locks.add(lockKey);if(!existing){const at=new Date().toISOString();db.prepare('INSERT INTO tools_api_operations VALUES(?,?,?,?,?,NULL,?,?)').run(member.owner,operationKey,requestHash,name,'pending',at,at)}}
  try{
   // Deterministic library IDs preserve the original write across transport retries.
   const seed=createHash('sha256').update(member.owner+'\0'+operationKey).digest('hex');const bytes=Buffer.from(seed.slice(0,32),'hex');bytes[6]=(bytes[6]&15)|0x40;bytes[8]=(bytes[8]&63)|0x80;const h=bytes.toString('hex'),operationId=`${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
   let result;
   const q=(args.query||'').toLocaleLowerCase();
   switch(name){
    case 'identity':result=catalog(member);break;
    case 'tools_modules':result=moduleCatalog(member);break;
    case 'projects_list':result=await cloud.projects(member);break;
    case 'knowledge_list':{const data=knowledge.list(member);result={items:data.items.filter(x=>(args.includeArchived||!x.archivedAt)&&(!args.category||x.category===args.category)&&(!args.status||x.status===args.status)&&(!q||[x.title,x.summary,x.tags,x.sourceName,x.scope].join(' ').toLocaleLowerCase().includes(q)))};break}
    case 'knowledge_read':result=await knowledge.detail(member,args.id,args.version);break;
    case 'knowledge_save':result=await knowledge.save(member,{...args,operationId});break;
    case 'html_list':{const data=await cloud.directory(member);result={...data,items:data.items.filter(x=>!q||[x.title,x.note,x.project,x.filename].join(' ').toLocaleLowerCase().includes(q))};break}
    case 'html_read':{const file=await cloud.file(member,args.projectId,args.id);result={filename:file.filename,content:file.bytes.toString('utf8'),sha256:file.sha256};break}
    case 'html_save':result=await cloud.upload(member,{kind:'资料',note:'',...args,uploadId:operationId});break;
    case 'skill_list':result={items:skills.list(member.owner).filter(x=>(args.includeArchived||!x.archivedAt)&&(!q||[x.title,x.name,x.description,x.tags].join(' ').toLocaleLowerCase().includes(q)))};break;
    case 'skill_read':result=skills.detail(member.owner,args.id,args.version);break;
    case 'skill_file_read':result=skills.file(args.id,args.version,args.path);break;
    case 'skill_import':result={state:'published',item:skills.create(member,args,item=>saveSkillReceipt(item))};break;
    case 'skill_version_save':result={state:'published',item:skills.update(member,{...args,action:'version'},item=>saveSkillReceipt(item))};break;
    default:result=extensionHandlers.has(name)?await extensionHandlers.get(name)(member,name,JSON.parse(canonical(args)),value=>saveReceipt(value),operationId):await adapters.run(member,name,args,value=>saveReceipt(value),operationId);break;
   }
   if(def.write&&!def.atomic&&!['skill_import','skill_version_save'].includes(name)){const done=(def.completedWhen||['published']).includes(result.state);db.prepare('UPDATE tools_api_operations SET state=?,result=?,updated_at=? WHERE actor=? AND operation_key=?').run(done?'completed':'pending',JSON.stringify(result),new Date().toISOString(),member.owner,operationKey)}
   return result;
   function saveReceipt(result){db.prepare('UPDATE tools_api_operations SET state=?,result=?,updated_at=? WHERE actor=? AND operation_key=?').run('completed',JSON.stringify(result),new Date().toISOString(),member.owner,operationKey)}
   function saveSkillReceipt(item){saveReceipt({state:'published',item})}
  }catch(e){throw e}finally{if(def.write)locks.delete(lockKey)}
 }
 return {catalog,modules:moduleCatalog,call,operation(member,key){const row=db.prepare('SELECT operation,state,result,updated_at AS updatedAt FROM tools_api_operations WHERE actor=? AND operation_key=?').get(member.owner,key);if(!row)throw failure(404,'当前成员未登记此请求');return {...row,result:row.result?JSON.parse(row.result):null}},authenticate:req=>authenticateAgent(req,{verify})};
}
async function readBody(req){let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;if(size>43*1024*1024)throw failure(413,'请求内容过大');chunks.push(chunk)}try{const b=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(!b||typeof b!=='object'||Array.isArray(b))throw Error();return b}catch{throw failure(400,'请求须为JSON对象')}}
export function agentApiHandler(api){return async(req,res,url)=>{const reply=(status,result)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(result))};try{
 if(req.headers.origin&&req.headers.origin!=='https://tools.example.invalid/')throw failure(403,'跨站请求未获允许');
 const member=await api.authenticate(req);
 if(url.pathname==='/agent/v1/modules'&&req.method==='GET')return reply(200,api.modules(member));
 if(url.pathname==='/agent/v1/modules/hardware'&&req.method==='GET')return reply(200,api.modules(member).modules.find(m=>m.id==='hardware'));
 if(url.pathname==='/agent/v1/capabilities'&&req.method==='GET')return reply(200,api.catalog(member));
 if(url.pathname.startsWith('/agent/v1/operations/')&&req.method==='GET')return reply(200,{ok:true,result:api.operation(member,decodeURIComponent(url.pathname.slice('/agent/v1/operations/'.length)))});
 if(url.pathname==='/agent/v1/call'&&req.method==='POST'){if(!(req.headers['content-type']||'').startsWith('application/json'))throw failure(415,'请使用application/json');const b=await readBody(req);if(Object.keys(b).some(k=>!['operation','arguments'].includes(k)))throw failure(400,'请求字段不支持');return reply(200,{ok:true,result:await api.call(member,b.operation,b.arguments||{},req.headers['idempotency-key'])})}
 throw failure(404,'接口不存在');
 }catch(e){return reply(e.status||503,{ok:false,error:{message:e.status?e.message:'TOOLS操作暂时未完成',status:e.status||503},requestId:randomUUID()})}}}
