import test from 'node:test';import assert from 'node:assert/strict';
import {createConnectionNotice} from '../src/platform/connectionNotice.mjs';

test('hidden time never counts toward a visible connection warning',()=>{
 let now=0,shown='',seq=0;const tasks=new Map();const model=createConnectionNotice(v=>shown=v,{clock:()=>now,timer:(fn,ms)=>{tasks.set(++seq,{fn,at:now+ms});return seq;},cancel:id=>tasks.delete(id)});
 model.update({active:true,healthy:false,foreground:false});now=3600000;assert.equal(tasks.size,0);assert.equal(shown,'');
 model.update({active:true,healthy:false,foreground:true});assert.equal(shown,'');now+=29999;assert.equal(shown,'');
 model.update({active:true,healthy:true,foreground:true});assert.equal(tasks.size,0);assert.equal(shown,'');model.dispose();
});

test('continuous outage has one grace period across retries and clears on recovery',()=>{
 let now=0,shown='',next=0;const tasks=new Map();
 const model=createConnectionNotice(v=>shown=v,{graceMs:15000,clock:()=>now,timer:(fn,ms)=>{tasks.set(++next,{fn,at:now+ms});return next;},cancel:id=>tasks.delete(id)});
 const state={active:true,healthy:false,offline:false};model.update(state);assert.equal(shown,'');
 now=8000;model.update(state);assert.equal(tasks.size,1);
 now=14999;model.update(state);assert.equal(shown,'');
 now=15000;for(const [id,t] of tasks)if(t.at<=now){tasks.delete(id);t.fn();}assert.match(shown,/正在恢复/);
 model.update({...state,offline:true});assert.equal(shown,'当前无网络');
 model.update({...state,healthy:true});assert.equal(shown,'');assert.equal(tasks.size,0);
 now=16000;model.update(state);now=17000;model.update({...state,active:false});assert.equal(tasks.size,0);assert.equal(shown,'');
 model.dispose();
});
