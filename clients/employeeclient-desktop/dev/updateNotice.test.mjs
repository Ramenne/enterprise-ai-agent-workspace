import test from 'node:test';import assert from 'node:assert/strict';
import {createUpdateNotice,bindUpdateNotice} from '../src/platform/updateNotice.mjs';
import {readFile} from 'node:fs/promises';
const settle=()=>new Promise(r=>setImmediate(r));
test('lifecycle checks coalesce, throttle successful discoveries and explicit check bypasses throttle',async()=>{
 let now=0,calls=0,release;const changes=[];
 const discovery=createUpdateNotice({now:()=>now,read:async()=>{calls++;if(calls===1)await new Promise(r=>release=r);return {versionCode:90,currentVersionCode:89};},onChange:v=>changes.push(v)});
 const page=new EventTarget(),host=new EventTarget();page.visibilityState='visible';const stop=bindUpdateNotice(()=>discovery.check(),page,host);
 host.dispatchEvent(new Event('online'));page.dispatchEvent(new Event('visibilitychange'));assert.equal(calls,1);release();await settle();assert.equal(changes[0].available,true);
 host.dispatchEvent(new Event('pageshow'));await settle();assert.equal(calls,1);await discovery.check(true);assert.equal(calls,2);
 now=30*60*1000;host.dispatchEvent(new Event('online'));await settle();assert.equal(calls,3);page.visibilityState='hidden';host.dispatchEvent(new Event('online'));await settle();assert.equal(calls,3);stop();
});
test('failed checks preserve known update, permit recovery and actual current version clears the red dot',async()=>{
 let value={versionCode:90,currentVersionCode:89},available=false,calls=0;
 const discovery=createUpdateNotice({read:async()=>{calls++;if(!value)throw Error('offline');return value;},onChange:v=>available=v.available});
 await discovery.check(true);assert.equal(available,true);value=null;await assert.rejects(discovery.check(true),/offline/);assert.equal(available,true);
 value={versionCode:90,currentVersionCode:90};await discovery.check(true);assert.equal(available,false);assert.equal(calls,3);
});
test('invalid manifest cannot create update availability',async()=>{
 let changed=false;const discovery=createUpdateNotice({read:async()=>({versionCode:'90',currentVersionCode:89}),onChange:()=>changed=true});await assert.rejects(discovery.check(true),/update_manifest_invalid/);assert.equal(changed,false);
});
test('release after startup is discovered by opening About within the throttle window',async()=>{
 let serverVersion=90,calls=0,visible;const discovery=createUpdateNotice({now:()=>100,read:async()=>{calls++;return {versionCode:serverVersion,currentVersionCode:90};},onChange:value=>visible=value});
 await discovery.check();assert.equal(visible.available,false);serverVersion=92;
 await discovery.check();assert.equal(calls,1);
 await discovery.check(true);assert.equal(calls,2);assert.equal(visible.available,true);assert.equal(visible.versionCode,92);
 const about=await readFile(new URL('../src/ui/components/AboutOverlay.vue',import.meta.url),'utf8');
 assert.match(about,/onMounted\(async\s*\(\)\s*=>\s*\{[\s\S]*?checkAppUpdate\(true\)/);
});
