import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createChatRepository} from '../server/business/chat-repository.mjs';
import {createDeviceRepository,createDeliveryDispatcher} from '../server/business/devices.mjs';
import {PROJECT} from '../server/business/native-authority.mjs';
const a={project_id:PROJECT,actor_id:'a',display_name:'A',can_read:true,can_write:true};const b={...a,actor_id:'b'};
const subscription={endpoint:'https://web.push.apple.com/fixture',keys:{p256dh:'A'.repeat(87),auth:'B'.repeat(22)}};
test('installation binding is actor scoped; Android rejects retired subscriptions and views mask keys',t=>{
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());const r=createDeviceRepository(db);
 const readOnly={...a,can_write:false};
 const first=r.bind(readOnly,{installation_id:'same-install',platform:'android_native'}),second=r.bind(b,{installation_id:'same-install',platform:'ios_web_push',subscription});
 assert.notEqual(first.device.installation_id,second.device.installation_id);assert.equal(r.list(a).devices.length,1);assert.ok(!JSON.stringify(r.list(b)).includes('p256dh'));
 assert.throws(()=>r.bind(a,{installation_id:'same-install',platform:'android_native',subscription}),/android_subscription_retired/);
 assert.throws(()=>r.revoke(a,second.device.installation_id),/device_not_found/);r.revoke(b,second.device.installation_id);assert.equal(r.list(b).devices[0].status,'revoked');
});
test('durable outbox retries through reconstructed dispatcher; revocation prevents provider calls',async t=>{
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());let stamp=100000;
 const chat=createChatRepository(db,{now:()=>stamp}),devices=createDeviceRepository(db,{now:()=>stamp});devices.bind(b,{installation_id:'ios-fixture',platform:'ios_web_push',subscription});
 chat.send(a,{body:'fixture only',mention_usernames:['b']},'send',{members:[a,b]});let calls=0,payload;
 const provider={deliver:async(_subscription,n)=>{payload=n;calls++;return calls===1?{state:'delivery_failed',retryable:true}:{state:'provider_accepted'};}};
 await createDeliveryDispatcher(db,provider,{now:()=>stamp})(async()=>[a,b]);assert.equal(calls,1);assert.equal(payload.kind,'chat_message');assert.match(payload.deep_link,/^\/business\/v1\/messages\//);assert.equal(db.prepare('SELECT state FROM push_deliveries').get().state,'retry:1');
 stamp+=10000;await createDeliveryDispatcher(db,provider,{now:()=>stamp})(async()=>[a,b]);assert.equal(calls,2);assert.equal(db.prepare('SELECT state FROM delivery_outbox').get().state,'processed');
 chat.send(a,{body:'second fixture'},'second',{members:[a,b]});await createDeliveryDispatcher(db,provider)(async()=>[a]);assert.equal(calls,2);assert.equal(db.prepare("SELECT COUNT(*) n FROM delivery_outbox WHERE state='expired'").get().n,1);
});
test('group files keep fixed attachment identity and omit hidden or recalled messages',t=>{
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());const r=createChatRepository(db);
 const attachment={id:'fixed-pair',fixed_ref:{project_id:PROJECT,material_id:'m',version_id:'v'}};
 const sent=r.send(a,{body:'file'},'file',{members:[a,b],attachments:[attachment]});assert.equal(r.files(b).files[0].id,'fixed-pair');
 r.change(b,sent.message_id,'hide','hide');assert.equal(r.files(b).files.length,0);assert.equal(r.files(a).files.length,1);
});

test('temporary null binding retains subscription, explicit revoke cannot resurrect it',t=>{
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());const repo=createDeviceRepository(db);
 const body={installation_id:'retained-pwa',platform:'ios_web_push',subscription};
 const original=repo.bind(a,body);assert.equal(original.push_bound,true);
 assert.equal(repo.bind(a,{...body,subscription:null}).push_bound,true);
 assert.equal(repo.bind(b,{...body,subscription:null}).push_bound,false,'other account cannot inherit subscription');
 repo.revoke(a,original.device.installation_id);
 assert.equal(repo.bind(a,{...body,subscription:null}).push_bound,false,'revoked subscription stays gone');
 assert.equal(repo.bind(a,body).push_bound,true,'fresh explicit subscription binds again');
});

