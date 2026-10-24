// Actual TypeScript/store/component control flow; external IO is fault-injected.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import { ref, shallowRef, computed, watch, reactive, onScopeDispose } from 'vue';
import { defineStore, createPinia } from 'pinia';
// These integration cases exercise the separately delivered V8 backend.  The
// client source archive intentionally does not bundle it, so keep the rest of
// the client suite runnable when that optional checkout is absent.
let openV2, makeRepo, makeTx, makeV2, makeNotify;
try {
  ({ openV2 } = await import('../../../../03-代码文档/当前实现/v8-v2/schema.mjs'));
  ({ makeRepo } = await import('../../../../03-代码文档/当前实现/v8-v2/repository.mjs'));
  ({ makeTx } = await import('../../../../03-代码文档/当前实现/v8-v2/transactions.mjs'));
  ({ makeV2 } = await import('../../../../03-代码文档/当前实现/v8-v2/router.mjs'));
  ({ makeNotify } = await import('../../../../03-代码文档/当前实现/v8-v2/notify.mjs'));
} catch { /* Standalone client package: backend integration cases are skipped. */ }
const backendTest = openV2 ? test : test.skip;
async function moduleFrom(path, deps = {}, expose = '') {
  let text = await readFile(new URL('../src/'+path,import.meta.url),'utf8');
  if (path.endsWith('.vue')) text=text.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1];
  const js=ts.transpileModule(text+'\n'+expose,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText.replace(/^import[\s\S]*?from ['"][^'"]+['"];\s*$/gm,'');
  const key='__qn_review_'+Math.random().toString(36).slice(2);
  globalThis[key]=deps;
  try { return await import('data:text/javascript;base64,'+Buffer.from(`const {${Object.keys(deps).join(',')}}=globalThis['${key}'];\n`+js).toString('base64')); }
  finally { delete globalThis[key]; }
}
const api = await moduleFrom('api/client.ts', {serviceOrigin: () => ''});
const { ApiError } = api;

test('all network transports use the single runtime origin contract', async () => {
  const [runtime, client, live, productionEnv] = await Promise.all([
    readFile(new URL('../src/api/runtime.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/api/client.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/platform/liveTransport.ts', import.meta.url), 'utf8'),
    readFile(new URL('../.env.production', import.meta.url), 'utf8'),
  ]);
  assert.match(runtime, /VITE_PUBLIC_ORIGIN/);
  assert.match(runtime, /https:\/\/employeeclient\.dominolif\.com/);
  assert.match(client, /apiBase:\s*serviceOrigin\(\)/);
  assert.match(client, /hufuBase:\s*serviceOrigin\(\) \+ '\/hufu'/);
  assert.match(live, /servicePath\('\/api\/v2\/me\/events'\)/);
  assert.match(productionEnv, /^VITE_PUBLIC_ORIGIN=https:\/\/employeeclient\.dominolif\.com$/m);
});
const settle = () => new Promise(r=>setImmediate(r));
const storage = new Map();
globalThis.localStorage={getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,String(v)),removeItem:k=>storage.delete(k)};

