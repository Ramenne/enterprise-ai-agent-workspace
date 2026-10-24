import {commitPushSubscription} from '../src/platform/pushSubscriptionCommit.mjs';
import {waitForOperation} from '../src/platform/operationDeadline.mjs';
import {createRecoveryGate as realRecoveryGate} from '../src/platform/recoveryGate.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import ts from 'typescript';
import {userError} from '../src/domain/userError.mjs';
import {ref,computed} from 'vue';
const turn=()=>new Promise(r=>setImmediate(r));
async function fixture({workspace=null,sessionDelay=null,bootstrapError=null,domainFailure=false,sessionError=null,notificationDelay=null,announcementChange=false,push=null,pushDelay=null,pushFailure=false}={}){
 let pushReads=0,bindings=0;let pokes=0,sessions=0,bootstraps=0,live=0,notificationReads=0,chatReads=0,hooks;const listFlags=[],accounts=[],config={},timers=new Map();let timerId=0,now=Date.now();
 class NativeError extends Error{constructor(code,status=0){super(code);this.code=code;this.status=status;}}
 class ApiError extends NativeError{}
 class NativeClient{
  reset(){} async session(){sessions++;if(sessionError){const failure=sessionError;sessionError=null;throw new NativeError('session_read_failed',failure);}if(sessionDelay)await sessionDelay;return {identity:{actor_id:'synthetic-A'},user:{name:'A'}};}
  async signIn(){return this.session();} async sendCode(){}
 }
 const data={chatRevision:0,announcementRevision:0,setMainControl(){},setAccount:a=>accounts.push(a),hydrateFromCache:async()=>{},syncAll:()=>new Promise(()=>{}),syncNotifications:async()=>{notificationReads++;if(announcementChange)data.announcementRevision++;if(notificationDelay)await notificationDelay;return [];},syncLists:(_actor,changed=false)=>{listFlags.push(changed);return domainFailure?Promise.reject(new ApiError('domain_forbidden',403)):Promise.resolve();}};
 const chat={setAccount:async()=>{},refreshMembers:async()=>{},refresh:()=>{chatReads++;return domainFailure?Promise.reject(new ApiError('domain_forbidden',403)):new Promise(()=>{});}};
 const key='__session_'+Math.random().toString(36).slice(2);
 globalThis[key]={claimPushTask:async()=>({pending:{identity:{account:'synthetic-A',installationId:'synthetic-device'}}}),failPushTask:async()=>{},savePushRenewal:async()=>true,commitPushSubscription,pushDiagnostic:()=>({}),readPushIdentity:async()=>({account:'synthetic-A',installationId:'synthetic-device'}),readCurrentPushSubscription:async()=>push?.subscription||null,waitForOperation,Date:{now:()=>now},hasWebPushSupport:()=>true,Notification:{permission:'granted'},isAndroidNative:()=>false,requestMessageAccess:async()=>{},ensureNotificationPermission:async()=> 'granted',noteVerifiedTransportIdentity:()=>{},readWorkspaceResume:()=>workspace,rememberWorkspace:()=>{},forgetWorkspace:()=>{},deviceLoginStorage:{restore:async()=>{},save:async()=>{},clear:async()=>{}},userError,notifyChatWake:()=>{},clearChatTransfers:()=>{},rememberEmail:()=>{},ref,computed,defineStore:(_name,setup)=>setup,NativeClient,NativeError,ApiError,serviceOrigin:()=>'',configureApi:patch=>Object.assign(config,patch),isOnline:()=>true,pokeLiveLink:()=>{pokes++;},restartVerifiedTransport:()=>{pokes++;},startLiveLink:h=>{live++;hooks=h;},stopLiveLink(){},useDataStore:()=>data,useChatStore:()=>chat,setPushIdentity:async()=>{},installationPushIdentity:async(account,installationId)=>({account,installationId}),metaGet:async()=>true,metaSet:async()=>{},scheduleWorkerPushRetry:async()=>{},getPushSubscription:async()=>{pushReads++;if(pushDelay)await pushDelay;return push;},lastPushAvailability:()=>({reason:'temporary subscription failure',retryable:true}),getInstallationId:()=>'',devicePlatform:()=>'',localStorage:{removeItem(){}},setTimeout:(r,ms)=>{if(ms===800||ms===2000){r();return 0;}timers.set(++timerId,r);return timerId;},clearTimeout:id=>timers.delete(id),apiRequest:async(method,path)=>{if(path==='/business/v1/devices'){bindings++;if(pushFailure){pushFailure=false;throw new ApiError('unavailable',503);}return {state:'bound',push_bound:!!push,device:{installation_id:'synthetic-device'}};}bootstraps++;if(bootstrapError)throw new ApiError('forbidden',bootstrapError);return {actor_id:'synthetic-A',can_read:true,can_write:false,capabilities:{events:true,devices:false}};}};
 const input=await readFile(new URL('../src/session/store.ts',import.meta.url),'utf8');
 const code=ts.transpileModule(input,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText.replace(/^import .*;\n/gm,'');
 globalThis[key].createRecoveryGate=o=>realRecoveryGate({...o,now:()=>now,setTimer:globalThis[key].setTimeout,clearTimer:globalThis[key].clearTimeout});
 const names=Object.keys(globalThis[key]).join(',');
 const module=await import('data:text/javascript;base64,'+Buffer.from(`const {${names}}=globalThis[${JSON.stringify(key)}];\n`+code).toString('base64'));
 const store=module.useSessionStore();delete globalThis[key];
 return {store,accounts,advance:ms=>now+=ms,retryCount:()=>timers.size,retry:()=>{const [id,fn]=timers.entries().next().value||[];if(fn){timers.delete(id);fn();}},rejectBusiness:()=>config.onUnauthorized(),rejectTransport:()=>hooks.onAuthLost(new ApiError('auth',401)),setSessionError:status=>sessionError=status,setBootstrapError:status=>bootstrapError=status,tick:(mode,hint)=>hooks.onTick(mode,hint),setPush:sub=>push=sub,stats:()=>({pushReads,bindings,pokes,sessions,bootstraps,live,notificationReads,chatReads,listFlags:[...listFlags],epoch:config.getEpoch?.()})};
}
test('parallel restore calls share startup and open the page before network catch-up finishes',async()=>{
 let release;const gate=new Promise(r=>release=r);const f=await fixture({sessionDelay:gate});
 const a=f.store.restore(),b=f.store.restore();await turn();assert.equal(f.stats().sessions,1);release();
 assert.deepEqual(await Promise.all([a,b]),[true,true]);assert.equal(f.stats().bootstraps,1);assert.equal(f.stats().live,1);assert.equal(f.store.businessReady.value,true);
});
test('login reuses the verified sign-in identity rather than requesting another session',async()=>{
 const f=await fixture();assert.equal(await f.store.login('synthetic@example.invalid','000000'),true);assert.equal(f.stats().sessions,1);
});
test('business rejection is not reported as successful login or an online workspace',async()=>{
 const f=await fixture({bootstrapError:403});assert.equal(await f.store.login('synthetic@example.invalid','000000'),false);assert.equal(f.store.businessReady.value,false);assert.equal(f.store.status.value,'unbound');assert.equal(f.stats().live,0);
});

test('announcement/chat failure or delay does not block notification catch-up or revoke the valid member session',async()=>{
 const failed=await fixture({domainFailure:true});await failed.store.restore();await failed.tick('catchup');await turn();assert.equal(failed.stats().notificationReads,1);assert.equal(failed.store.status.value,'online');assert.equal(failed.store.businessReady.value,true);
 const delayed=await fixture();await delayed.store.restore();await delayed.tick('catchup');assert.equal(delayed.stats().notificationReads,1);assert.equal(delayed.store.businessReady.value,true);
});

test('restore during explicit login shares that login rather than invalidating its generation',async()=>{
 let release;const gate=new Promise(r=>release=r),f=await fixture({sessionDelay:gate});const login=f.store.login('synthetic@example.invalid','000000');await turn();const restore=f.store.restore();assert.equal(f.stats().sessions,1);release();assert.deepEqual(await Promise.all([login,restore]),[true,true]);assert.equal(f.stats().sessions,1);assert.equal(f.stats().bootstraps,1);
});
test('temporary bootstrap failure preserves authorized account cache instead of treating it as rejection',async()=>{
 const f=await fixture();await f.store.restore();f.accounts.length=0;f.setBootstrapError(503);assert.equal(await f.store.restore(true),false);assert.equal(f.store.status.value,'recovering');assert.ok(f.store.user.value);assert.ok(!f.accounts.includes(''));assert.equal(f.store.businessWritable.value,false);
});

test('temporary cold identity failure retries the same cookie without requiring an OTP',async()=>{
 const f=await fixture({sessionError:503});assert.equal(await f.store.restore(),true);assert.equal(f.stats().sessions,2);assert.equal(f.store.status.value,'online');
});
test('actual expired identity opens authentication without retrying into a valid account',async()=>{
 const f=await fixture({sessionError:401});assert.equal(await f.store.restore(),false);assert.equal(f.stats().sessions,1);assert.equal(f.store.status.value,'anonymous');assert.equal(f.store.user.value,null);
});

test('warm recovery retains the same verified account lease for kept pages',async()=>{
 const f=await fixture();await f.store.restore();const epoch=f.stats().epoch;await f.store.restore();assert.equal(f.stats().epoch,epoch);
});
test('chat event starts chat reading before a slow inbox completes, without duplicate chat reads',async()=>{
 let release;const gate=new Promise(r=>release=r),f=await fixture({notificationDelay:gate});await f.store.restore();
 const before=f.stats().chatReads;const pending=f.tick('live',{kinds:['chat_message'],conversationPeers:['']});await turn();assert.equal(f.stats().chatReads,before+1);release();await pending;assert.equal(f.stats().chatReads,before+1);
});


test('business 401 rechecks the member and does not discard a valid persistent identity',async()=>{
 const f=await fixture();await f.store.restore();f.accounts.length=0;f.setBootstrapError(401);f.rejectBusiness();await turn();await turn();
 assert.equal(f.store.user.value?.username,'synthetic-A');assert.equal(f.store.status.value,'online');assert.ok(!f.accounts.includes(''));assert.equal(f.stats().bootstraps,1);assert.equal(f.stats().live,1);
});
test('only authoritative member rejection expires the warm login',async()=>{
 const f=await fixture();await f.store.restore();f.setSessionError(401);f.rejectBusiness();await turn();await turn();
 assert.equal(f.store.user.value,null);assert.equal(f.store.status.value,'expired');assert.ok(f.accounts.includes(''));
});

test('repeated warm returns reuse the verified workspace without identity or bootstrap rereads',async()=>{
 const f=await fixture();await f.store.restore();const initial=f.stats();for(let n=0;n<20;n++)assert.equal(await f.store.restore(),true);
 assert.equal(f.stats().sessions,initial.sessions);assert.equal(f.stats().bootstraps,initial.bootstraps);assert.equal(f.stats().live,initial.live);
});
test('repeated domain rejections never rebuild avatar/account stores or message subscriptions',async()=>{
 const f=await fixture();await f.store.restore();f.accounts.length=0;for(let n=0;n<8;n++){f.rejectBusiness();await turn();}
 assert.equal(f.stats().bootstraps,1);assert.equal(f.stats().live,1);assert.equal(f.accounts.length,0);assert.equal(f.store.user.value.username,'synthetic-A');
});
test('transport auth recovery keeps workspace and bounds reconnection attempts',async()=>{
 const f=await fixture();await f.store.restore();f.accounts.length=0;for(let n=0;n<5;n++){f.rejectTransport();await turn();}
 assert.equal(f.stats().bootstraps,1);assert.equal(f.stats().live,1);assert.equal(f.stats().pokes,3);assert.equal(f.accounts.length,0);
});

test('transient identity outage retains rejected transport recovery and retries without rebuilding workspace',async()=>{
 const f=await fixture();await f.store.restore();const epoch=f.stats().epoch;f.setSessionError(503);f.rejectTransport();await turn();
 assert.equal(f.store.status.value,'recovering');assert.equal(f.stats().pokes,0);assert.equal(f.retryCount(),1);
 f.retry();await turn();assert.equal(f.store.status.value,'online');assert.equal(f.stats().pokes,1);assert.equal(f.stats().bootstraps,1);assert.equal(f.stats().epoch,epoch);assert.equal(f.retryCount(),0);
});
test('confirmed credential rejection cancels pending recovery instead of retrying revoked identity',async()=>{
 const f=await fixture();await f.store.restore();f.setSessionError(503);f.rejectTransport();await turn();assert.equal(f.retryCount(),1);
 f.setSessionError(401);f.rejectBusiness();await turn();assert.equal(f.store.status.value,'recovering');f.retry();await turn();assert.equal(f.store.status.value,'expired');assert.equal(f.retryCount(),0);assert.equal(f.stats().pokes,0);
});

test('authoritative project rejection cancels pending transport recovery',async()=>{
 const f=await fixture();await f.store.restore();f.setSessionError(503);f.rejectTransport();await turn();
 f.setSessionError(403);f.rejectBusiness();await turn();assert.equal(f.store.status.value,'recovering');f.retry();await turn();assert.equal(f.store.status.value,'unbound');assert.equal(f.retryCount(),0);assert.equal(f.stats().pokes,0);
});

test('transport rejection cooldown automatically recovers instead of permanently stopping reception',async()=>{
 const f=await fixture();await f.store.restore();for(let i=0;i<4;i++){f.rejectTransport();await turn();}
 assert.equal(f.stats().pokes,3);assert.equal(f.retryCount(),1);assert.equal(f.store.businessReady.value,true);
 f.advance(60001);f.retry();await turn();assert.equal(f.stats().pokes,4);assert.equal(f.stats().bootstraps,1);assert.equal(f.retryCount(),0);
});

test('unchanged foreground catch-up reuses announcement list, but recovered announcement changes refresh it',async()=>{
 const f=await fixture();await f.store.restore();for(let i=0;i<10;i++)await f.tick('catchup');
 assert.equal(f.stats().listFlags.filter(Boolean).length,0);
 const changed=await fixture({announcementChange:true});await changed.store.restore();await changed.tick('catchup');assert.deepEqual(changed.stats().listFlags,[false,true]);
});

 test('rate limited identity preserves recovery and does not burst automatic cold retries',async()=>{
 const f=await fixture({sessionError:429});assert.equal(await f.store.restore(),false);assert.equal(f.stats().sessions,1);assert.equal(f.store.status.value,'recovering');assert.equal(f.store.user.value,null);
 assert.equal(await f.store.restore(),true);assert.equal(f.stats().sessions,2);assert.equal(f.store.status.value,'online');
 });

test('cold workspace shows only cached identity before network verification and resumes the same lease',async()=>{
 let release;const gate=new Promise(r=>release=r),f=await fixture({workspace:{account:'synthetic-A',name:'cached name'},sessionDelay:gate});
 assert.equal(await f.store.restoreCachedWorkspace(),true);assert.equal(f.store.user.value.username,'synthetic-A');assert.equal(f.store.ready.value,true);assert.equal(f.store.businessReady.value,false);assert.equal(f.store.businessWritable.value,false);assert.equal(f.stats().sessions,0);assert.equal(f.stats().bootstraps,0);
 const pending=f.store.restore();await turn();assert.equal(f.stats().bootstraps,0);assert.equal(f.store.user.value.username,'synthetic-A');release();assert.equal(await pending,true);assert.equal(f.store.businessReady.value,true);assert.equal(f.stats().sessions,1);
});

test('cached workspace never survives authoritative revocation or project denial',async()=>{
 for(const status of [401,403]){
  const f=await fixture({workspace:{account:'synthetic-A',name:'cached name'},sessionError:status});
  await f.store.restoreCachedWorkspace();assert.equal(f.store.businessReady.value,false);
  assert.equal(await f.store.restore(),false);assert.equal(f.store.user.value,null);assert.equal(f.store.businessWritable.value,false);assert.ok(f.accounts.includes(''));assert.equal(f.stats().bootstraps,0);
 }
});

test('PWA metadata bound without a subscription is not notification success and retries without auth reads',async()=>{
 const f=await fixture();await f.store.restore();assert.equal(await f.store.syncPushBinding(false),false);assert.equal(f.store.pushBound.value,false);assert.equal(f.retryCount(),1);
 const before=f.stats();f.setPush({subscription:{endpoint:'synthetic'}});f.retry();await turn();await turn();
 assert.equal(f.store.pushBound.value,true);assert.equal(f.stats().sessions,before.sessions);assert.equal(f.stats().bootstraps,before.bootstraps);assert.equal(f.retryCount(),0);
});
test('parallel PWA registration shares subscription and bind, transient server failure repairs automatically',async()=>{
 let release;const gate=new Promise(r=>release=r),f=await fixture({push:{subscription:{}},pushDelay:gate,pushFailure:true});await f.store.restore();
 const a=f.store.syncPushBinding(false),b=f.store.syncPushBinding(false);await turn();assert.equal(f.stats().pushReads,1);release();assert.deepEqual(await Promise.all([a,b]),[false,false]);assert.equal(f.stats().bindings,1);
 f.retry();await turn();await turn();assert.equal(f.store.pushBound.value,true);assert.equal(f.stats().bindings,2);assert.equal(f.stats().sessions,1);
});
test('session invalidation cancels pending PWA registration repair',async()=>{
 const f=await fixture();await f.store.restore();await f.store.syncPushBinding(false);assert.equal(f.retryCount(),1);
 f.setSessionError(401);f.rejectBusiness();await turn();await turn();assert.equal(f.store.status.value,'expired');assert.equal(f.retryCount(),0);
});

test('foreground push repair is throttled but detects a later missing subscription without checking identity',async()=>{
 const f=await fixture({push:{subscription:{}}});await f.store.restore();assert.equal(await f.store.syncPushBinding(false),true);const before=f.stats();
 for(let i=0;i<10;i++)await f.store.syncPushBinding(false);assert.equal(f.stats().bindings,before.bindings);
 f.advance(61000);f.setPush(null);assert.equal(await f.store.syncPushBinding(false),false);assert.equal(f.store.pushBound.value,false);assert.equal(f.stats().sessions,before.sessions);
});
test('subscription rotation bypasses freshness cache and coalesces an in-flight follow-up',async()=>{
 let release;const gate=new Promise(r=>release=r),f=await fixture({push:{subscription:{}},pushDelay:gate});await f.store.restore();
 const a=f.store.syncPushBinding(false),b=f.store.syncPushBinding(false,true);release();await Promise.all([a,b]);await turn();await turn();assert.equal(f.stats().bindings,2);assert.equal(f.stats().sessions,1);
 const before=f.stats().bindings;await f.store.syncPushBinding(false,true);assert.equal(f.stats().bindings,before+1);
});
