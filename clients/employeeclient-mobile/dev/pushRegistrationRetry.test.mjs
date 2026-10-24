import {commitPushSubscription} from '../src/platform/pushSubscriptionCommit.mjs';
import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import ts from 'typescript';
import {createRecoveryGate as realGate} from '../src/platform/recoveryGate.mjs';
import {waitForOperation} from '../src/platform/operationDeadline.mjs';
const source=readFileSync(new URL('../src/session/store.ts',import.meta.url),'utf8');
const code=ts.transpileModule(source.slice(source.indexOf(' function retryPushBinding(ticket:'),source.indexOf('\n return {restoreCachedWorkspace')),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
function fixture({failures=1,hang=null,permission="granted"}={}){
 return new Function('crypto','realGate','waitForOperation','commitPushSubscription',`let generation=1,pushRetryTicket=null,pushCheckedAt=1000,pushFlight=null,pushRecheckTicket=null,requests=0,remaining=${failures},release,hang=${JSON.stringify(hang)},subReads=0,metadataWrites=0;const scheduled=new Map();let nextTimer=0;let stamp=1100;const Date={now:()=>stamp},Notification={permission:${JSON.stringify(permission)}},businessReady={value:true},user={value:{username:'a'}},pushBound={value:true},pushReason={value:''},installationId={value:'isolated-install'};
 const claimPushTask=async()=>({pending:{identity:{account:'a',installationId:'isolated-device'}}}),failPushTask=async()=>{},savePushRenewal=async()=>true,ensureNotificationPermission=async()=>Notification.permission;const hasWebPushSupport=()=>true,isAndroidNative=()=>false,isOnline=()=>true,setTimeout=(fn,delay)=>{const id=++nextTimer;scheduled.set(id,{fn,delay});return id;},clearTimeout=id=>scheduled.delete(id),devicePlatform=()=> 'ios_web_push',getPushSubscription=async()=>{subReads++;if(hang==='subscription'){hang=null;await new Promise(r=>release=r);}return Notification.permission==='granted'?{subscription:{endpoint:'isolated'}}:null;},lastPushAvailability=()=>({code:'permission_default',reason:'',retryable:false}),explain=e=>e.code,scheduleWorkerPushRetry=async()=>{},setPushIdentity=async()=>{metadataWrites++;if(hang==='metadata'){hang=null;await new Promise(r=>release=r);}};
 const readPushIdentity=async()=>({account:'a',installationId:'isolated-device'}),readCurrentPushSubscription=async()=>({endpoint:'isolated'}),pushDiagnostic=()=>({});
 const createRecoveryGate=options=>realGate({...options,now:Date.now,setTimer:setTimeout,clearTimer:clearTimeout});
 class ApiError extends Error{constructor(){super();this.status=503;this.code='upstream_unavailable';}}const apiRequest=async()=>{requests++;if(remaining-->0)throw new ApiError();return {state:'bound',push_bound:true,device:{installation_id:'isolated-device'}};};
 ${code}
 return {release:()=>release?.(),grant:()=>{Notification.permission='granted';},sync:syncPushBinding,stats:()=>({requests,subReads,metadataWrites,bound:pushBound.value,timers:[...scheduled.values()].map(t=>t.delay)}),changeAccount:()=>{generation++;user.value={username:'b'};},tick:async()=>{const entry=scheduled.entries().next().value;if(entry){scheduled.delete(entry[0]);stamp+=entry[1].delay;entry[1].fn();}for(let i=0;i<70;i++)await Promise.resolve();}};`)(crypto,realGate,waitForOperation,commitPushSubscription);
}
test('forced registration503 must retry within success-cache window and then resume normal caching',async()=>{
 const f=fixture();assert.equal(await f.sync(false,true),false);assert.deepEqual(f.stats().timers,[5000]);await f.tick();assert.equal(f.stats().requests,2);assert.equal(f.stats().bound,true);assert.deepEqual(f.stats().timers,[]);assert.equal(await f.sync(false),true);assert.equal(f.stats().requests,2);
});
test('repeated temporary failures keep bounded backoff until the binding is verified',async()=>{
 const f=fixture({failures:3});await f.sync(false,true);assert.deepEqual(f.stats().timers,[5000]);await f.tick();assert.deepEqual(f.stats().timers,[10000]);await f.tick();assert.deepEqual(f.stats().timers,[20000]);await f.tick();assert.equal(f.stats().requests,4);assert.equal(f.stats().bound,true);assert.deepEqual(f.stats().timers,[]);
});
test('an account generation change cancels the old registration retry',async()=>{
 const f=fixture();await f.sync(false,true);f.changeAccount();await f.tick();assert.equal(f.stats().requests,1);assert.deepEqual(f.stats().timers,[]);
});

test('page wakeups and repeated expiration hints cannot bypass a failed registration deadline',async()=>{
 const f=fixture({failures:2});await f.sync(false,true);for(let i=0;i<20;i++)await f.sync(false,i%2===0);
 assert.equal(f.stats().requests,1);assert.deepEqual(f.stats().timers,[5000]);await f.tick();assert.equal(f.stats().requests,2);assert.deepEqual(f.stats().timers,[10000]);await f.tick();assert.equal(f.stats().requests,3);assert.equal(f.stats().bound,true);
});

for(const hang of ['subscription','metadata'])test('total registration deadline releases '+hang+' and late work cannot mark it bound',async()=>{
 const f=fixture({failures:0,hang}),first=f.sync(false,true);for(let i=0;i<15;i++)await Promise.resolve();assert.deepEqual(f.stats().timers,[30000]);
 await f.tick();assert.equal(await first,false);assert.equal(f.stats().bound,false);assert.deepEqual(f.stats().timers,[5000]);const requests=f.stats().requests;
 f.release();for(let i=0;i<25;i++)await Promise.resolve();assert.equal(f.stats().requests,requests);assert.equal(f.stats().bound,false);
 await f.tick();assert.equal(f.stats().bound,true);assert.equal(f.stats().requests,requests+1);
});
test('twenty in-flight force events coalesce and do not race a failed registration',async()=>{
 const f=fixture({failures:1});const first=f.sync(false,true);for(let i=0;i<20;i++)void f.sync(false,true);await first;for(let i=0;i<20;i++)await Promise.resolve();assert.equal(f.stats().requests,1);assert.deepEqual(f.stats().timers,[5000]);await f.tick();assert.equal(f.stats().requests,2);assert.equal(f.stats().bound,true);
});
test('permissionless metadata bind is cached, but granting permission immediately resumes subscription binding',async()=>{
 const f=fixture({failures:0,permission:'default'});assert.equal(await f.sync(false,true),false);for(let i=0;i<20;i++)await f.sync(false);assert.equal(f.stats().requests,1);assert.deepEqual(f.stats().timers,[]);f.grant();assert.equal(await f.sync(false),true);assert.equal(f.stats().requests,2);
});
