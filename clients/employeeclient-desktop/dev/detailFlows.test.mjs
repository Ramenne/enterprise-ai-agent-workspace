import {readFeedbackFixture} from './readFeedback.fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {once} from 'node:events';
import {ref,computed,watch,reactive} from 'vue';
import ts from 'typescript';
import {fileName} from '../src/native/discovery.mjs';
import {detailProperties,workRelations,fixedReference,resolveFixedVersion,safeDetailReturn,basisText,workBrief} from '../src/native/detail-model.mjs';
import {readStatement} from '../src/native/statement.mjs';
import {NativeClient} from '../src/native/client.mjs';
import {createLocalScenario} from './reconstruction-local.mjs';
import {createGateway} from '../server/gateway.mjs';
import {PROJECT} from '../server/business/native-authority.mjs';
import {userError} from '../src/domain/userError.mjs';
const material='4bbf924c-a36c-4a86-ac04-7effd6c51110',old='351e2891-2e2c-47f9-a309-3bbf4420161f';
async function moduleSource(path,deps,expose){
 deps={useReadFeedback:readFeedbackFixture,...deps};
 let source=await readFile(new URL('../src/'+path,import.meta.url),'utf8');if(path.endsWith('.vue'))source=source.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1];
 const code=ts.transpileModule(source.replace(/^import[^\n]+\n/gm,''),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText.replace(/\bexport /g,'');
 return new Function(...Object.keys(deps),code+';return {'+expose+'};')(...Object.values(deps));
}
test('object citation basis and nested/array properties are readable without object serialization',()=>{
 const basis={explanation:'直接采用旧工作基线',refs:[{fixed_ref:{material_id:material,version_id:old}}]};
 const rows=workRelations({relations:[{id:'r',from_work_id:'a',to_work_id:'b',basis}],work_item:{properties:{relations:{outgoing:[{work_item_id:'b',citations:[{relation_id:'r',basis}]}]}}}},'a');
 assert.equal(rows.length,1);assert.equal(rows[0].explanation,basis.explanation);assert.equal(rows[0].outgoing,true);assert.equal(workRelations({relations:[{from_work_id:'a',to_work_id:'b',basis}]},'b')[0].outgoing,false);
 assert.deepEqual(fixedReference(basis.refs[0]).material_id,material);
 const props=detailProperties({attributes:{tags:['聊天','通知'],verified:false,count:0},简介:'完整正文'});
 assert.equal(props.find(p=>p.key==='attributes.tags').value,'聊天、通知');assert.equal(props.find(p=>p.key==='attributes.verified').value,'否');assert.equal(props.find(p=>p.key==='attributes.count').value,'0');assert.ok(props.find(p=>p.key==='简介'));assert.doesNotMatch(basisText({reason:'沿用已有接口'}),/\[object Object\]/);
});
test('return routes accept only local product views and reject external and injected targets',()=>{
 for(const path of ['/files?project=p','/work/id?project=p','/chat','/material/id?version=v','/notifications','/profile'])assert.equal(safeDetailReturn(path),path);
 for(const path of ['https://bad.invalid','//bad.invalid','/connect','/work\\x','/work#https://bad.invalid'])assert.equal(safeDetailReturn(path),'/work');
});
test('actual gateway resolves an old fixed version without size, reads its bytes and expands history output',async()=>{
 const s=createLocalScenario(),server=createGateway({root:'/tmp',publicOrigin:'http://127.0.0.1',fetcher:s.fetcher,businessHandler:s.businessHandler});server.listen(0,'127.0.0.1');await once(server,'listening');
 const client=new NativeClient({base:'http://127.0.0.1:'+server.address().port,fetcher:(url,opts)=>fetch(url,{...opts,headers:{...opts.headers,origin:'http://127.0.0.1',cookie:'simulation_member=sim-a'}})});
 try{
  const files=s.repository.files({actor_id:'sim-a',project_id:PROJECT,can_read:true}).files;
  for(const attachment of files){const [materialId,versionId]=attachment.id.split(':');assert.ok(versionId);const head=await client.head(PROJECT,materialId);assert.ok(head.placements[0].logical_path);assert.equal(head.fixed_ref.version_id,versionId);const body=await client.readFile(PROJECT,head.fixed_ref);assert.equal(body.size,attachment.size);const stream=await fetch(client.fileUrl(PROJECT,head.fixed_ref,'文件.txt'),{headers:{cookie:'simulation_member=sim-a'}});assert.equal(stream.status,200);assert.equal((await stream.arrayBuffer()).byteLength,attachment.size);}
  const fixed=await resolveFixedVersion(client,PROJECT,material,old,'');assert.equal(fixed.local_version_no,'1');assert.equal(fixed.version_id,old);
  const blob=await client.readFile(PROJECT,fixed);assert.match(await blob.text(),/历史版本正文/);
  const page=await client.rpc('v8.work.history.page',{project_id:PROJECT,work_item_id:'29c081d9-ff48-41c9-adbf-31b0b19c36b4',kind:'updates',limit:20});
  const statement=await readStatement(client,PROJECT,page.items[0]);assert.equal(statement.outputs[0].version_id,old);
  await assert.rejects(resolveFixedVersion(client,PROJECT,material,old,'0'.repeat(64)),/不一致/);
  await assert.rejects(resolveFixedVersion(client,PROJECT,material,'4d2220e7-0e2f-4bd1-ac9c-6146b529867d',''),/不可读取/);
 }finally{await new Promise(r=>server.close(r));s.close();}
});
async function announcement(){
 const account='a',ann={id:'ann',notification_id:'own-projection',publisher_username:'m',body:'本人的公告',read_at:null};let failure=false;const calls=[];
 const data={account,notifications:[],announcements:[ann]},session={user:{username:account},status:'online'},ui={overlayProps:{announcementId:'ann'},toast(){},closeOverlay(){}};
 const deps={useLocalDraft:()=>({restoring:ref(false),readyToEdit:ref(true),flush:async()=>{},error:ref(''),retry:async()=>{}}),useVisibleAnnouncementReads:()=>{},ref,computed,watch,reactive,onMounted:()=>{},onUnmounted:()=>{},useChatStore:()=>({account,members:[]}),useDataStore:()=>data,useUiStore:()=>ui,useSessionStore:()=>session,markRead:async n=>{calls.push(n);ann.read_at=123;return true;},communication:{announcement:async()=>{if(failure)throw Object.assign(Error('forbidden'),{status:403});return {announcement:{...ann}};},replies:async()=>({replies:[],has_more:false,next_cursor:0})},usePendingWrite:()=>({pending:ref(null),valid:()=>true}),userError,ago:()=>'',exact:()=>'',onChatWake:()=>()=>{},window:{innerHeight:800}};
 const view=await moduleSource('ui/components/AnnouncementOverlay.vue',deps,'loadDetail,confirmRead,ann,canConfirmRead');return {view,calls,fault:v=>failure=v};
}
test('direct announcement acknowledgement does not depend on inbox load',async()=>{
 const f=await announcement();await f.view.loadDetail();assert.equal(f.view.canConfirmRead.value,true);await f.view.confirmRead();assert.deepEqual(f.calls,[{id:'own-projection',kind:'announcement'}]);assert.equal(f.view.canConfirmRead.value,false);
});
test('explicit detail rejection hides cached announcement body until a successful authorized read',async()=>{
 const f=await announcement();await f.view.loadDetail();f.fault(true);await f.view.loadDetail();assert.equal(f.view.ann.value,null);await f.view.loadDetail();assert.equal(f.view.ann.value,null);f.fault(false);await f.view.loadDetail();assert.ok(f.view.ann.value);
});
test('minimal authority reference rolls back the actual cached notification on failure',async()=>{
 const before={id:'n',kind:'announcement',read_at:null,hidden_at:null,title:'完整投影',extra:'保留'},store={notifications:[before],unreadCount:1,captureLease:()=>({valid:()=>true})};
 const deps={readNotificationBatch:()=>{},userError,me:{notificationAction:async()=>{throw Error('temporary failure');}},newIdempotencyKey:()=> 'key',ApiError:class extends Error{},withRetry:f=>f(),useDataStore:()=>store,useUiStore:()=>({captureFeedback:()=>({reportError(){},toast(){}}),reportError(){},toast(){}})};
 const actions=await moduleSource('store/actions.ts',deps,'markRead');assert.equal(await actions.markRead({id:'n',kind:'announcement'}),false);assert.deepEqual(store.notifications[0],before);assert.equal(store.unreadCount,1);
 store.notifications=[];assert.equal(await actions.markRead({id:'missing',kind:'announcement'}),false);assert.deepEqual(store.notifications,[]);assert.equal(store.unreadCount,1);
});

