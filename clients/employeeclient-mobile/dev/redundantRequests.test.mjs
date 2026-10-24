import {createRecoveryGate} from '../src/platform/recoveryGate.mjs';
import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import ts from 'typescript';import {defineStore,createPinia} from 'pinia';import {ref,computed,watch,onScopeDispose,effectScope} from 'vue';
import {conversationContentChanged} from '../src/domain/conversationChange.mjs';
import {mergeChatMessages,applyChatChanges} from '../src/chat/projection.ts';
const settle=()=>new Promise(r=>setImmediate(r));
function source(file,deps,returns){const js=ts.transpileModule(readFileSync(new URL('../'+file,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText.replace(/^import[^\n]*\n/gm,'').replace(/^export /gm,'');return new Function(...Object.keys(deps),js+';return '+returns)(...Object.values(deps));}
class ApiError extends Error{constructor(code,hint,status){super(hint);this.code=code;this.status=status;}get needsAuth(){return this.status===401;}}
test('receipt-only notification changes do not invalidate conversations; actual content does',()=>{
 const row={id:'n',kind:'chat_message',object_id:'m',title:'A',summary:'text',snapshot:{attention:'normal'}};
 for(const patch of [{read_at:1},{pinned_at:1},{snooze_until:9},{version:2,update_version:3},{hidden_at:1}])assert.equal(conversationContentChanged(row,{...row,...patch}),false);
 for(const patch of [{summary:'new'},{title:'new'},{snapshot:{message_change:'recall'}}])assert.equal(conversationContentChanged(row,{...row,...patch}),true);
 assert.equal(conversationContentChanged(undefined,row),true);
});
test('chat lifecycle reads coalesce, member directory is reused, real events during a read trigger one follow-up',async()=>{
 const saved=new Map();let reads=0,changes=0,members=0,hold,release;
 const communication={messages:async()=>{reads++;if(hold)await new Promise(r=>release=r);return {messages:[],next_cursor:0,sync_cursor:0,has_more:false};},changes:async()=>{changes++;return {changes:[],next_change_cursor:0,has_more:false};},members:async()=>{members++;return {members:[]};},send:async()=>({message:{id:'own',seq:1}})};
 const use=source('src/store/chat.ts',{createRecoveryGate,defineStore,ref,communication,ApiError,mergeChatMessages,applyChatChanges,newIdempotencyKey:()=> 'key',metaGet:async(a,k)=>saved.get(a+k)||null,metaSet:async(a,k,v)=>saved.set(a+k,v)},'{useChatStore}').useChatStore;
 const s=use(createPinia());await s.setAccount('a');hold=true;const first=s.refresh();await settle();await s.refresh();await s.refresh();assert.equal(reads,1);
 await s.refresh({changed:true});hold=false;release();await first;assert.equal(reads,2);assert.equal(changes,2);assert.equal(members,1);
 await s.send({body:'own'});await settle();assert.equal(reads,2,'own receipt merges directly');await s.refreshMembers(true);assert.equal(members,2);
 s.$dispose();
});
test('pure announcement read hints skip inbox reads; receipt changes do not wake chat or replies',async()=>{
 const meta=new Map(),rows=new Map(),wakes=[];let inboxCalls=0,listCalls=0,notifications=[];
 const db={metaGet:async(a,k)=>meta.get(a+k)??null,metaSet:async(a,k,v)=>meta.set(a+k,v),metaRemove:async(a,k)=>meta.delete(a+k),getAllByAccount:async()=>[...rows.values()],putMany:async(_,a,data)=>{for(const n of data)rows.set(n.id,n);},removeById:async(_,a,id)=>rows.delete(id)};
 db.withLease=valid=>Object.fromEntries(['metaSet','metaRemove','putMany','removeById'].map(k=>[k,(...a)=>valid()?db[k](...a):undefined]));
 const me={notifications:async()=>{inboxCalls++;return {notifications,sync_version:inboxCalls,next_cursor:null,has_more:false};},announcements:async()=>{listCalls++;return {announcements:[]};}};
 const deps={defineStore,ref,computed,watch,onScopeDispose,me,ApiError,isOnline:()=>true,db,conversationContentChanged,presentCatchUp:async()=>{},presentLive:async()=>{},notifyChatWake:(...a)=>wakes.push(a),personalDenied:()=>false,denyPersonal:()=>{},isPersonalRecord:()=>false,isRelevantNotice:()=>true,isNewArrival:()=>false,isCursorRestartHint:()=>false,isFloatingEligible:()=>false,ghostIdsToEvict:()=>[]};
 const s=source('src/store/data.ts',deps,'{useDataStore}').useDataStore(createPinia());s.setAccount('a');
 notifications=[{id:'chat',kind:'chat_message',object_id:'m',title:'A',summary:'new',snapshot:{},version:1,update_version:1}];
 await s.syncNotifications('a');assert.equal(s.chatRevision,1);assert.equal(wakes.length,1);wakes.length=0;
 notifications=notifications.map(n=>({...n,read_at:1,version:2,update_version:2}));await s.syncNotifications('a');assert.equal(s.chatRevision,1);assert.equal(wakes.length,0);
 notifications=[{id:'reply',kind:'announcement_reply',object_id:'r',summary:'reply',snapshot:{announcement_id:'ann'},version:1,update_version:1}];await s.syncNotifications('a');assert.equal(s.chatRevision,1,'reply does not invalidate chat');assert.equal(s.announcementRevision,0,'reply does not invalidate announcement list');assert.equal(wakes.at(-1)[2][0].kind,'announcement_reply');wakes.length=0;
 const inboxBefore=inboxCalls;await s.syncNotifications('a',false,'live',{kinds:['member_presence']});await s.syncNotifications('a',false,'live',{kinds:['member_avatar']});assert.equal(inboxCalls,inboxBefore,'member state and avatar hints do not read the inbox');assert.equal(wakes.length,0);
 await s.syncNotifications('a',false,'live',{kinds:['announcement_read'],announcementIds:['ann']});assert.equal(inboxCalls,3);assert.equal(wakes[0][3].announcementIds[0],'ann');
 await Promise.all([s.syncLists('a'),s.syncLists('a')]);assert.equal(listCalls,1);
 s.$dispose();
});

test('Web Push reuses an existing subscription without a configuration request',async()=>{
 let calls=0;const subscription={toJSON:()=>({endpoint:'synthetic-local'})};
 const deps={apiRequest:async()=>{calls++;return {web_push:{supported:true,application_server_key:'key'}};},ApiError,devicePlatform:()=> 'web',hasWebPushSupport:()=>true,isAndroidNative:()=>false,Notification:{permission:'granted'},navigator:{serviceWorker:{ready:Promise.resolve({pushManager:{getSubscription:async()=>subscription}})}}};
 const model=source('src/platform/push.ts',deps,'{getPushSubscription}');assert.equal((await model.getPushSubscription(false)).subscription.endpoint,'synthetic-local');assert.equal(calls,0);
});
test('filtered chat shares lifecycle reads but retains a real event arriving while busy',async()=>{
 const scope=effectScope();let calls=0,release,hold=true;
 const communication={messages:async()=>{calls++;if(hold)await new Promise(r=>release=r);return {messages:[],has_more_old:false};}};
 let model;scope.run(()=>{model=source('src/chat/query.ts',{ref,computed,watch,onScopeDispose,communication,mergeChatMessages,userError:e=>e.message},'{useChatQuery}').useChatQuery(ref('a'),ref({mention_me:true}));});
 await settle();await model.refresh();assert.equal(calls,1);await model.refresh(true);hold=false;release();await settle();await settle();assert.equal(calls,2);scope.stop();
});
test('avatar images share one fetch and a stale session cannot write another account cache',async()=>{
 const cache=new Map();let account='a',epoch=1,calls=0,release;
 const captureApiLease=()=>{const a=account,e=epoch;return {account:a,valid:()=>account===a&&epoch===e};};
 const deps={captureApiLease,metaGet:async(a,k)=>cache.get(a+k)||null,metaSet:async(a,k,v,valid)=>{if(valid())cache.set(a+k,v);},apiRequest:async()=>{calls++;return new Promise(r=>release=r);}};
 const model=source('src/chat/avatar-cache.ts',deps,'{avatarUrl}'),first=model.avatarUrl('peer','v1'),second=model.avatarUrl('peer','v1');await settle();assert.equal(calls,1);release({avatar_version:'v1',data_url:'data:image/jpeg;base64,photo'});assert.equal(await first,await second);await model.avatarUrl('peer','v1');assert.equal(calls,1);
 const pending=model.avatarUrl('peer','v2');await settle();account='b';epoch++;release({avatar_version:'v2',data_url:'data:image/jpeg;base64,next'});assert.equal(await pending,'');assert.equal(cache.has('aavatar:peer:v2'),false);assert.equal(cache.has('bavatar:peer:v2'),false);
});

test('notification arriving during a held read gets one follow-up and is not lost',async()=>{
 const meta=new Map(),rows=new Map(),wakes=[];let inboxCalls=0,listCalls=0,notifications=[],release,hold=false;
 const db={metaGet:async(a,k)=>meta.get(a+k)??null,metaSet:async(a,k,v)=>meta.set(a+k,v),metaRemove:async(a,k)=>meta.delete(a+k),getAllByAccount:async()=>[...rows.values()],putMany:async(_,a,data)=>{for(const n of data)rows.set(n.id,n);},removeById:async(_,a,id)=>rows.delete(id)};
 db.withLease=valid=>Object.fromEntries(['metaSet','metaRemove','putMany','removeById'].map(k=>[k,(...a)=>valid()?db[k](...a):undefined]));
 const me={notifications:async()=>{inboxCalls++;const snapshot=[...notifications];if(hold){hold=false;await new Promise(r=>release=r);}return {notifications:snapshot,sync_version:inboxCalls,next_cursor:null,has_more:false};},announcements:async()=>{listCalls++;return {announcements:[]};}};
 const deps={defineStore,ref,computed,watch,onScopeDispose,me,ApiError,isOnline:()=>true,db,conversationContentChanged,presentCatchUp:async()=>{},presentLive:async()=>{},notifyChatWake:(...a)=>wakes.push(a),personalDenied:()=>false,denyPersonal:()=>{},isPersonalRecord:()=>false,isRelevantNotice:()=>true,isNewArrival:()=>false,isCursorRestartHint:()=>false,isFloatingEligible:()=>false,ghostIdsToEvict:()=>[]};
 const s=source('src/store/data.ts',deps,'{useDataStore}').useDataStore(createPinia());s.setAccount('a');

 await s.syncNotifications('a');hold=true;
 notifications=[{id:'first',kind:'chat_message',object_id:'m1',snapshot:{},update_version:1}];
 const first=s.syncNotifications('a');await settle();
 notifications=[...notifications,{id:'second',kind:'chat_message',object_id:'m2',snapshot:{},update_version:1}];
 const next=s.syncNotifications('a'),duplicate=s.syncNotifications('a');release();await Promise.all([first,next,duplicate]);
 assert.equal(inboxCalls,3);assert.equal(s.notifications.length,2);assert.ok(s.notifications.some(n=>n.id==='second'));s.$dispose();
});
