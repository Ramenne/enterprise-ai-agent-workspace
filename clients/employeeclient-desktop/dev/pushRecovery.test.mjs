import test from 'node:test';import assert from 'node:assert/strict';
import {bindPushPermissionRequest,bindPushRecovery} from '../src/platform/pushRecovery.mjs';
const turn=()=>new Promise(r=>setImmediate(r));
function fixture(){const page=new EventTarget(),host=new EventTarget(),worker=new EventTarget(),calls=[];let ready;worker.ready=new Promise(r=>ready=r);page.visibilityState='visible';const stop=bindPushRecovery(force=>calls.push(force),{page,host,worker});return {page,host,worker,calls,ready,stop};}
test('mobile resume, restored page, network and delayed SW readiness repair without focus',async()=>{
 const f=fixture();assert.deepEqual(f.calls,[false]);f.page.visibilityState='hidden';f.page.dispatchEvent(new Event('visibilitychange'));assert.equal(f.calls.length,1);
 f.page.visibilityState='visible';f.page.dispatchEvent(new Event('visibilitychange'));f.host.dispatchEvent(new Event('pageshow'));f.host.dispatchEvent(new Event('online'));f.worker.dispatchEvent(new Event('controllerchange'));f.ready();await turn();assert.deepEqual(f.calls,[false,false,false,false,false,false]);
 f.stop();f.host.dispatchEvent(new Event('focus'));f.page.dispatchEvent(new Event('visibilitychange'));assert.equal(f.calls.length,6);
});
test('subscription rotation while hidden forces a fresh bind on next resume and ignores unrelated messages',()=>{
 const f=fixture();f.page.visibilityState='hidden';f.worker.dispatchEvent(new MessageEvent('message',{data:{type:'qn-push-subscription-change'}}));assert.equal(f.calls.length,1);
 f.page.visibilityState='visible';f.page.dispatchEvent(new Event('visibilitychange'));assert.equal(f.calls.at(-1),true);
 f.worker.dispatchEvent(new MessageEvent('message',{data:{type:'qn-deeplink'}}));assert.equal(f.calls.length,2);f.stop();
});
test('a late SW readiness callback after disposal cannot repair the destroyed page',async()=>{const f=fixture();f.stop();f.ready();await turn();assert.equal(f.calls.length,1);});

function permissionFixture(){const page=new EventTarget();page.visibilityState='visible';let allowed=false,permission='default',calls=0,completed=0,resolve;const stop=bindPushPermissionRequest({page,allowed:()=>allowed,isDefault:()=>permission==='default',request:()=>{calls++;return new Promise(r=>resolve=r);},complete:()=>completed++});const click=(trusted=true)=>{const event=new Event('pointerup');Object.defineProperty(event,'isTrusted',{value:trusted});page.dispatchEvent(event);};return {page,stop,click,ready:()=>allowed=true,deny:()=>permission='denied',resolve:()=>resolve?.('granted'),stats:()=>({calls,completed})};}
test('restored login asks once inside a trusted interaction, never while anonymous or hidden',async()=>{const f=permissionFixture();f.click();assert.equal(f.stats().calls,0);f.ready();f.click(false);assert.equal(f.stats().calls,0);f.page.visibilityState='hidden';f.click();assert.equal(f.stats().calls,0);f.page.visibilityState='visible';f.click();assert.equal(f.stats().calls,1,'request is synchronous, before activation expires');f.click();assert.equal(f.stats().calls,1);f.resolve();await turn();assert.equal(f.stats().completed,1);f.stop();});
test('denial is respected and a destroyed page cannot start binding from a late permission result',async()=>{const denied=permissionFixture();denied.ready();denied.deny();denied.click();assert.equal(denied.stats().calls,0);denied.stop();const late=permissionFixture();late.ready();late.click();late.stop();late.resolve();await turn();assert.equal(late.stats().completed,0);});

test('notification permission changes wake visible recovery and coalesce while hidden',async()=>{
 const page=new EventTarget(),host=new EventTarget(),worker=new EventTarget(),status=new EventTarget(),calls=[];page.visibilityState='visible';let queries=0;
 const stop=bindPushRecovery(force=>calls.push(force),{page,host,worker,permissions:{query:async({name})=>{assert.equal(name,'notifications');queries++;return status;}}});await turn();status.dispatchEvent(new Event('change'));assert.deepEqual(calls,[false,true]);page.visibilityState='hidden';status.dispatchEvent(new Event('change'));assert.equal(calls.length,2);page.visibilityState='visible';page.dispatchEvent(new Event('visibilitychange'));assert.deepEqual(calls,[false,true,true]);assert.equal(queries,1);stop();status.dispatchEvent(new Event('change'));assert.equal(calls.length,3);
});
test('unsupported permission queries and late permission results never arm retries or revive disposed recovery',async()=>{
 const page=new EventTarget(),host=new EventTarget(),worker=new EventTarget(),status=new EventTarget();page.visibilityState='visible';let calls=0,resolve;
 const stop=bindPushRecovery(()=>calls++,{page,host,worker,permissions:{query:()=>new Promise(r=>resolve=r)}});stop();resolve(status);await turn();status.dispatchEvent(new Event('change'));assert.equal(calls,1);
 const release=bindPushRecovery(()=>calls++,{page,host,worker,permissions:{query:async()=>{throw Error('unsupported descriptor');}}});await turn();assert.equal(calls,2);host.dispatchEvent(new Event('online'));assert.equal(calls,3);release();
});
