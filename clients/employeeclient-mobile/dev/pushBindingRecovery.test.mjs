import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import ts from 'typescript';
const key=Buffer.concat([Buffer.from([4]),Buffer.alloc(64,1)]).toString('base64url');
function fixture({permission='granted',readError=null,subscribeError=null,configError=null,publicKey=key,existing=null}={}){
 let reads=0,subscribes=0,configs=0;const order=[];
 class ApiError extends Error{}
 const notify={permission,requestPermission:async()=>{order.push('permission');notify.permission='granted';return 'granted';}};
 const deps={ApiError,Notification:notify,hasWebPushSupport:()=>true,isAndroidNative:()=>false,devicePlatform:()=> 'ios_web_push',apiRequest:async()=>{configs++;order.push('config');if(configError)throw configError;return {web_push:{supported:true,application_server_key:publicKey}};},navigator:{serviceWorker:{ready:Promise.resolve({pushManager:{getSubscription:async()=>{reads++;if(readError)throw readError;return existing;},subscribe:async()=>{subscribes++;if(subscribeError)throw subscribeError;return {toJSON:()=>({endpoint:'synthetic-only'})};}}})}}};
 const code=ts.transpileModule(readFileSync(new URL('../src/platform/push.ts',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText.replace(/^import .*;\r?\n/gm,'').replace(/export /g,'');
 const model=new Function(...Object.keys(deps),code+';return {getPushSubscription,lastPushAvailability};')(...Object.values(deps));return {...model,stats:()=>({reads,subscribes,configs,order})};
}
test('user permission is requested before waiting for config; valid subscription is returned',async()=>{
 const f=fixture({permission:'default'});assert.ok(await f.getPushSubscription(true));assert.deepEqual(f.stats().order,['permission','config']);assert.equal(f.lastPushAvailability().available,true);
});
test('config failures and invalid key are distinct and do not create subscriptions',async()=>{
 const transient=fixture({configError:Error('offline')});assert.equal(await transient.getPushSubscription(false),null);assert.equal(transient.lastPushAvailability().code,'config_unavailable');assert.equal(transient.lastPushAvailability().retryable,true);
 const invalid=fixture({publicKey:'invalid'});assert.equal(await invalid.getPushSubscription(false),null);assert.equal(invalid.lastPushAvailability().code,'config_invalid');assert.equal(invalid.stats().subscribes,0);
});
test('denied permission never prompts automatically and transient subscription reads remain retryable',async()=>{
 const denied=fixture({permission:'denied'});assert.equal(await denied.getPushSubscription(false),null);assert.equal(denied.lastPushAvailability().code,'permission_denied');assert.equal(denied.lastPushAvailability().retryable,false);assert.equal(denied.stats().configs,0);
 const read=fixture({readError:Error('temporary')});assert.equal(await read.getPushSubscription(false),null);assert.equal(read.lastPushAvailability().code,'subscription_read_failed');assert.equal(read.lastPushAvailability().retryable,true);
});
test('valid existing subscription is retained while configuration server is unavailable',async()=>{
 const f=fixture({existing:{toJSON:()=>({endpoint:'synthetic-only'})},configError:Error('offline')});assert.ok(await f.getPushSubscription(false));assert.equal(f.stats().configs,0);assert.equal(f.stats().subscribes,0);
});

test('browser subscription refusals remain distinct from transient aborts',async()=>{
 const denial=fixture({subscribeError:new DOMException('test','NotAllowedError')});await denial.getPushSubscription(false);assert.equal(denial.lastPushAvailability().code,'subscription_denied');assert.equal(denial.lastPushAvailability().retryable,false);
 const abort=fixture({subscribeError:new DOMException('test','AbortError')});await abort.getPushSubscription(false);assert.equal(abort.lastPushAvailability().code,'subscription_aborted');assert.equal(abort.lastPushAvailability().retryable,true);
});

test('confirmed rejected subscription is replaced, while a different current subscription is preserved',async()=>{
 const rejected={endpoint:'https://web.push.apple.com/old',keys:{auth:'old-auth',p256dh:'old-key'}};let removals=0;
 const old={toJSON:()=>rejected,unsubscribe:async()=>{removals++;return true;}};
 const f=fixture({existing:old});assert.ok(await f.getPushSubscription(false,rejected));assert.equal(removals,1);assert.equal(f.stats().subscribes,1);
 const changed=fixture({existing:{toJSON:()=>({...rejected,endpoint:'https://web.push.apple.com/new'}),unsubscribe:async()=>{throw Error('must preserve new subscription');}}});assert.ok(await changed.getPushSubscription(false,rejected));assert.equal(changed.stats().subscribes,0);
 const stale=fixture({existing:old});assert.equal(await stale.getPushSubscription(false,rejected,()=>false),null);assert.equal(removals,1,'account change must not unsubscribe');
});