test('long transient push outage retains durable retry and recovers after more than five failures',async t=>{
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());let stamp=100000,calls=0;
 const chat=createChatRepository(db,{now:()=>stamp}),devices=createDeviceRepository(db,{now:()=>stamp});devices.bind(b,{installation_id:'long-outage',platform:'ios_web_push',subscription});
 chat.send(a,{body:'isolated durable retry'},'long-outage',{members:[a,b]});
 const provider={deliver:async()=>{calls++;return calls<=7?{state:'delivery_failed',retryable:true,transport_error:'ETIMEDOUT'}:{state:'provider_accepted',provider_status:201};}};
 for(let i=0;i<7;i++){await createDeliveryDispatcher(db,provider,{now:()=>stamp})(async()=>[a,b]);assert.match(db.prepare('SELECT state FROM push_deliveries').get().state,/^retry:/);assert.equal(db.prepare('SELECT state FROM delivery_outbox').get().state,'failed');stamp+=360000;}
 assert.equal(db.prepare('SELECT error_code FROM push_deliveries').get().error_code,'ETIMEDOUT');
 await createDeliveryDispatcher(db,provider,{now:()=>stamp})(async()=>[a,b]);assert.equal(calls,8);assert.equal(db.prepare('SELECT state FROM push_deliveries').get().state,'provider_accepted');assert.equal(db.prepare('SELECT state FROM delivery_outbox').get().state,'processed');
});

test('worker renewal is account scoped, CAS guarded, idempotent and cannot reactivate revoked devices',t=>{
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());const repo=createDeviceRepository(db);
 const initial=repo.bind(a,{installation_id:'rotate-pwa',platform:'ios_web_push',subscription});
 const id=initial.device.installation_id,revision=initial.device.subscription_fingerprint;
 const next={...subscription,endpoint:'https://web.push.apple.com/rotated'},body={expected_fingerprint:revision,subscription:next};
 assert.throws(()=>repo.renew(b,id,body),/device_not_active/);
 const renewed=repo.renew(a,id,body);assert.notEqual(renewed.device.subscription_fingerprint,revision);
 assert.equal(repo.renew(a,id,body).device.subscription_fingerprint,renewed.device.subscription_fingerprint,'lost response retry succeeds');
 assert.throws(()=>repo.renew(a,id,{...body,subscription:{...next,endpoint:'https://web.push.apple.com/stale'}}),/subscription_revision_changed/);
 repo.revoke(a,id);assert.throws(()=>repo.renew(a,id,body),/device_not_active/);
});
test('expired browser subscription remains renewable and retries its still-unread outbox',async t=>{
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());const chat=createChatRepository(db),repo=createDeviceRepository(db);
 const initial=repo.bind(b,{installation_id:'expired-pwa',platform:'ios_web_push',subscription});
 chat.send(a,{body:'ordinary unread after subscription expiry'},'expiry',{members:[a,b]});
 await createDeliveryDispatcher(db,{deliver:async()=>({state:'subscription_expired',provider_status:410})})(async()=>[a,b]);
 assert.equal(repo.list(b).devices[0].status,'active');assert.equal(repo.list(b).devices[0].push_subscription,false);
 repo.renew(b,initial.device.installation_id,{expected_fingerprint:initial.device.subscription_fingerprint,subscription:{...subscription,endpoint:'https://web.push.apple.com/replacement'}});
 let delivered=0;await createDeliveryDispatcher(db,{deliver:async()=>{delivered++;return {state:'provider_accepted'};}})(async()=>[a,b]);
 assert.equal(delivered,1);assert.equal(db.prepare('SELECT state FROM push_deliveries').get().state,'provider_accepted');
});