test('a late older-version response cannot replace the selected version of the same file',async()=>{
 const route=reactive({name:'material-detail',params:{id:material},query:{project:PROJECT,version:old,hash:''}});let finish,started;
 const pending=new Promise(r=>finish=r),began=new Promise(r=>started=r),current={material_id:material,version_id:'b2d1d4d7-e22d-43b7-a647-27b7f4f3cb88',sha256:'a'.repeat(64),size:51};
 class Client{reset(){}async rpc(){return {material:{logical_path:'文件.txt'},fixed_ref:current};}}
 const deps={ref,computed,watch:()=>{},onBeforeUnmount:()=>{},useRoute:()=>route,useRouter:()=>({push(){}}),NativeClient:Client,readProjects:async()=>[],readHubDetail:(_lease,_project,_id,_work,options)=>new Client().rpc().then(value=>{options?.onSnapshot?.(value);return value;}),hubCache:{read:(_lease,_key,loader)=>loader()},valueLabel:v=>v,workBrief,numberLabel:v=>String(v),fileName:f=>f.logical_path,detailProperties,workRelations,fixedReference,sizeLabel:()=>'',resolveFixedVersion:async(_c,_p,_m,version)=>{if(version===old){started();return pending;}return current;},safeDetailReturn,userError,serviceOrigin:()=>'',captureApiLease:()=>({valid:()=>true,account:'a'}),useSessionStore:()=>({onUnauthorized(){}}),useUiStore:()=>({}),reserveSave:()=>{},saveVerified:()=>{}};
 const view=await moduleSource('ui/views/HubDetailView.vue',deps,'load,fixed');const first=view.load();await began;route.query.version=current.version_id;await view.load();finish({...current,version_id:old});await first;assert.equal(view.fixed.value.version_id,current.version_id);
});

test('current native material head uses placements for its readable filename',()=>{
 const head={material_id:'actual-material',fixed_ref:{display_no:'F-1001-001'},placements:[{logical_path:'阶段报告/员工客户端-真实接口说明.md'}],properties:{attributes:{material_kind:'实施报告'},governance:{reason:'内部记录'}}};
 assert.equal(fileName(head),'员工客户端-真实接口说明.md');
 assert.equal(fileName({fixed_ref:{display_no:'F-1001-001'}}),'F-1001-001');
});
