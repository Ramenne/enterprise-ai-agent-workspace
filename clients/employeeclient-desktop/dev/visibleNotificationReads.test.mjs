import test,{mock} from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import {isWorkNotice,isAnnouncementNotice} from '../src/domain/noticeChannel.mjs';
import { ref, reactive, watch, nextTick } from 'vue';
const turn=async()=>{await nextTick();await new Promise(r=>setImmediate(r));};
async function fixture({kind='work',fail=false,native=false,networkReady=true}={}){
 const source=await readFile(new URL('../src/chat/readVisible.ts',import.meta.url),'utf8');
 const code=ts.transpileModule(source.replace(/^import[^\n]+\n/gm,'').replace(/export function/g,'function'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
 const rows=[{id:'shown',kind:'review_result',object_id:'a'},{id:'outside',kind:'review_pending',priority:'urgent',object_id:'b'},{id:'group',kind:'chat_message',object_id:'m'}];
 const data=reactive({account:'a',notifications:rows}),owner=ref('a'),route=reactive({name:'chat',query:{}}),verified=ref(networkReady);
 const box={left:0,top:0,right:390,bottom:500};
 const elements=rows.map(n=>({dataset:{notificationId:n.id,messageId:n.object_id},isConnected:true,box:{left:10,top:40,right:380,bottom:120},getBoundingClientRect(){return this.box;},getClientRects(){return [this.box];},contains(hit){return hit===this;}}));
 const list={isConnected:true,getBoundingClientRect:()=>box,contains:el=>elements.includes(el),querySelectorAll:()=>elements},stream=ref(list),document={visibilityState:'visible',addEventListener(_e,fn){this.wake=fn;},removeEventListener(){}};
 let observer,unmount,activate,deactivate;const calls=[];
 class IO{constructor(callback,options){this.callback=callback;this.options=options;observer=this;}observe(){}unobserve(){}disconnect(){}}
 class MO{observe(){}disconnect(){}}
 const action=async(n,action,_body,options)=>{calls.push({id:n.id,action,quiet:options.quiet});if(!fail)n.read_at=1;return !fail;};
 document.elementFromPoint=(x,y)=>elements.findLast(el=>el.isConnected&&x>=el.box.left&&x<el.box.right&&y>=el.box.top&&y<el.box.bottom)||list;
 const lifecycle=new Map();
 const deps={captureApiLease:()=>({networkReady:()=>verified.value}),useRoute:()=>route,window:{innerWidth:390,innerHeight:844},isAndroidNative:()=>native,App:{addListener:async(name,fn)=>{lifecycle.set(name,fn);return {remove:async()=>lifecycle.delete(name)};},getState:async()=>({isActive:true})},isWorkNotice,isAnnouncementNotice,watch,onBeforeUnmount:fn=>unmount=fn,onActivated:fn=>activate=fn,onDeactivated:fn=>deactivate=fn,useDataStore:()=>data,actOnNotification:action,document,IntersectionObserver:IO,MutationObserver:MO};
 const hook=new Function(...Object.keys(deps),code+';return {useVisibleChatReads,useVisibleNotificationReads};')(...Object.values(deps));
 hook[kind==='work'?'useVisibleNotificationReads':'useVisibleChatReads'](stream,owner);
 const intersect=(i,ratio=1)=>observer.callback([{target:elements[i],isIntersecting:ratio>0,intersectionRatio:ratio}]);
 return {setFailure:value=>fail=value,data,owner,route,verified,document,calls,elements,list,intersect,pause:()=>lifecycle.get('pause')?.(),resume:()=>lifecycle.get('resume')?.(),get observer(){return observer;},activate:()=>activate(),deactivate:()=>deactivate(),close:()=>unmount()};
}
test('visible work card clears read only; offscreen and group notes stay unread',async()=>{
 const f=await fixture();assert.equal(f.observer.options.root,null,'clip to viewport and scroll ancestors, not full list');
 f.intersect(0);await turn();assert.deepEqual(f.calls,[{id:'shown',action:'read',quiet:true}]);
 assert.ok(f.data.notifications[0].read_at);assert.equal(f.data.notifications[0].acked_at,undefined);
 assert.equal(f.data.notifications[1].read_at,undefined);f.intersect(2);await turn();assert.equal(f.calls.length,1);
 f.intersect(1);await turn();assert.equal(f.calls[1].id,'outside');assert.equal(f.data.notifications[1].acked_at,undefined);f.close();
});
test('background, less than half visible, deactivated view and account mismatch cannot mark read',async()=>{
 const f=await fixture();f.intersect(0,.4);await turn();assert.equal(f.calls.length,0);
 f.document.visibilityState='hidden';f.intersect(0);await turn();assert.equal(f.calls.length,0);
 f.document.visibilityState='visible';f.document.wake();await turn();assert.equal(f.calls.length,1);
 f.deactivate();f.intersect(1);await turn();assert.equal(f.calls.length,1);
 f.activate();f.owner.value='b';await turn();f.intersect(1);await turn();assert.equal(f.calls.length,1);
 f.data.account='b';await turn();assert.equal(f.calls.length,2);f.close();
});
test('failed visible reads back off and recover after more than two failures without a new intersection',async()=>{
 mock.timers.enable({apis:['setTimeout','Date']});
 const f=await fixture({fail:true});try{
 f.intersect(0);await turn();assert.equal(f.calls.length,1);assert.equal(f.data.notifications[0].read_at,undefined);
 f.intersect(0);f.document.wake();await turn();assert.equal(f.calls.length,1);
 mock.timers.tick(2000);await turn();assert.equal(f.calls.length,2);
 mock.timers.tick(4000);await turn();assert.equal(f.calls.length,3);
 f.setFailure(false);mock.timers.tick(8000);await turn();assert.equal(f.calls.length,4);assert.ok(f.data.notifications[0].read_at);
 }finally{f.close();mock.timers.reset();}
});
test('covered chat is read after the covering surface disappears without scrolling',async()=>{
 mock.timers.enable({apis:['setTimeout','Date']});const f=await fixture({kind:'chat'});try{
 const hit=f.document.elementFromPoint;f.document.elementFromPoint=()=>f.list;f.intersect(2);await turn();assert.equal(f.calls.length,0);
 f.document.elementFromPoint=hit;mock.timers.tick(500);await turn();assert.equal(f.calls.length,1);assert.ok(f.data.notifications[2].read_at);
 }finally{f.close();mock.timers.reset();}
});
test('existing chat hook still marks only visible chat messages',async()=>{
 const f=await fixture({kind:'chat'});f.intersect(0);f.intersect(2);await turn();assert.deepEqual(f.calls.map(c=>c.id),['group']);f.close();
});
async function actionFixture({fail=false}={}){
 const source=await readFile(new URL('../src/store/actions.ts',import.meta.url),'utf8');
 const code=ts.transpileModule(source.replace(/^import[^\n]+\n/gm,'').replace(/^export /gm,''),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
 let valid=true;const note={id:'n',kind:'announcement',read_at:null,persistent_float:true};
 const store={notifications:[note],unreadCount:1,captureLease:()=>({account:'a',valid:()=>valid})};
 const writes=[],toasts=[];class ApiError extends Error{}
 const lifecycle=new Map();
 const deps={isAndroidNative:()=>native,App:{addListener:async(name,fn)=>{lifecycle.set(name,fn);return {remove:async()=>lifecycle.delete(name)};},getState:async()=>({isActive:true})},isWorkNotice,useDataStore:()=>store,useUiStore:()=>({toast:(...v)=>toasts.push(v)}),putMany:async(...args)=>writes.push(structuredClone(args)),
  me:{notificationAction:async()=>{if(fail)throw Error('offline');}},newIdempotencyKey:()=> 'local-test',ApiError,withRetry:fn=>fn(),userError:e=>e.message};
 const act=new Function(...Object.keys(deps),code+';return actOnNotification;')(...Object.values(deps));
 return {act,store,note,writes,toasts};
}
test('server-confirmed visible read survives cache restart; failed read rolls back without persisting or toast',async()=>{
 const f=await actionFixture();assert.equal(await f.act(f.note,'read',{}, {quiet:true}),true);
 assert.equal(f.writes[0][0],'notifications');assert.equal(f.writes[0][1],'a');assert.ok(f.writes[0][2][0].read_at);
 assert.equal(f.writes[0][2][0].acked_at,undefined);assert.equal(f.store.unreadCount,0);
 const bad=await actionFixture({fail:true});assert.equal(await bad.act(bad.note,'read',{}, {quiet:true}),false);
 assert.equal(bad.store.notifications[0].read_at,null);assert.equal(bad.store.unreadCount,1);assert.equal(bad.writes.length,0);assert.equal(bad.toasts.length,0);
});

test('Android background arrivals stay unread even when WebView visibility remains visible',async()=>{
 const f=await fixture({kind:'chat',native:true});await turn();f.pause();f.intersect(2);await turn();
 assert.equal(f.document.visibilityState,'visible');assert.equal(f.calls.length,0);assert.equal(f.data.notifications[2].read_at,undefined);
 f.resume();await turn();assert.deepEqual(f.calls.map(c=>c.id),['group']);f.close();
});


test('a long chat message can be read from a visible part, with any number of unread messages',async()=>{
 for(const count of [1,3,25]){
  const f=await fixture({kind:'chat'});f.elements[2].box={left:10,top:40,right:380,bottom:2040};
  const original=f.data.notifications[2];f.data.notifications=Array.from({length:count},(_,i)=>({...original,id:'chat-'+i,object_id:i?'unseen-'+i:'m'}));
  f.intersect(2,.23);await turn();assert.equal(f.calls.length,1);assert.ok(f.data.notifications[0].read_at);assert.ok(f.data.notifications.slice(1).every(n=>!n.read_at));f.close();
 }
});
test('stale observer visibility cannot read scrolled-out, detached, covered or hidden chat rows',async()=>{
 for(const stale of ['outside','detached','covered','background']){
  const f=await fixture({kind:'chat'});f.document.visibilityState='hidden';f.intersect(2,.25);await turn();
  if(stale==='outside')f.elements[2].box={left:10,top:600,right:380,bottom:2600};
  if(stale==='detached')f.elements[2].isConnected=false;
  if(stale==='covered')f.document.elementFromPoint=()=>({});
  if(stale!=='background')f.document.visibilityState='visible';f.document.wake();await turn();
  assert.equal(f.calls.length,0,stale);f.close();
 }
});
test('zero-area contact is not a visible chat message',async()=>{
 const f=await fixture({kind:'chat'});f.intersect(2,0);await turn();assert.equal(f.calls.length,0);
 f.elements[2].box={left:10,top:500,right:380,bottom:2500};f.intersect(2,.01);await turn();assert.equal(f.calls.length,0);f.close();
});

test('a reused chat DOM node cannot make the previous conversation read from stale visibility',async()=>{
 const f=await fixture({kind:'chat'});f.document.visibilityState='hidden';f.intersect(2,.2);await turn();
 f.elements[2].dataset.messageId='another-conversation-message';f.document.visibilityState='visible';f.document.wake();await turn();assert.equal(f.calls.length,0);f.close();
});

test('route switch blocks the old conversation immediately, before cached DOM deactivation',async()=>{
 for(const next of [{name:'member',query:{}},{name:'chat',query:{peer:'someone-else'}}]){
  const f=await fixture({kind:'chat'});f.document.visibilityState='hidden';f.intersect(2,.2);await turn();Object.assign(f.route,next);f.document.visibilityState='visible';f.document.wake();await turn();assert.equal(f.calls.length,0);f.close();
 }
});

test('unverified cold cache consumes no read attempts and resumes when identity becomes ready without notification changes',async()=>{
 const f=await fixture({kind:'chat',networkReady:false});f.intersect(2,.2);f.document.wake();f.document.wake();await turn();assert.equal(f.calls.length,0);assert.equal(f.data.notifications[2].read_at,undefined);
 f.verified.value=true;await turn();assert.deepEqual(f.calls.map(c=>c.id),['group']);f.close();
});