test('late expiry for an in-flight old subscription cannot lose the newly renewed delivery',async t=>{
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());const chat=createChatRepository(db),repo=createDeviceRepository(db);
 const initial=repo.bind(b,{installation_id:'rotate-in-flight',platform:'ios_web_push',subscription});chat.send(a,{body:'unread during rotation'},'race',{members:[a,b]});
 let release;const waiting=new Promise(r=>{release=r;});let started;const began=new Promise(r=>{started=r;});
 const drain=createDeliveryDispatcher(db,{deliver:async()=>{started();return waiting;}});const attempt=drain(async()=>[a,b]);await began;
 const next={...subscription,endpoint:'https://web.push.apple.com/new-during-send'};repo.renew(b,initial.device.installation_id,{expected_fingerprint:initial.device.subscription_fingerprint,subscription:next});
 release({state:'subscription_expired',provider_status:410});await attempt;
 assert.equal(repo.list(b).devices[0].push_subscription,true);assert.equal(db.prepare('SELECT state FROM push_deliveries').get().state,'queued');
 let received;await createDeliveryDispatcher(db,{deliver:async sub=>{received=sub.endpoint;return {state:'provider_accepted'};}})(async()=>[a,b]);assert.equal(received,next.endpoint);
});

test('a permanently expired subscription cannot be rebound as success, but replacement restores unread delivery',async t=>{
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());const chat=createChatRepository(db),repo=createDeviceRepository(db);
 const body={installation_id:'expired-rebind-loop',platform:'ios_web_push',subscription};const original=repo.bind(b,body);
 chat.send(a,{body:'still unread through invalid subscription'},'expired-rebind',{members:[a,b]});
 await createDeliveryDispatcher(db,{deliver:async()=>({state:'subscription_expired',provider_status:410})})(async()=>[a,b]);
 assert.throws(()=>repo.bind(b,body),e=>e.code==='push_subscription_expired'&&e.status===409);
 assert.throws(()=>repo.renew(b,original.device.installation_id,{expected_fingerprint:original.device.subscription_fingerprint,subscription}),/push_subscription_expired/);
 assert.equal(repo.list(b).devices[0].push_subscription,false,'rejection must not falsely rebind the endpoint');
 const next={...subscription,endpoint:'https://web.push.apple.com/fresh-after-rejection'};assert.equal(repo.bind(b,{...body,subscription:next}).push_bound,true);
 let target;await createDeliveryDispatcher(db,{deliver:async sub=>{target=sub.endpoint;return {state:'provider_accepted'};}})(async()=>[a,b]);assert.equal(target,next.endpoint);
 assert.equal(db.prepare('SELECT state FROM delivery_outbox').get().state,'processed');
});

test('worker may fill a missing first subscription without a fingerprint, but cannot overwrite a newer one or another account',t=>{
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());createChatRepository(db);const repo=createDeviceRepository(db),empty=repo.bind(a,{installation_id:'first-pwa',platform:'ios_web_push'}),id=empty.device.installation_id;
 assert.equal(empty.push_bound,false);const body={expected_fingerprint:null,subscription};assert.throws(()=>repo.renew(b,id,body),/device_not_active/);
 const bound=repo.renew(a,id,body);assert.equal(bound.push_bound,true);assert.equal(repo.renew(a,id,body).device.subscription_fingerprint,bound.device.subscription_fingerprint);
 assert.throws(()=>repo.renew(a,id,{...body,subscription:{...subscription,endpoint:'https://web.push.apple.com/other'}}),/subscription_revision_changed/);
 assert.throws(()=>repo.renew(a,id,{subscription}),/invalid_subscription_revision/);
 repo.revoke(a,id);assert.throws(()=>repo.renew(a,id,body),/device_not_active/);
});
