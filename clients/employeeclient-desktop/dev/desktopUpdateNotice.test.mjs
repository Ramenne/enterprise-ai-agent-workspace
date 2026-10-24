import test from 'node:test';import assert from 'node:assert/strict';
import {createDesktopUpdateNotice,desktopHasUpdate} from '../src/platform/desktopUpdateNotice.mjs';
const old={phase:'current',current:'0.2.9',release:{version:'0.2.9'}};
const available={...old,phase:'available',release:{version:'0.2.10'}};
test('startup discovers once; About shares it; ready installer survives reentry',async()=>{
 let calls=0,clock=0,state=old,seen;
 const notice=createDesktopUpdateNotice({now:()=>clock,bridge:{updateState:async()=>state,checkUpdate:async()=>{calls++;return state=available;}},onChange:s=>seen=s});
 await Promise.all([notice.check(),notice.check()]);assert.equal(calls,1);assert.ok(desktopHasUpdate(seen));
 await notice.check();assert.equal(calls,1);assert.equal(seen.phase,'available');
 clock=31*60*1000;await notice.check();assert.equal(calls,2);
 state={...available,phase:'ready'};await notice.check(true);assert.equal(calls,2);assert.equal(seen.phase,'ready');
});
test('failed discovery retries; checking preserves the known release dot',async()=>{
 let calls=0;const notice=createDesktopUpdateNotice({bridge:{updateState:async()=>old,checkUpdate:async()=>{calls++;return calls===1?{...old,error:'offline'}:available;}},onChange:()=>{}});
 await notice.check();await notice.check();assert.equal(calls,2);
 assert.ok(desktopHasUpdate({...available,phase:'checking'}));assert.ok(!desktopHasUpdate(old));
});
test('late snapshot cannot overwrite a newer ready event',async()=>{
 let event,resolve,seen;const gate=new Promise(r=>resolve=r);
 const notice=createDesktopUpdateNotice({bridge:{onUpdateState:fn=>{event=fn;return()=>{};},updateState:()=>gate,checkUpdate:async()=>{throw Error('ready must not be discarded');}},onChange:s=>seen=s});
 const pending=notice.check();event({...available,phase:'ready'});resolve(old);await pending;assert.equal(seen.phase,'ready');
});