for (const kind of ['project','announcement','handling','supplement']) backendTest(kind+' committed response lost: actual form remount replays one SQLite write', async t => {
  storage.clear(); process.env.V8_MAIN_CONTROL_USERNAME='review-master';
  const db=openV2(':memory:'),repo=makeRepo(db),keyRef={cur:''},notify=makeNotify(db,repo,{keyRef}),tx=makeTx(repo,notify,keyRef);
  t.after(()=>db.close());
  const dispatch=makeV2({repo,tx,notify,listAssignees:async()=>[{username:'a',role:'member'}]});
  const user={username:kind==='announcement'?'review-master':'a',role:kind==='announcement'?'admin':'member'};
  const call=async(path,body)=>{const r=await dispatch({user,method:'POST',path:'/api/v2/'+path,query:{},body}); assert.ok(r.status<300,JSON.stringify(r));return r.json;};
  const issue=['handling','supplement'].includes(kind)?await call('me/issues',{title:'issue',idempotency_key:'seed'}):null;
  let lost=true,seq=0;const keys=[];
  const writes=await moduleFrom('session/pendingWrites.ts',{personalDenied:()=>false,newIdempotencyKey:()=>`write-${kind}-${++seq}`});
  const data={account:user.username,personalProjects:[],captureLease:()=>({account:user.username,valid:()=>true}),syncAll:async()=>{},syncLists:async()=>{}};
  const ui={overlayProps:{issueId:issue?.object_id,expectedVersion:1},confirm:async()=>true,closeOverlay(){},toast(){}};
  const recovery=await moduleFrom('ui/usePendingWrite.ts',{...writes,shallowRef,useDataStore:()=>data,useUiStore:()=>ui});
  async function invoke(path,body,key){keys.push(key);const r=await call(path,{...body,idempotency_key:key});if(lost){lost=false;throw new ApiError('network','response lost',0);}return r;}
  const deps={ref,computed,useSessionStore:()=>({user,status:'online'}),communication:{members:async()=>({members:[]}),publishAnnouncement:(b,k)=>invoke('control/announcements',b,k)},onMounted:f=>f(),useRouter:()=>({push(){}}),ApiError,usePendingWrite:recovery.usePendingWrite,useDataStore:()=>data,useUiStore:()=>ui,
    me:{createPersonalProject:(b,k)=>invoke('me/personal-projects',b,k),handlingEvent:(id,b,k)=>invoke(`me/issues/${id}/handling-events`,b,k),supplementIssue:(id,b,k)=>invoke(`me/issues/${id}/supplements`,b,k)},
    control:{assignees:async()=>({assignees:[]}),publishAnnouncement:(b,k)=>invoke('control/announcements',b,k)}};
  const file={project:'ProjectFormOverlay',announcement:'AnnouncementFormOverlay',handling:'ClaimOverlay',supplement:'SupplementOverlay'}[kind];
  const fields={project:'name',announcement:'body,selected',handling:'note',supplement:'content'}[kind];
  const load=()=>moduleFrom('ui/components/'+file+'.vue',deps,`export { submit,err,${fields} };`);
  const first=await load();
  if(kind==='project')first.name.value='one intention';else if(kind==='announcement'){first.body.value='one intention';first.selected.value=['a'];}else if(kind==='handling')first.note.value='one intention';else first.content.value='one intention';
  await first.submit();assert.match(first.err.value,/response lost/);
  const second=await load();await second.submit();assert.equal(second.err.value,'');assert.equal(keys.length,2);assert.equal(keys[0],keys[1]);
  const table={project:'projects',announcement:'announcements',handling:'issue_handling_events',supplement:'issue_supplements'}[kind];
  assert.equal(db.prepare('SELECT COUNT(*) n FROM '+table).get().n,1);
  assert.deepEqual(JSON.parse(localStorage.getItem('qn.pending-writes.'+user.username)),{});
});

test('write intent storage failure is fail-closed; scope cleanup preserves company and distinct new intentions get new keys',async t=>{
  storage.clear();let seq=0;
  const w=await moduleFrom('session/pendingWrites.ts',{personalDenied:()=>false,newIdempotencyKey:()=>`persist-${++seq}`});
  const first=w.beginWrite('a','project','personal',{name:'same'});
  assert.deepEqual(w.beginWrite('a','project','personal',{name:'changed'}),first);
  w.beginWrite('a','notice','company',{body:'keep'});w.clearPendingWrites('a','personal');
  assert.equal(w.pendingWrite('a','project','personal'),null);assert.ok(w.pendingWrite('a','notice','company'));
  const next=w.beginWrite('a','project','personal',{name:'same'});assert.notEqual(next.key,first.key);
  t.mock.method(localStorage,'setItem',()=>{throw Error('quota');});assert.throws(()=>w.beginWrite('b','project','personal',{name:'not sent'}),/quota/);
});

test('old credential response cannot invalidate a new session; current 401 still notifies',async t=>{
  let token='a',epoch=1,alarms=0,finish;
  api.configureApi({getToken:()=>token,getEpoch:()=>epoch,onUnauthorized:()=>alarms++});
  t.mock.method(globalThis,'fetch',()=>new Promise(r=>finish=r));
  const old=api.apiRequest('GET','/local'); const reject=assert.rejects(old,e=>e.status===401);
  token='b';epoch++;finish(new Response('{"error":"unauthenticated"}',{status:401})); await reject;
  assert.equal(alarms,0);
  const current=api.apiRequest('GET','/local');const rejected=assert.rejects(current);finish(new Response('{}',{status:401}));await rejected;assert.equal(alarms,1);
});

