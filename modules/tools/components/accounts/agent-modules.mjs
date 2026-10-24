import {central} from './hufu-auth.mjs';
import {isAdmin} from './access-control.mjs';
const fail=(status,message)=>Object.assign(Error(message),{status});
const str={type:'string'},int={type:'integer',minimum:1},revision0={type:'integer',minimum:0},bool={type:'boolean'},strings={type:'array',items:str,maxItems:10000};
const schema=(properties={},required=[])=>({type:'object',properties,required,additionalProperties:false});
const op=(module,name,description,properties={},required=[],extra={})=>({module,name,description,inputSchema:schema(properties,required),...extra});
const confirmed={type:'boolean',enum:[true]};
const local={write:true,atomic:true};
const adminLocal={...local,admin:true};
const sensitive={agentAvailable:false,sensitive:true};
export const EXTRA_OPERATIONS=[
 op('core','tools_modules','读取整个工具合集的六个模块、接入状态及当前成员操作范围。硬件在建不代表已上线。'),
 op('accounts','account_list','查询团队账号目录，遵守原账号管理的可见性；不返回密码。',{query:str,includeDeleted:bool,includeArchived:bool}),
 op('accounts','account_read','读取一条账号的非密码信息；受保护备注需单独按权限读取。',{id:str},['id']),
 op('accounts','account_notes_read','按当前成员权限读取账号备注。',{id:str,revision:int},['id'],sensitive),
 op('accounts','account_history','按现有权限查看账号操作历史；敏感字段沿用原工具过滤。',{id:str,before:int},['id'],sensitive),
 op('accounts','account_password_read','按现有密码查看权限、当前版本读取密码；仅直接API，任务助手不接收该操作。',{id:str,revision:int},['id','revision'],sensitive),
 op('accounts','account_save','新建账号或管理员修订账号，密码在原凭据库加密保存。仅直接API，避免密码进入模型会话。',Object.fromEntries(['id','label','username','password','note','device','platform','projectId'].map(k=>[k,str]).concat([['revision',int],['noteRevision',int]])),['label','username','password'],{...local,...sensitive}),
 op('accounts','account_metadata_save','管理员修改现有账号非密码字段，不读取或改写密码。修改备注需当前noteRevision。',Object.fromEntries(['id','label','username','note','device','platform','projectId'].map(k=>[k,str]).concat([['revision',int],['noteRevision',int]])),['id','revision','label','username'],adminLocal),
 op('accounts','account_state_save','管理员归档、恢复或移入/恢复回收站；需明确确认，保留账号记录。',{id:str,revision:int,action:{type:'string',enum:['archive','restore','delete','undelete']},confirmed},['id','revision','action','confirmed'],adminLocal),
 op('accounts','account_groups_list','读取账号分组目录。'),
 op('accounts','account_group_save','管理员新建账号分组。',{name:str},['name'],adminLocal),
 op('accounts','account_group_delete','管理员确认删除账号分组；账号移到未分组，分组授权随原规则移除。',{id:str,confirmed},['id','confirmed'],{...adminLocal,agentAvailable:false}),
 op('accounts','account_members','管理员读取当前工具成员及账号访问权限。',{},[],{admin:true,...sensitive}),
 op('accounts','account_access_read','管理员查看单个账号的查看授权。',{id:str},['id'],{admin:true,...sensitive}),
 op('accounts','account_access_save','管理员按当前中枢成员目录修改单个账号查看授权。',{id:str,revision:revision0,actorIds:strings,confirmed},['id','revision','actorIds','confirmed'],{...adminLocal,...sensitive}),
 op('accounts','account_member_access_read','管理员读取某成员的分组、单独账号授权及禁止查看状态。',{actorId:str},['actorId'],{admin:true,...sensitive}),
 op('accounts','account_member_access_save','管理员修改某成员账号权限，严格沿用原工具规则。',{actorId:str,revision:revision0,disabled:bool,groupIds:strings,accountIds:strings,confirmed},['actorId','revision','disabled','groupIds','accountIds','confirmed'],{...adminLocal,...sensitive}),
 op('accounts','account_member_visibility_save','管理员修改账号密码查看禁止状态；需明确确认。',{actorId:str,revision:revision0,disabled:bool,confirmed},['actorId','revision','disabled','confirmed'],{...adminLocal,...sensitive}),
 op('media','media_capabilities','读取视频图片下载服务实际状态、解析与客户端落盘边界。'),
 op('media','media_parse','只解析用户明确提供的作品或公网媒体链接，创建异步任务。accepted不代表下载或落盘。',{text:{type:'string',minLength:1,maxLength:12000},knownUrls:{type:'array',items:str,maxItems:500}},['text'],{write:true,completedWhen:['accepted']}),
 op('media','media_job_status','读取本人API创建的解析任务，返回素材编号与来源URL；不声明已下载。',{id:str},['id']),
 op('media','media_download_manifest','为用户明确选中的素材生成调用端下载清单；没有服务器本机落盘副作用。',{jobId:str,mediaIds:{type:'array',items:str,minItems:1,maxItems:100}},['jobId','mediaIds']),
 op('knowledge','knowledge_state_save','管理员确认归档或恢复知识文档，保留固定历史版本。',{id:str,revision:int,action:{type:'string',enum:['archive','restore']},confirmed},['id','revision','action','confirmed'],adminLocal),
 op('knowledge','knowledge_recover','当前成员读取本人未完成保存的原请求，用原参数与固定标识恢复。',{operationId:str},['operationId']),
 op('skills','skill_metadata_save','上传者或管理员修改Skill显示信息。',{id:str,revision:int,title:str,category:str,tags:str,note:str},['id','revision'],local),
 op('skills','skill_state_save','上传者或管理员确认归档或恢复Skill，保留历史包。',{id:str,revision:int,action:{type:'string',enum:['archive','restore']},confirmed},['id','revision','action','confirmed'],local),
 op('skills','skill_package_read','下载指定历史版本的完整Skill包Base64及SHA-256；不执行包内脚本。',{id:str,version:int},['id'],{agentAvailable:false}),
 op('html','html_sync_start','管理员同步资料存储服务统一HTML目录；只创建或复用扫描任务，accepted不代表同步结束。',{force:bool},[],{write:true,admin:true,completedWhen:['accepted']}),
 op('html','html_sync_status','管理员核对HTML目录同步任务进度与实际结果。',{id:str},['id'],{admin:true})
];
export const HARDWARE_DRAFT={module:'hardware',title:'硬件管理平台',implementationName:'硬件采购平台',state:'under_construction',callable:false,namespace:'hardware_',plannedOperations:['hardware_options','hardware_projects','hardware_list','hardware_read','hardware_save','hardware_state_save','hardware_file_read'],dataModel:'每笔订单包含多件商品；成员购买人、选填使用人/项目、金额、图片/PDF凭证；登记人由当前身份确定。',permissions:'当前建设方案：全部成员读记录，登记人和管理员修改/归档。',activation:'由硬件平台真实发布版本提供适配器并通过权限、重试、附件校验测试后注册；当前不公布虚构可用端点。'};
export function createModuleAdapters(db,{vault,access,knowledge,skills,cloud,collector,members=async member=>{
 const r=await central('/v2/projects/members',{token:member.token,body:{project_id:'69197d56-41b0-4c8b-ac19-181f63e87c1f',limit:100,offset:0}});if(!r.ok||!Array.isArray(r.data?.members))throw fail(503,'当前中枢成员目录暂不可用');let items=r.data.members,offset=r.data.next_offset;const seen=new Set();while(offset!==undefined&&offset!==null){if(seen.has(offset))throw fail(503,'成员目录分页未完成');seen.add(offset);const page=await central('/v2/projects/members',{token:member.token,body:{project_id:'69197d56-41b0-4c8b-ac19-181f63e87c1f',limit:100,offset}});if(!page.ok||!Array.isArray(page.data?.members))throw fail(503,'成员目录分页未完成');items=items.concat(page.data.members);offset=page.data.next_offset}return items;
}}={}){
 const available={core:true,accounts:!!vault&&!!access,media:!!collector,knowledge:!!knowledge,skills:!!skills,html:!!cloud};
 const allowed=EXTRA_OPERATIONS.filter(o=>available[o.module]);
 async function run(member,name,args,finish,operationId){
  const doneItem=item=>finish({state:'published',item});const doneValue=value=>finish({state:'published',...value});
  switch(name){
   case 'account_list':{const q=(args.query||'').toLocaleLowerCase();return {items:vault.list(member.owner).filter(x=>(args.includeDeleted||!x.deleted)&&(args.includeArchived||!x.archived)&&(!q||[x.label,x.username,x.platform,x.device].join(' ').toLocaleLowerCase().includes(q)))}}
   case 'account_read':{const item=vault.list(member.owner).find(x=>x.id===args.id);if(!item)throw fail(404,'账号不存在或不可读');return {item}}
   case 'account_notes_read':return vault.notes(member.owner,args.id,args.revision);
   case 'account_history':return vault.history(member.owner,args.id,args.before);
   case 'account_password_read':return vault.reveal(member.owner,args);
   case 'account_save':return {state:'published',item:vault.save(member.owner,args,doneItem)};
   case 'account_metadata_save':return {state:'published',item:vault.save(member.owner,{...args,password:''},doneItem)};
   case 'account_state_save':{const {confirmed,...body}=args;return {state:'published',item:vault.save(member.owner,body,doneItem)}}
   case 'account_groups_list':return {items:vault.projects(member.owner)};
   case 'account_group_save':return {state:'published',item:vault.createProject(member.owner,args,doneItem)};
   case 'account_group_delete':return {state:'published',...vault.deleteProject(member.owner,args.id,doneValue)};
   case 'account_members':return {members:(await members(member)).map(m=>({actorId:m.actor_id,name:m.member_label||m.display_name||'成员',isAdmin:isAdmin(m.actor_id),...access.visibility(m.actor_id)}))};
   case 'account_access_read':return access.snapshot(member.owner,args.id);
   case 'account_access_save':return {state:'published',...access.set(member.owner,args,await members(member),doneValue)};
   case 'account_member_access_read':return access.personSnapshot(member.owner,args.actorId,await members(member));
   case 'account_member_access_save':return {state:'published',...access.setPerson(member.owner,args,await members(member),doneValue)};
   case 'account_member_visibility_save':return {state:'published',...access.setVisibility(member.owner,args,await members(member),doneValue)};
   case 'media_capabilities':return collector.capabilities();
   case 'media_parse':return collector.start(member,args,operationId);
   case 'media_job_status':return collector.status(member,args.id);
   case 'media_download_manifest':return collector.manifest(member,args);
   case 'knowledge_state_save':return {state:'published',...knowledge.archive(member,args,doneValue)};
   case 'knowledge_recover':return knowledge.recover(member,args.operationId);
   case 'skill_metadata_save':return {state:'published',item:skills.update(member,{...args,action:'edit'},doneItem)};
   case 'skill_state_save':return {state:'published',item:skills.update(member,args,doneItem)};
   case 'skill_package_read':{const f=skills.download(args.id,args.version),{bytes,filesJson,...meta}=f;return {...meta,packageBase64:bytes.toString('base64')}}
   case 'html_sync_start':return {state:'accepted',job:cloud.start(member,args)};
   case 'html_sync_status':return cloud.status(member,args.id);
   default:throw fail(404,'工具操作不存在');
  }
 }
 return {available,operations:allowed,run};
}
