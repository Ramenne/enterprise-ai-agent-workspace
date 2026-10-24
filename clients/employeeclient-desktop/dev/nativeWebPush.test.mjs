import test from 'node:test';
import assert from 'node:assert/strict';
import {validateSubscription,createWebPushProvider} from '../server/business/web-push-provider.mjs';
const sub={endpoint:'https://web.push.apple.com/fixture',keys:{p256dh:'a'.repeat(87),auth:'b'.repeat(22)}};
test('push subscriber cannot make the server contact internal or arbitrary endpoints',()=>{
 for(const endpoint of ['https://127.0.0.1/','https://employeeclient.example.invalid/native/session','https://web.push.apple.com:444/','https://web.push.apple.com.evil.invalid/','https://user@web.push.apple.com/','http://web.push.apple.com/'])assert.throws(()=>validateSubscription({...sub,endpoint}));
 assert.equal(validateSubscription(sub).endpoint,sub.endpoint);assert.equal(validateSubscription({...sub,endpoint:'https://jmt17.google.com/push/fixture'}).endpoint,'https://jmt17.google.com/push/fixture');assert.throws(()=>validateSubscription({...sub,endpoint:'https://www.google.com/'}));
});
test('only public VAPID config leaves provider; acceptance never claims device display',async()=>{
 const cfg={version:1,android_third_party_push:false,public_key:'fixture-public',private_key:'fixture-only',subject:'mailto:fixture@example.invalid'};
 const p=createWebPushProvider(cfg,{send:async()=>({statusCode:201,body:'not exposed'})});assert.equal(p.publicConfig().web_push.application_server_key,'fixture-public');assert.equal(p.publicConfig().private_key,undefined);
 assert.deepEqual(await p.deliver(sub,{id:'n',title:'fixture',summary:'fixture'}),{state:'provider_accepted',provider_status:201,device_display:'not_asserted'});
 const expired=createWebPushProvider(cfg,{send:async()=>{throw {statusCode:410,body:'not exposed'};}});assert.equal((await expired.deliver(sub,{id:'n'})).state,'subscription_expired');
});

test('push payload supplies the exact SW identity and update fields',async()=>{
 let payload;const p=createWebPushProvider({version:1,android_third_party_push:false,public_key:'fixture-public',private_key:'fixture-only',subject:'mailto:fixture@example.invalid'},{send:async(_sub,body)=>{payload=JSON.parse(body);return {statusCode:201};}});
 await p.deliver(sub,{id:'n',recipient_actor:'actor',device_id:'binding',version:3,title:'fixture',summary:'text',snapshot:{silent:false},priority:'normal'});
 assert.equal(payload.id,'n');assert.equal(payload.recipient_username,'actor');assert.equal(payload.installation_id,'binding');assert.equal(payload.update_version,3);assert.equal(payload.summary,'有新的通知，请打开员工客户端查看');assert.equal(payload.notification_id,undefined);
});

test('registered FCM egress uses only the local proxy; other providers retain direct route',async()=>{
 const cfg={version:1,android_third_party_push:false,public_key:'fixture-public',private_key:'fixture-only',subject:'mailto:fixture@example.invalid'},calls=[];
 const provider=createWebPushProvider(cfg,{proxy:'http://127.0.0.1:17890',send:async(_sub,_body,options)=>{calls.push(options);return {statusCode:201};}});
 await provider.deliver({...sub,endpoint:'https://fcm.googleapis.com/fcm/send/fixture'},{id:'n'});assert.equal(calls[0].proxy,'http://127.0.0.1:17890');
 await provider.deliver({...sub,endpoint:'https://jmt17.google.com/push/fixture'},{id:'n'});assert.equal(calls[1].proxy,'http://127.0.0.1:17890');
 await provider.deliver(sub,{id:'n'});assert.equal(calls[2].proxy,undefined);assert.equal(provider.publicConfig().proxy,undefined);
 assert.throws(()=>createWebPushProvider(cfg,{proxy:'http://external.invalid:8080'}),/registered_push_proxy_invalid/);
});