test('notification rollback follows session and exact optimistic object, never an old array index',async()=>{
  let epoch=1,finish;
  const s=reactive({account:'a',notifications:[{id:'a',read_at:null,hidden_at:null}],unreadCount:1,captureLease(){const e=epoch;return {account:this.account,valid:()=>e===epoch};},evictNotification:async()=>{}});
  const mod=await moduleFrom('store/actions.ts',{me:{notificationAction:()=>new Promise((_,rej)=>finish=rej)},company:{},control:{},newIdempotencyKey:()=> 'key',ApiError,withRetry:f=>f(),useDataStore:()=>s,useUiStore:()=>({toast(){}})});
  let work=mod.markRead(s.notifications[0]);epoch++;s.account='b';s.notifications=[{id:'b'}];s.unreadCount=4;finish(new ApiError('network','lost',0));await work;assert.equal(s.notifications[0].id,'b');assert.equal(s.unreadCount,4);
  s.notifications=[{id:'same',read_at:null,hidden_at:null}];s.unreadCount=1;
  work=mod.markRead(s.notifications[0]);s.notifications.unshift({id:'unrelated'});finish(new ApiError('network','lost',0));await work;
  assert.equal(s.notifications[0].id,'unrelated');assert.equal(s.notifications[1].read_at,null);assert.equal(s.unreadCount,1);
  work=mod.markRead(s.notifications[1]);s.notifications[1]={id:'same',read_at:999,update_version:9};finish(new ApiError('network','lost',0));await work;assert.equal(s.notifications[1].read_at,999);
});

backendTest('Issue accepted then response lost survives closing/reopening draft and creates one real SQLite record',async t=>{
  const db=openV2(':memory:'),repo=makeRepo(db),tx=makeTx(repo),dispatch=makeV2({repo,tx});t.after(()=>db.close());
  let saved,lost=true,seq=0;const keys=[];
  const deps={ref,computed,watch,onMounted:f=>f(),useRouter:()=>({push(){}}),newIdempotencyKey:()=> 'issue-key-'+ ++seq,ApiError,isOnline:()=>true,
    me:{createIssue:async(body,key)=>{keys.push(key);const r=await dispatch({user:{username:'a',role:'member'},method:'POST',path:'/api/v2/me/issues',query:{},body:{...body,idempotency_key:key}});assert.ok(r.status<300,JSON.stringify(r));if(lost){lost=false;throw new ApiError('network','lost response',0);}return r.json;}},
    useSessionStore:()=>({}),useDataStore:()=>({account:'a',personalProjects:[],captureLease:()=>({account:'a',valid:()=>true}),captureAccountLease:()=>({account:'a',valid:()=>true}),syncAll:async()=>{}}),
    useUiStore:()=>({overlayProps:{scope:'company',draft:saved},confirm:async()=>true,closeOverlay(){},toast(){}}),
    listDrafts:()=>[],saveDraft:(_,d)=>{saved=JSON.parse(JSON.stringify(d));},deleteDraft:()=>{saved=null;},newDraftId:()=> 'draft-one'};
  const expose='export { submit, title, detail, pendingSubmission };';
  const first=await moduleFrom('ui/components/CreateOverlay.vue',deps,expose);first.title.value='one issue';await first.submit();assert.ok(saved.submission);
  const second=await moduleFrom('ui/components/CreateOverlay.vue',deps,expose);await second.submit();
  assert.equal(keys.length,2);assert.equal(keys[0],keys[1]);assert.equal(repo.listIssues().length,1);assert.equal(saved,null);
});

test('first login network failure stays anonymous; confirmed expired binding clears data/drafts and stops transport',async t=>{
  let saved=null,clears=0,stops=0,closed=0,failLogin=true;
  const data={account:'',setAccount(a){this.account=a;},setMainControl(){},hydrateFromCache:async()=>{},clearAccount:async()=>{clears++;},syncAll:async()=>[]};
  const deps={clearReadCache(){},clearVoiceDurations(){},clearCloudFiles(){},clearCloudJobs(){},clearAcquisitions(){},clearGroupSends(){},clearLocalSaves(){},clearForwards(){},clearUploadReceipts(){},clearAttachmentCache:async()=>{},defineStore,ref,computed,watch,useChatStore:()=>({setAccount:async()=>{}}),auth:{login:async()=>{if(failLogin)throw new ApiError('network','offline',0);return {token:'hufu',username:'a'};}},
    me:{bootstrap:async()=>{throw new ApiError('unauthenticated','revoked',401);}},configureApi(){},ApiError,isOnline:()=>true,establishSession:async()=>({ok:false,kind:'connection'}),refreshHufu:async()=>null,
    startLiveLink(){},stopLiveLink(){stops++;},pokeLiveLink(){},liveLinkState:()=> 'stopped',liveLinkSnapshot:()=>({state:'stopped'}),presentLive:async()=>{},presentCatchUp:async()=>{},getInstallationId:()=> 'phone',
    loadSession:()=>saved,saveSession:s=>{saved=s;},clearSession:()=>{saved=null;},useDataStore:()=>data,clearDrafts:()=>{closed++;},clearArchives(){},useUiStore:()=>({closeOverlay(){}}),setPushIdentity:async()=>{}};
  const mod=await moduleFrom('session/store.ts',deps);const s=mod.useSessionStore(createPinia());t.after(()=>s.$dispose());
  assert.equal(await s.login('a','local-test'),false);assert.equal(s.status,'anonymous');assert.equal(s.isAuthenticated,false);
  failLogin=false;assert.equal(await s.login('a','local-test'),false);assert.equal(s.status,'anonymous');assert.equal(s.isAuthenticated,false);
  saved={mode:'device',token:'qn1.old',username:'a',installationId:'phone'};
  assert.equal(await s.restore(),false);assert.equal(s.status,'expired');assert.equal(s.user,null);assert.equal(saved,null);assert.equal(data.account,'');assert.equal(clears,1);assert.equal(closed,1);assert.ok(stops);
});

