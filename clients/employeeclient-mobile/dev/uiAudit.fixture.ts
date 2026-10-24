// Isolated UI transport. Never imports real credentials or writes production data.
import { reactive } from 'vue';
export const scenario = reactive({ name:'normal', role:'member', writes:[] as any[] });
const now=Date.now();
export const project={id:'p-personal',name:'员工客户端体验改进',direction:'界面、语音与工作协作的持续改进',scope:'personal',owner_username:'audit-user',status:'active',version:1,updated_at:now,created_at:now};
export const task={id:'t-company',project_id:'p-company',title:'完善语音消息和工作反馈体验',scope_at_creation:'company',creator_username:'audit-user',assignee_username:'audit-user',entry_type:'direct_code',main_state:'incomplete',current_node:'awaiting_code_review',current_action_owner:'control',updated_at:now,created_at:now,version:1,latest_worklog_id:1801};
export const issue={id:'i-company',project_id:'p-company',scope:'company',title:'语音上传后需要清晰的确认反馈',detail:'网络恢复后重试时，应保留原录音和关联事项，避免重新录制。',status:'open',severity:'mid',submitter_username:'audit-user',intake_kind:'problem',version:1,created_at:now,latest_worklog_id:1802};
const personalTask={...task,id:'t-personal',project_id:project.id,scope_at_creation:'personal',title:'整理个人项目资料',entry_type:'personal',current_node:'awaiting_code',current_action_owner:'owner',latest_worklog_id:null};
const personalIssue={...issue,id:'i-personal',project_id:project.id,scope:'personal',intake_kind:'plan_idea',title:'项目资料按工作阶段整理',latest_worklog_id:null};
const announcement={id:'a1',title:'本周交付与验收安排',body:'请核对本周交付资料，语音相关反馈可以在工作群继续讨论。',publisher_username:'audit-user',priority:'normal',created_at:now,expires_at:null,recipient_count:2,read_count:1,unread_count:1,audience:[{username:'colleague',name:'同事',read_at:now},{username:'other',name:'另一位同事',read_at:null}]};
const notification={id:'n1',title:'语音交互代码等待审核',summary:'录音试听与失败重试已提交，请查看代码版本和验证说明。',kind:'code_submitted',object_type:'task',object_id:task.id,scope:'company',priority:'normal',created_at:now,worklog_id:1801,snooze_until:now+3600000};
export class ApiError extends Error { constructor(public code:string,public hint:string,public status:number){super(hint)} }
export const session=reactive<any>({user:{username:'audit-user',nickname:'界面验收',role:'employee'},displayName:'界面验收',status:'online',isAuthenticated:true,isMainControl:false,installationId:'audit-installation',mode:'device',pushBound:false,pushReason:'测试环境未绑定推送',link:{state:'live',networkUp:true,lastTickAt:now,lastDetail:''},lastError:'',reconnect:async()=>{},syncPushBinding:async()=>false,login:async()=>false});
const tasks=()=>[{...task},{...personalTask},{...task,id:'t-completed',title:'完成共享文件下载验证',main_state:'completed',current_node:'done',completed_at:now}];
const projects=()=>[{...project},{...project,id:'p-archived',name:'上一阶段资料',status:'archived'}];
const long='这是一条用于核验长内容换行与布局层级的记录'.repeat(5)+'ContinuousUnbrokenIdentifier'.repeat(5);
const empty=()=>['empty','loading','error','restricted'].includes(scenario.name);
export async function read<T>(value:T):Promise<T>{
  if(scenario.name==='loading')return new Promise(()=>{});
  if(['error','stale'].includes(scenario.name))throw new ApiError('upstream_unavailable','模拟连接失败',503);
  if(scenario.name==='restricted')throw new ApiError('forbidden','当前账号无权限',403);
  return value;
}
export function taskContext(id:string){const t=id==='t-personal'?personalTask:task;return {task:{...t,title:scenario.name==='long'?long:t.title},project:t.scope_at_creation==='personal'?project:{id:'p-company',name:'客户端协作'},allowed_actions:['urge_review'],source_plan:{plan_id:'plan1',plan_title:'语音与协作设计',plan_current_version:1,plan_status:'approved',versions:[{version_no:1,summary:'完成权限、录音、上传、消息确认和重试闭环。',address:'https://example.test/plan',created_at:now}]},code_versions:[{id:'cv1',version_no:1,status:'pending_review',address:'https://example.test/source.zip',integrity:'a'.repeat(64),submitter_username:'audit-user',created_at:now}],code_version_actions:{cv1:['approve','request_changes','reject']},issue_relations:[],reviews:[{id:'r1',object_type:'plan',version_no:1,decision:'approve',reason:'按已确认范围推进',reviewer:'control',created_at:now}],latest_review:null,revision_required:null,recent_activities:[]};}
function issueDetail(id:string){const i=id==='i-personal'?personalIssue:issue;return {issue:{...i,title:scenario.name==='long'?long:i.title,detail:scenario.name==='long'?long:i.detail},supplements:[],relations:[],linked_tasks:[],allowed_actions:['supplement','handling_event','archive'],handling_events:[],recent_activities:[],submitter:{username:'audit-user',nickname:'界面验收',dept:'测试'}};}
export const data=reactive<any>({account:'audit-user',scopeRevision:0,personalBlocked:false,personalCleanupError:'',syncing:false,syncError:'',lastSyncedAt:now,tasks:tasks(),companyIssues:[issue],personalProjects:projects(),notifications:[notification],announcements:[announcement],floatingNotices:[],get inboxNotifications(){return this.notifications},get unreadCount(){return this.notifications.length},projectName:(id:string)=>id==='p-company'?'客户端协作':project.name,captureLease:()=>({account:'audit-user',valid:()=>session.user?.username==='audit-user'}),captureAccountLease:()=>({account:'audit-user',valid:()=>session.user?.username==='audit-user'}),syncAll:async()=>read({}),syncLists:async()=>read({}),clearDisplayCache:async()=>{},loadTaskContext:async(id:string)=>read(taskContext(id)),loadCompanyIssue:async(id:string)=>id==='i-personal'?Promise.reject(new ApiError('not_found','个人问题',404)):read(issueDetail(id)),loadMeIssue:async(id:string)=>read(issueDetail(id))});
const messages=()=>[{id:'m1',seq:1,body:'语音发送后可以先试听，再确认发出。',author_username:'colleague',author_name:'同事',mention_usernames:[],attachments:[],created_at:now-10000},{id:'m2',seq:2,body:'收到，我会连同弱网重试一起检查。',author_username:'audit-user',author_name:'界面验收',mention_usernames:[],attachments:[],created_at:now}];
export const chat=reactive<any>({account:'audit-user',initialized:true,loading:false,restoring:false,sending:false,messages:messages(),members:[{username:'audit-user',nickname:'界面验收',online:true},{username:'colleague',nickname:'同事',online:true}],membersReady:true,memberCount:2,canLoadOlder:false,pending:null,error:'',mutating:false,mutationPending:null,cursor:2,refreshMembers:async()=>{},refresh:async()=>{},older:async()=>{},send:async()=>true,changeMessage:async()=>true});
export const useDataStore=()=>data, useSessionStore=()=>session, useChatStore=()=>chat;
export function reset(name='normal',role='member'){
 data.scopeRevision++;
 scenario.name=name;scenario.role=role;scenario.writes=[];session.isMainControl=role==='control';session.status=name==='offline'?'offline':'online';session.isAuthenticated=true;session.lastError='';session.user={username:'audit-user',nickname:'界面验收',role};
 data.syncing=name==='loading';data.syncError=['error','stale'].includes(name)?'模拟读取失败':'';data.personalBlocked=name==='restricted';data.tasks=empty()?[]:tasks();data.personalProjects=empty()?[]:projects();data.companyIssues=empty()?[]:[{...issue}];data.notifications=empty()?[]:[{...notification}];data.announcements=empty()?[]:[{...announcement}];
 if(name==='long'){for(const list of [data.tasks,data.companyIssues,data.announcements,data.notifications])for(const row of list)row.title=long;for(const p of data.personalProjects){p.name=long;p.direction=long;}}
 chat.messages=empty()?[]:messages();chat.loading=name==='loading';chat.error=name==='error'?'群消息加载失败':'';
}
const write=async(body:any,key?:string)=>{scenario.writes.push({body,key});await read({});return {status:'applied',object_id:'i-personal',object_type:'issue',object_version:1,receipt_id:'receipt1'}};
export const me={
 personalIssues:async(_p?:string,_kind?:string,archived?:boolean)=>read({issues:empty()?[]:[{...personalIssue,...(archived?{archived_at:now}:{})}],next_cursor:null}),
 taskContext:async(id:string)=>read(taskContext(id)),taskHistory:async(_id:string,kind:string)=>read({kind,items:[],next_cursor:null}),
 createIssue:write,supplementIssue:async(_id:string,b:any,k:string)=>write(b,k),handlingEvent:async(_id:string,b:any,k:string)=>write(b,k),reviewUrge:async(_id:string,b:any,k:string)=>write(b,k),createPersonalProject:write,updatePersonalProject:async(_id:string,b:any,k:string)=>write(b,k),archivePersonalIssue:async(_id:string,b:any,k:string)=>write(b,k),
 devices:async()=>read({devices:[]}),personalStorageContext:async()=>read({project_id:project.id,space:'personal',path:'audit-user/个人项目记录',directory:'personal/audit-user/个人项目记录',status:'synced',pending:0,failed:0,synced:1,files:[]}),personalStorageDiscovery:async()=>read({state:'synced',projects:[{project_id:project.id,state:'synced'}],files:[]}),discoverPersonalStorage:async()=>read({state:'synced',projects:[{project_id:project.id,state:'synced'}],files:[]}),
};
export const company={issues:async()=>read({issues:empty()?[]:[{...issue,title:scenario.name==='long'?long:issue.title}],next_cursor:null})};
export const control={tasks:async()=>read({tasks:empty()?[]:tasks().filter(t=>t.scope_at_creation==='company')}),taskContext:me.taskContext,taskHistory:me.taskHistory,planDetail:async()=>read({plan:{version:1},allowed_actions:['approve','request_changes','reject']}),decidePlan:async(_id:string,b:any,k:string)=>write(b,k),decideCode:async(_id:string,b:any,k:string)=>write(b,k)};
export const communication={
 members:async()=>read({members:chat.members}),messages:async()=>read({messages:chat.messages,next_cursor:2,has_more:false,has_more_old:false}),contextOptions:async()=>read({projects:[{id:'p-company',name:'客户端协作'}],tasks:[task],next_cursor:null}),files:async()=>read({files:[],next_cursor:null}),deliveries:async()=>read({files:[],next_cursor:null}),workRecords:async()=>read({records:[],next_cursor:null}),replies:async()=>read({replies:[],next_cursor:0,has_more:false}),reply:async(_id:string,b:any,k:string)=>write(b,k),publishAnnouncement:write,saveWorkRecord:write
};
export const apiConfig={getToken:()=> 'isolated-ui-fixture'},isOnline=()=>session.status==='online',newIdempotencyKey=()=>crypto.randomUUID();
export const apiRequest=async()=>read({});
export const withRetry=async<T>(fn:()=>Promise<T>)=>fn();
