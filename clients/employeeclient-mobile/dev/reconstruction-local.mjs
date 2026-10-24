// Local-only UI scenarios. No production credentials, network, email or model calls.
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {createGateway} from '../server/gateway.mjs';
import {createRuntimeHandler} from '../server/business/runtime.mjs';
import {createChatRepository} from '../server/business/chat-repository.mjs';
import {PROJECT} from '../server/business/native-authority.mjs';
export const actors=['sim-a','sim-b','sim-m','sim-u'];
const names={'sim-a':'模拟成员 A','sim-b':'模拟成员 B','sim-m':'模拟主管 M','sim-u':'模拟无资格 U'};
const unrelatedTeam='98c680c9-0ae7-4533-a221-2b248592565f';
const publicPersonal='9b3d9828-4676-4d42-a5e9-49837ea94197';
const privateA='cfe3f0af-af84-4c63-a0d6-2d0677caaddd',privateB='8662ae87-2e86-405e-aa76-c2b6e807b0b1';
const workId='29c081d9-ff48-41c9-adbf-31b0b19c36b4',referenceId='e42b7954-4934-4a5e-a23e-dcbc1ffd7b1f';
const materialId='4bbf924c-a36c-4a86-ac04-7effd6c51110',versionId='b2d1d4d7-e22d-43b7-a647-27b7f4f3cb88';
const bytes=Buffer.from('员工客户端本地重构验证文件，非生产资料。'),hash=createHash('sha256').update(bytes).digest('hex');
const oldVersion='351e2891-2e2c-47f9-a309-3bbf4420161f',oldBytes=Buffer.from('这是已固定的历史版本正文，与最新版不同。'),oldHash=createHash('sha256').update(oldBytes).digest('hex');
const fixed={material_id:materialId,version_id:versionId,sha256:hash,size:bytes.length,display_no:'F-LOCAL-001'};
const file={...fixed,project_id:PROJECT,logical_path:'模拟文件/员工客户端本地验证.txt',properties:{attributes:{material_kind:'系统使用说明',purpose:'测试'},description:'此字段留给详情，不列属性下拉'},importance_level:2};
function fail(code,status=403){throw Object.assign(Error(code),{code,status});}
function actorFrom(cookie){const a=/simulation_member=(sim-[abmu])/.exec(cookie||'')?.[1];if(!a)fail('login_required',401);return a;}
function context(a){return {actor_id:a,project_id:PROJECT,display_name:names[a],can_read:a!=='sim-u',can_write:a!=='sim-u',can_publish_announcement:a==='sim-m'};}
function projectAllowed(a,p){return a!=='sim-u'&&(p===PROJECT||p===unrelatedTeam||p===publicPersonal||p===privateA&&a==='sim-a'||p===privateB&&a==='sim-b');}
export function createLocalScenario({stressAttributes=false,providerRpc,voiceProviderLoader}={}){
 const db=new DatabaseSync(':memory:'),repository=createChatRepository(db);
 const directory=actors.filter(a=>a!=='sim-u').map(a=>({actor_id:a,display_name:names[a],can_read:true,online:a!=='sim-b'}));
 const metadata=[file,...Array.from({length:125},(_,i)=>({...file,material_id:'77777777-7777-4777-8777-'+String(i+1).padStart(12,'0'),display_no:'F-LOCAL-'+String(i+2).padStart(3,'0'),logical_path:'模拟文件/属性目录样例'+(i+1)+'.txt',properties:{attributes:{material_kind:'系统使用说明',purpose:i===124?'分页末尾':'测试',...(stressAttributes?Object.fromEntries(Array.from({length:18},(_,k)=>['测试属性'+(k+1),'值'+(k+1)])):{})}}}))];
 const longFile={...file,material_id:'e30ad941-e805-49e5-a3a4-a2a1e8b25811',display_no:'F-LONG-LOCAL-001',logical_path:'模拟文件/这是一个很长的工作协作文件名称-员工客户端-technical-contract-and-reference-2026-10-10-最终整理版.txt'};metadata.push(longFile);
 const work={id:workId,work_item_id:workId,short_no:1000172,project_id:PROJECT,goal:'员工客户端查询、工作、消息重构',state:'in_progress',created_at:'2026-10-09T08:00:00Z',updated_at:'2026-10-10T07:00:00Z',description:'手机列表与详情重构，恢复编号和引用。',properties:{attributes:{record_kind:'实施报告',work_no:1000172}}};
 const referred={...work,id:referenceId,work_item_id:referenceId,short_no:1000133,goal:'员工客户端已有基础链路'};
 const sourceBytes=new Map(metadata.map(f=>[f.material_id,bytes]));
 const localVoices=[4,45].map((seconds,i)=>{
  const count=seconds*8000,wav=Buffer.alloc(44+count*2);wav.write('RIFF');wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(8000,24);wav.writeUInt32LE(16000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(count*2,40);
  for(let n=0;n<count;n++)wav.writeInt16LE(Math.round(Math.sin(n/8000*2*Math.PI*440)*2000),44+n*2);
  const material_id='99999999-9999-4999-8999-'+String(i+1).padStart(12,'0'),name='本地语音-'+seconds+'秒.wav';
  const item={...file,material_id,display_no:'F-VOICE-LOCAL-'+(i+1),logical_path:'模拟音频/'+name,size:wav.length,sha256:createHash('sha256').update(wav).digest('hex'),properties:{attributes:{purpose:'voice'}}};
  metadata.push(item);sourceBytes.set(material_id,wav);return {...item,id:material_id+':'+versionId,name,mime:'audio/wav',purpose:'voice',duration_ms:seconds*1000,ver:1,owner_username:'sim-b',fixed_ref:{...item,version_id:versionId}};
 });
 const statementId='212c531c-6e9b-4667-a7c9-a901fba2924f',statementBytes=Buffer.from(JSON.stringify({summary:'整理查询与消息入口，保留直接引用。',explanation:{reason:'沿用已固定的客户端与资料接口；界面调整继续同一工作。',completion_claim:'本地候选'},outputs:[{material_id:materialId,version_id:oldVersion,sha256:oldHash,role:'result'}]})),statementHash=createHash('sha256').update(statementBytes).digest('hex');
 const counts={};
 const rpc=async(a,name,args)=>{counts[name]=(counts[name]||0)+1;
  if(name==='v8.project.search')return {items:a==='sim-u'?[]:[{project_id:PROJECT,title:'员工客户端',visibility:'team',state:'active'},{project_id:unrelatedTeam,title:'不参与的公开团队',visibility:'team',state:'active'},{project_id:publicPersonal,title:'B 的公开个人项目',visibility:'personal',owner_id:'sim-b'},...[{project_id:privateA,title:'A 的个人项目',visibility:'personal',owner_id:'sim-a',properties:{attributes:{purpose:'个人资料'}}},{project_id:privateB,title:'B 的个人项目',visibility:'personal',owner_id:'sim-b'}].filter(p=>p.owner_id===a)]};
  if(!projectAllowed(a,args.project_id))fail('forbidden');
  if(providerRpc){const supplied=await providerRpc(a,name,args);if(supplied!==undefined)return supplied;}
  if(name==='hufu.access.permissions')return {state:'read',actor_id:a,project_id:args.project_id,qualifications:args.project_id===PROJECT?[{project_id:PROJECT,principal_id:a,effective_now:true,actions:['v8.work.read']}]:[]};
  if(name==='v8.project.read')return {project:{id:args.project_id,title:'员工客户端',visibility:'team'}};
  if(name==='hub.changes.snapshot')return {cursor:'local-work-cursor',coverage:'project_material_and_work_revisions',aggregates:[work,referred].map(w=>({domain:'v8',aggregate_id:w.id,aggregate_revision:w.revision||1}))};
  if(name==='hub.changes')return {state:'current',cursor:'local-work-cursor',events:[]};
  if(name==='v8.work.catalog')return {state:'read',items:[work,referred].filter(w=>args.project_id===PROJECT&&(!args.work_item_ids||args.work_item_ids.includes(w.id))).map(w=>args.revisions_only?{work_item_id:w.id,revision:w.revision||1}:w),next_cursor:null,coverage:{complete:true}};
  if(name==='v8.work.search'){const q=(args.query||'').replace(/^#/,'');return {items:[work,referred].filter(w=>args.project_id===PROJECT&&(!q||w.goal.includes(q)||String(w.short_no).includes(q))),coverage:{complete:true}};}
  if(name==='v8.work.read'){const w=[work,referred].find(w=>w.id===args.work_item_id);if(!w)fail('not_found',404);return {work_item:w,current_summary:{text:w.description},relations:w.id===workId?[{from_work_id:workId,to_work_id:referenceId,id:'local-relation',state:'active',basis:{explanation:'直接沿用已实现的登录与固定附件读取',refs:[{fixed_ref:{material_id:materialId,version_id:oldVersion,sha256:oldHash}}]}}]:[{id:'local-relation',state:'active',from_work_id:workId,to_work_id:referenceId,basis:{explanation:'直接沿用已实现的登录与固定附件读取'}}],fixed_refs:[{material_id:materialId,version_id:oldVersion,sha256:oldHash,title:'员工客户端本地验证.txt',role:'code'}],coverage:{complete:false,returned:'bounded_navigation'}};}
  if(name==='v8.work.history.page')return {items:[{statement_id:statementId,work_revision:2,kind:'work_update',size:statementBytes.length,sha256:statementHash}],next_cursor:null};
  if(name==='v8.statement.read_chunk'){if(args.statement_id!==statementId)fail('not_found',404);const start=args.offset||0,end=Math.min(statementBytes.length,start+(args.limit||32768)),part=statementBytes.subarray(start,end);return {statement_id:statementId,size:statementBytes.length,sha256:statementHash,bytes_base64:part.toString('base64'),chunk_sha256:createHash('sha256').update(part).digest('hex'),range:{start,end_exclusive:end},next_offset:end===statementBytes.length?null:end};}
  if(name==='mem.enumerate')return {snapshot_id:a+':'+args.project_id,total_count:args.project_id===PROJECT?metadata.length:0,next_cursor:0};
  if(name==='mem.enumerate.page'){if(args.snapshot_id!==a+':'+args.project_id)fail('forbidden');const list=args.project_id===PROJECT?metadata:[],start=args.cursor??0,end=Math.min(list.length,start+(args.limit||100));return {items:list.slice(start,end),next_cursor:end<list.length?end:null};}
  if(name==='mem.search')return {items:args.project_id===PROJECT?metadata.filter(f=>!args.query||JSON.stringify(f).includes(args.query)).slice(0,args.limit||100):[]};
  if(name==='mem.material.head'){const item=metadata.find(f=>f.material_id===args.material_id);if(!item)fail('not_found',404);return {material_id:item.material_id,properties:item.properties,placements:[{logical_path:item.logical_path}],fixed_ref:{...fixed,material_id:item.material_id,display_no:item.display_no,size:item.size,sha256:item.sha256}};}
  if(name==='mem.material.history'){const item=metadata.find(f=>f.material_id===args.material_id);if(!item)fail('not_found',404);const current={...item,version_id:versionId,local_version_no:'2',is_current:true};if(args.material_id===materialId)return args.cursor?{items:[{...current,version_id:oldVersion,size:oldBytes.length,sha256:oldHash,local_version_no:'1',display_no:'F-LOCAL-000',is_current:false}],next_cursor:null}:{items:[current],next_cursor:'597da7e4-a656-495f-a351-12ece914537d'};return {items:[current],next_cursor:null};}
  if(name==='mem.version.read'){const historical=args.material_id===materialId&&args.version_id===oldVersion,data=historical?oldBytes:sourceBytes.get(args.material_id),item=historical?{...file,size:oldBytes.length,sha256:oldHash}:metadata.find(f=>f.material_id===args.material_id);if(!data||!historical&&args.version_id!==versionId)fail('not_found',404);const start=args.offset||0,end=Math.min(data.length,start+(args.limit||131072)),chunk=data.subarray(start,end);return {fixed_ref:{...fixed,version_id:args.version_id,material_id:item.material_id,size:item.size,sha256:item.sha256},bytes_base64:chunk.toString('base64'),chunk_sha256:createHash('sha256').update(chunk).digest('hex'),range:{start,end_exclusive:end},next_offset:end===data.length?null:end};}
  if(name==='mem.read.acknowledge')return {state:'acknowledged'};
  fail('simulation_contract_not_supported',404);
 };
 repository.send(context('sim-a'),{body:'群消息与日期查询的本地示例',mention_usernames:['sim-b']},'local-chat-1',{members:directory});
 repository.send(context('sim-b'),{body:'测试群文件：员工客户端本地验证.txt'},'local-chat-2',{members:directory,attachments:[{fixed_ref:{...fixed,project_id:PROJECT},id:materialId+':'+versionId,name:'员工客户端本地验证.txt',mime:'text/plain',size:bytes.length,sha256:hash,ver:1,owner_username:'sim-b',material_id:materialId,version_id:versionId}]});
 for(const [i,voice] of localVoices.entries())repository.send(context('sim-b'),{body:''},'local-voice-'+i,{members:directory,attachments:[voice]});
 repository.send(context('sim-a'),{body:'收到'},'local-short-text',{members:directory});
 repository.send(context('sim-b'),{body:'这条消息引用了工作，点击编号查看。',project_id:PROJECT,work_item_id:workId},'local-work-ref',{members:directory,reference:{project_id:PROJECT,project_title:'员工客户端',work_item_id:workId,work_title:work.goal,short_no:work.short_no,visibility:'team'}});
 repository.send(context('sim-b'),{body:'这是一段用于检查消息字号、行距和气泡宽度的本地示例。长中文应自然换行；English text and a-long-filename-without-spaces-2026-document.pdf 也不应撑出手机屏幕。'},'local-long-text',{members:directory});
 repository.send(context('sim-b'),{body:'长文件名示例'},'local-long-file',{members:directory,attachments:[{...longFile,fixed_ref:{...fixed,project_id:PROJECT,material_id:longFile.material_id},id:longFile.material_id+':'+versionId,name:longFile.logical_path.split('/').at(-1),mime:'text/plain',size:bytes.length,sha256:hash,ver:1,owner_username:'sim-b'}]});
 const photoId='212c531c-6e9b-4667-a7c9-a901fba2924f',photoBytes=Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360" viewBox="0 0 480 360"><rect width="480" height="360" fill="#a6d7ec"/><circle cx="360" cy="80" r="35" fill="#ffe29b"/><path d="M0 280L150 90L310 290L390 180L480 300V360H0Z" fill="#6a9c84"/><path d="M0 315L175 230L310 315L480 260V360H0Z" fill="#3d7563"/></svg>'),photoHash=createHash('sha256').update(photoBytes).digest('hex');
 const photo={...file,material_id:photoId,size:photoBytes.length,sha256:photoHash,logical_path:'模拟文件/本地图片预览.svg'};metadata.push(photo);sourceBytes.set(photoId,photoBytes);
 repository.send(context('sim-a'),{body:''},'local-photo',{members:directory,attachments:[{...photo,fixed_ref:{...fixed,project_id:PROJECT,material_id:photoId,sha256:photoHash,size:photoBytes.length},id:photoId+':'+versionId,name:'本地图片预览.svg',mime:'image/svg+xml',purpose:'file',ver:1,owner_username:'sim-a'}]});
 const receipt=repository.publishAnnouncement(context('sim-m'),{title:'员工客户端本地重构公告',body:'这是可直接读取的模拟公告正文。只有指定受众可读取，前台看到通知后自动消除未读标记。',recipient_usernames:['sim-a'],priority:'normal'},'local-announcement',directory);
 repository.profiles.seen('sim-b');db.prepare('UPDATE employeeclient_member_presence SET last_seen_at=? WHERE actor_id=?').run(Date.now()-7*60000,'sim-b');
 const sessionFactory=async cookie=>{const a=actorFrom(cookie);return {context:context(a),rpc:(name,args)=>rpc(a,name,args),directory:async()=>directory,fileStream:async fixed=>{const data=sourceBytes.get(fixed.material_id);if(!data||data.length!==fixed.size||createHash('sha256').update(data).digest('hex')!==fixed.sha256)throw Error('local file source mismatch');return new Response(data);}};};
 const runtime=createRuntimeHandler(db,{sessionFactory,voiceProviderLoader});
 const businessHandler=async(req,res)=>{const path=new URL(req.url,'http://local.invalid').pathname.replace(/announcements\/[^/]+/,'announcements/:id');const counter='HTTP '+req.method+' '+path;counts[counter]=(counts[counter]||0)+1;if(req.url==='/business/v1/migration'){res.writeHead(200,{'content-type':'application/json'});res.end('{"state":"local_simulation_no_migration"}');return;}return runtime(req,res);};
 const json=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});
 const fetcher=async(url,options={})=>{
  try{const a=options.headers?.authorization?.replace('Bearer local-simulation:','')||actorFrom(options.headers?.cookie),path=new URL(url).pathname,args=options.body?JSON.parse(options.body):{};
   if(path.endsWith('/get-session'))return json({session:{token:'local-simulation:'+a,expiresAt:new Date(Date.now()+3600000).toISOString()}});
   if(path.endsWith('/api/me'))return json({identity:{actor_id:a,member_label:names[a]},user:{name:names[a],email:a+'@local.invalid'},cache_partition:{actor_id:a}});
   if(path.endsWith('/files/read')){if(!projectAllowed(a,args.project_id))fail('forbidden');const historical=args.material_id===materialId&&args.version_id===oldVersion,data=historical?oldBytes:args.version_id===versionId?sourceBytes.get(args.material_id):null;if(!data)fail('not_found',404);return new Response(data,{headers:{'content-type':'application/octet-stream','x-hub-read-receipt':'local-simulation-only'}});}
   const routes={'/materials/workspace-query':'mem.workspace.query','/authorization/permissions':'hufu.access.permissions','/projects/search':'v8.project.search','/work-items/catalog':'v8.work.catalog','/changes/snapshot':'hub.changes.snapshot','/changes':'hub.changes','/work-items/search':'v8.work.search','/work-items/read':'v8.work.read','/work-items/history/page':'v8.work.history.page','/materials/search':'mem.search','/material-enumerations':'mem.enumerate','/material-enumerations/page':'mem.enumerate.page','/materials/history':'mem.material.history','/work-statements/read-chunk':'v8.statement.read_chunk','/statements/read-chunk':'v8.statement.read_chunk','/materials/head':'mem.material.head','/files/read-chunk':'mem.version.read','/read-receipts':'mem.read.acknowledge'};
   const name=Object.entries(routes).find(([suffix])=>path.endsWith(suffix))?.[1];if(!name)fail('simulation_path_not_supported',404);return json(await rpc(a,name,args));
  }catch(e){return json({error_code:e.code||'local_simulation_failed'},e.status||500);}
 };
 return {db,repository,receipt,businessHandler,fetcher,counts,registerSourceFile(item,data){metadata.push(item);sourceBytes.set(item.material_id,Buffer.from(data));},close(){runtime.close();db.close();}};
}
export function startLocal(port=5184){
 const scenario=createLocalScenario(),origin='http://127.0.0.1:'+port,gateway=createGateway({root:resolve('dist'),publicOrigin:origin,fetcher:scenario.fetcher,businessHandler:scenario.businessHandler});
 const handler=gateway.listeners('request')[0];gateway.removeAllListeners('request');gateway.on('request',(req,res)=>{
  if(req.url?.startsWith('/simulation/phone')){
   const page=new URL(req.url,origin).searchParams.get('page');const route=['messages','work','chat','notifications','announcements','profile','group-files'].includes(page)?page:'personal';
   res.writeHead(200,{'content-type':'text/html;charset=utf-8','cache-control':'no-store'});
   res.end(`<!doctype html><meta charset="utf-8"><title>员工客户端成员聊天候选预览</title><style>html,body{margin:0;background:#eceff2}body{width:390px}iframe{display:block;border:0;width:390px;height:844px}.testbar{padding:8px;font:12px sans-serif}.testbar button{min-height:36px}</style><iframe title="员工客户端390像素手机预览" src="/#/${route}"></iframe><div class="testbar"><button id="pull">模拟下拉刷新</button><button id="pinch">模拟双指缩放与拖动</button><button id="shrink">模拟双指缩小与拖动</button><button id="hold-image">模拟图片长按</button><output id="result"></output></div><script>
   const emitPointer=(type,id,x,y)=>{const w=document.querySelector('iframe').contentWindow,stage=w.document.querySelector('[data-image-stage]'),image=stage?.querySelector('img');if(!image)return false;image.dispatchEvent(new w.PointerEvent(type,{pointerId:id,pointerType:'touch',clientX:x,clientY:y,bubbles:true,cancelable:true}));return true;};
   document.querySelector('#pinch').onclick=()=>{emitPointer('pointerdown',11,145,400);emitPointer('pointerdown',12,245,400);emitPointer('pointermove',11,95,400);emitPointer('pointermove',12,295,400);emitPointer('pointerup',12,295,400);emitPointer('pointermove',11,125,425);emitPointer('pointerup',11,125,425);};
   document.querySelector('#shrink').onclick=()=>{emitPointer('pointerdown',21,95,400);emitPointer('pointerdown',22,295,400);emitPointer('pointermove',22,145,400);emitPointer('pointerup',22,145,400);emitPointer('pointermove',21,155,480);emitPointer('pointerup',21,155,480);};
   document.querySelector('#hold-image').onclick=()=>{emitPointer('pointerdown',11,195,400);setTimeout(()=>emitPointer('pointerup',11,195,400),650);};
   document.querySelector('#pull').onclick=async()=>{
    const frame=document.querySelector('iframe'),w=frame.contentWindow,root=w.document.querySelector('.pull-refresh');if(!root){document.querySelector('#result').textContent='当前页面无列表刷新';return;}
    const before=await (await fetch('/simulation/stats')).json(),host=w.document.scrollingElement;host.scrollTop=0;
    const send=(type,y,end=false)=>{const touch=new w.Touch({identifier:1,target:root,clientX:120,clientY:y});root.dispatchEvent(new w.TouchEvent(type,{bubbles:true,cancelable:true,touches:end?[]:[touch],changedTouches:[touch]}));};
    send('touchstart',180);send('touchmove',320);setTimeout(()=>send('touchend',320,true),300);
    setTimeout(async()=>{const after=await (await fetch('/simulation/stats')).json();document.querySelector('#result').textContent=(after['v8.project.search']||0)>(before['v8.project.search']||0)?'已触发实际项目刷新请求':'当前页面刷新结果需另行确认';},800);
   };</script>`);return;
  }
  if(req.url==='/simulation/stats'){res.writeHead(200,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(scenario.counts));return;}
  const match=/^\/simulation\/(sim-[abmu])$/.exec(req.url||'');if(match){res.writeHead(302,{'set-cookie':`simulation_member=${match[1]}; HttpOnly; SameSite=Lax; Path=/`,location:'/#/chat'});res.end();return;}handler(req,res);
 });gateway.on('close',()=>scenario.close());gateway.listen(port,'127.0.0.1',()=>console.log('LOCAL SIMULATION ONLY '+origin+'/simulation/sim-a'));return gateway;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))startLocal();