test('archive is a reactive projection; only newer actionable work restores it, without changing Task state',async()=>{
  const proj=await moduleFrom('ui/taskProjection.ts',{done:t=>['completed','cancelled'].includes(t.main_state),awaiting:t=>t.current_node==='awaiting_code_review'});
  const archive=await moduleFrom('session/archive.ts',{ref,actionNeeded:proj.actionNeeded});
  const task={id:'t',version:1,scope_at_creation:'company',assignee_username:'a',main_state:'incomplete',current_node:'awaiting_code'};
  const ctx=computed(()=>({username:'a',isMainControl:false,archivedTaskIds:new Set(archive.listArchived('a','task'))}));
  const list=computed(()=>proj.projectInbox([task],ctx.value,'action'));
  assert.equal(list.value.length,1);archive.archiveTask('a',task,[]);assert.equal(list.value.length,0);
  archive.reconcileTaskArchives('a',[task],[],false);assert.equal(list.value.length,0);
  archive.reconcileTaskArchives('a',[{...task,version:2,current_node:'awaiting_code_revision'}],[],false);assert.equal(list.value.length,1);assert.equal(task.main_state,'incomplete');
});

test('session owns chat identity and stream backoff cannot disable HTTP or defer wake behind work sync',async t=>{
 let owner='',hooks,wakes=0;const saved={mode:'device',token:'qn1.fixture',username:'a',installationId:'phone'};
 const data={account:'',setAccount(a){this.account=a},setMainControl(){},hydrateFromCache:async()=>{},syncAll:async()=>{throw Error('unrelated work list unavailable')}};
 const deps={clearReadCache(){},clearVoiceDurations(){},clearCloudFiles(){},clearCloudJobs(){},clearAcquisitions(){},clearGroupSends(){},clearLocalSaves(){},clearForwards(){},clearUploadReceipts(){},clearAttachmentCache:async()=>{},defineStore,ref,computed,watch,useChatStore:()=>({setAccount:async a=>{owner=a}}),useDataStore:()=>data,
 me:{bootstrap:async()=>({user:{username:'a'},is_main_control:false,counts:{}})},auth:{},configureApi(){},ApiError,isOnline:()=>true,
 establishSession:async()=>{},refreshHufu:async()=>null,reconcilePushBinding:async()=>{},
 startLiveLink:h=>{hooks=h},stopLiveLink(){},pokeLiveLink(){},liveLinkState:()=> 'stopped',liveLinkSnapshot:()=>({state:'stopped',networkUp:true}),
 presentLive:async()=>{},presentCatchUp:async()=>{},getInstallationId:()=> 'phone',loadSession:()=>saved,saveSession(){},clearSession(){},
 clearDrafts(){},clearArchives(){},useUiStore:()=>({closeOverlay(){}}),setPushIdentity:async()=>{},notifyChatWake:()=>wakes++};
 const mod=await moduleFrom('session/store.ts',deps);const s=mod.useSessionStore(createPinia());t.after(()=>s.$dispose());
 assert.equal(await s.restore(),true);assert.equal(owner,'a');assert.equal(s.status,'online');
 hooks.onStateChange({state:'backoff',networkUp:true});assert.equal(s.status,'online');assert.equal(s.isAuthenticated,true);
 hooks.onWake();assert.equal(wakes,1);await assert.rejects(hooks.onTick('live'),/unrelated work list/);
 hooks.onWake();assert.equal(wakes,2);assert.equal(s.status,'online');
 hooks.onNetworkChange(false);assert.equal(s.link.networkUp,false);assert.equal(s.status,'offline');
 hooks.onNetworkChange(true);assert.equal(s.link.networkUp,true);assert.equal(s.status,'online');
 s.user=null;assert.equal(owner,'');
});
