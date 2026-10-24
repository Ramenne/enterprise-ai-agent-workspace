import test from 'node:test';import assert from 'node:assert/strict';
import {NativeClient} from '../src/native/client.mjs';
const actor='fixture-member';
const persistent={identity:{actor_id:actor},persistent_login:true};
const legacy={identity:{actor_id:actor},persistent_login_available:true};
function storage(){let value;return {getItem:()=>value,setItem:(_,v)=>value=v,removeItem:()=>value=undefined};}
test('successful signing does not count as login if the browser drops Set-Cookie',async()=>{
 globalThis.localStorage=storage();const paths=[];
 const client=new NativeClient({requirePersistent:true,fetcher:async url=>{paths.push(url);return Response.json(url.endsWith('persist-session')?persistent:legacy);}});
 await assert.rejects(client.session(),e=>e.code==='persistent_login_not_retained'&&e.status===503);
 assert.deepEqual(paths,['/native/session','/native/persist-session','/native/session']);assert.equal(client.partition,null);
});
test('credential readback must identify the same member as signing',async()=>{
 globalThis.localStorage=storage();let n=0;
 const client=new NativeClient({fetcher:async()=>Response.json(++n===1?legacy:n===2?persistent:{...persistent,identity:{actor_id:'other-member'}})});
 await assert.rejects(client.session(),e=>e.code==='persistent_login_not_retained');assert.equal(client.partition,null);
});
test('accepted credential is saved only after real readback and reused without new issuance',async()=>{
 globalThis.localStorage=storage();const events=[];let installed=false;
 const client=new NativeClient({requirePersistent:true,loginStorage:{restore:async()=>events.push('restore'),save:async()=>events.push('save'),clear:async()=>{}},fetcher:async url=>{
  events.push(url);if(url.endsWith('persist-session')){installed=true;return Response.json(persistent);}return Response.json(installed?persistent:legacy);
 }});
 assert.equal((await client.session()).identity.actor_id,actor);
 assert.deepEqual(events,['restore','/native/session','/native/persist-session','/native/session','save']);
 events.length=0;await client.session();assert.deepEqual(events,['restore','/native/session','save']);
});
test('production cannot silently accept a short login when capability discovery is absent',async()=>{
 const client=new NativeClient({requirePersistent:true,fetcher:async()=>Response.json({identity:{actor_id:actor}})});
 await assert.rejects(client.session(),e=>e.code==='persistent_login_unavailable');assert.equal(client.partition,null);
});
test('native save failure prevents successful login; sign-out clears saved credential',async()=>{
 const client=new NativeClient({requirePersistent:true,loginStorage:{restore:async()=>{},save:async()=>{throw Error('disk_full');},clear:async()=>{}},fetcher:async()=>Response.json(persistent)});
 await assert.rejects(client.session(),/disk_full/);assert.equal(client.partition,null);
 let clears=0;client.loginStorage.clear=async()=>clears++;await client.signOut();assert.equal(clears,1);
});
test('revoked credential remains rejected after native restore',async()=>{
 let saves=0;const client=new NativeClient({requirePersistent:true,loginStorage:{restore:async()=>{},save:async()=>saves++,clear:async()=>{}},fetcher:async()=>Response.json({error_code:'revoked'},{status:401})});
 await assert.rejects(client.session(),e=>e.status===401);assert.equal(saves,0);assert.equal(client.partition,null);
});

test('concurrent restoration shares one authority flight and recovers native credential before confirming expiry',async()=>{
 let checks=0,restores=0,recovers=0,saves=0;
 const client=new NativeClient({requirePersistent:true,loginStorage:{restore:async()=>restores++,recover:async()=>recovers++,save:async()=>saves++,clear:async()=>{}},fetcher:async()=>++checks===1?Response.json({error_code:'login_required'},{status:401}):Response.json(persistent)});
 const values=await Promise.all([client.session(),client.session(),client.session()]);assert.ok(values.every(v=>v.identity.actor_id===actor));assert.equal(checks,2);assert.equal(restores,1);assert.equal(recovers,1);assert.equal(saves,1);
});

test('temporary authority failure cannot save or clear durable login',async()=>{
 let saves=0,clears=0;
 const client=new NativeClient({requirePersistent:true,loginStorage:{restore:async()=>{},recover:async()=>{},save:async()=>saves++,clear:async()=>clears++},fetcher:async()=>Response.json({error_code:'authority_unavailable'},{status:503})});
 await assert.rejects(client.session(),e=>e.status===503);assert.equal(saves,0);assert.equal(clears,0);assert.equal(client.partition,null);
});
