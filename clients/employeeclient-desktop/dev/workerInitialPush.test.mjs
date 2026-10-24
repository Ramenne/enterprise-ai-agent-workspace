import {createHash} from 'node:crypto';
import {pushTaskHarness} from './pushTaskHarness.mjs';
import {commitPushSubscription} from '../src/platform/pushSubscriptionCommit.mjs';
import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import ts from 'typescript';
import {waitForOperation} from '../src/platform/operationDeadline.mjs';
const fingerprint=createHash('sha256').update(JSON.stringify({endpoint:'synthetic',keys:{p256dh:'key',auth:'auth'}})).digest('hex');
const code=ts.transpileModule(readFileSync('src/platform/workerPushRenewal.ts','utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText.replace(/^import .*;\n/gm,'').replace(/export /g,'');
function fixture({permission='granted',failure=false,slow=false}={}){
 let identity={account:'local',installationId:'qn-'+ 'a'.repeat(64)},pending=null,subscriptions=0,posts=[],reads=0,release,clock=Date.now();
 const sub={toJSON:()=>({endpoint:'synthetic',keys:{p256dh:'key',auth:'auth'}})};
 const deps={commitPushSubscription,CLIENT_RELEASE:{versionCode:132},Date:{now:()=>clock},Notification:{permission},waitForOperation,readPushIdentity:async()=>identity,readPendingPushRenewal:async()=>pending,savePushRenewal:async(p,f)=>{if(f){identity={...identity,subscriptionFingerprint:f};pending=null;}else pending=structuredClone(p);return true;},fetch:async(path,o)=>{if(path.endsWith('push-config'))return Response.json({web_push:{application_server_key:Buffer.concat([Buffer.from([4]),Buffer.alloc(64)]).toString('base64url')}});posts.push(JSON.parse(o.body));if(failure){failure=false;return Response.json({},{status:503});}return Response.json({push_bound:true,device:{installation_id:identity.installationId,subscription_fingerprint:fingerprint}});}};
 Object.assign(deps,pushTaskHarness(deps));
 const worker=new Function(...Object.keys(deps),code+';return {renewWorkerPush};')(...Object.values(deps));
 const registration={pushManager:{getSubscription:async()=>{reads++;return subscriptions?sub:null;},subscribe:async()=>{subscriptions++;if(slow)await new Promise(r=>release=r);return sub;}}};
 return {advance:ms=>clock+=ms,release:()=>release?.(),run:()=>worker.renewWorkerPush(registration),stats:()=>({identity,pending,subscriptions,posts,reads})};
}
test('a permitted metadata-only installation creates and registers its first subscription in the worker',async()=>{const f=fixture();await f.run();assert.equal(f.stats().posts.length,1);assert.equal(f.stats().posts[0].expected_fingerprint,null);assert.equal(f.stats().subscriptions,1);assert.equal(f.stats().pending,null);assert.equal(f.stats().identity.subscriptionFingerprint,fingerprint);await f.run();assert.equal(f.stats().posts.length,1);});
test('first worker registration failure remains durable and resumes without recreating a subscription',async()=>{const f=fixture({failure:true});await f.run();assert.ok(f.stats().pending?.subscription);assert.equal(f.stats().identity.subscriptionFingerprint,undefined);await f.run();assert.equal(f.stats().posts.length,1,'failure budget blocks a second wake');f.advance(5000);await f.run();assert.equal(f.stats().posts.length,2);assert.equal(f.stats().subscriptions,1);assert.equal(f.stats().pending,null);});
for(const permission of ['default','denied'])test('worker cannot ask for permission or subscribe when permission is '+permission,async()=>{const f=fixture({permission});await f.run();assert.equal(f.stats().posts.length,0);assert.equal(f.stats().subscriptions,0);assert.equal(f.stats().pending,null);});

const turn=()=>new Promise(r=>setImmediate(r));
test('late first subscription completion wakes a fresh guarded registration after the original deadline',async t=>{t.mock.timers.enable({apis:['setTimeout']});const f=fixture({slow:true});try{const first=f.run().catch(()=>{});await turn();f.advance(12000);t.mock.timers.tick(12000);await first;assert.equal(f.stats().posts.length,0);f.release();await turn();await turn();assert.equal(f.stats().posts.length,0);f.advance(5000);await f.run();assert.equal(f.stats().posts.length,1);assert.equal(f.stats().pending,null);}finally{t.mock.timers.reset();}});
test('late subscription completion for an invalidated owner cannot publish',async t=>{t.mock.timers.enable({apis:['setTimeout']});const f=fixture({slow:true});try{const first=f.run().catch(()=>{});await turn();t.mock.timers.tick(12000);await first;f.stats().identity.account='different-owner';f.release();await turn();await turn();assert.equal(f.stats().posts.length,0);}finally{t.mock.timers.reset();}});
