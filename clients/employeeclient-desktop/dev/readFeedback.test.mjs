import test from 'node:test';import assert from 'node:assert/strict';
import {createReadFeedback} from '../src/domain/readFeedback.mjs';
import {createRecoveryGate} from '../src/platform/recoveryGate.mjs';
function clock(){let time=0,seq=0;const timers=new Map();return {now:()=>time,setTimer(fn,ms){const id=++seq;timers.set(id,{at:time+ms,fn});return id;},clearTimer(id){timers.delete(id);},tick(ms){const until=time+ms;while(true){const entry=[...timers].sort((a,b)=>a[1].at-b[1].at)[0];if(!entry||entry[1].at>until)break;time=entry[1].at;timers.delete(entry[0]);entry[1].fn();}time=until;},get pending(){return timers.size;}};}
const busy=()=>Object.assign(Error('upstream'),{status:503});
function setup(){const c=clock(),seen=[];let text='';const f=createReadFeedback({...c,publish:v=>{text=v;seen.push(v);}});return{c,f,seen,get text(){return text;}};}
test('cached transient read stays silent, continuous failure becomes inline, and success cancels its deadline',()=>{
 const x=setup();x.f.begin(true);x.f.failed(busy(),'工作暂未更新');x.c.tick(10000);x.f.begin(true);x.f.failed(busy(),'工作暂未更新');x.c.tick(19999);assert.equal(x.text,'');x.c.tick(1);assert.equal(x.text,'工作暂未更新');x.f.succeeded();assert.equal(x.text,'');assert.equal(x.c.pending,0);x.c.tick(60000);assert.equal(x.text,'');
});
test('restored cache changes the presentation deadline without restarting a continuous failure',()=>{
 const x=setup();x.f.begin(false);x.f.failed(busy(),'未读取');x.c.tick(1000);x.f.begin(true);x.f.failed(busy(),'未读取');x.c.tick(1000);assert.equal(x.text,'');x.c.tick(28000);assert.equal(x.text,'未读取');
});
test('first read gets a bounded inline failure, permission failures are immediate, readiness and cancellation remain silent',()=>{
 const x=setup();x.f.begin(false);x.f.failed(busy(),'内容暂未读取');x.c.tick(1499);assert.equal(x.text,'');x.c.tick(1);assert.equal(x.text,'内容暂未读取');x.f.succeeded();
 x.f.failed({status:403},'no');assert.match(x.text,/权限/);x.f.succeeded();x.f.failed({code:'session_recovering'},'no');assert.equal(x.text,'');assert.equal(x.c.pending,0);x.f.failed(new DOMException('cancel','AbortError'),'no');assert.equal(x.text,'');
});
test('hidden time never instantly exposes a stale transient error on return; disposal cancels late publication',()=>{
 const x=setup();x.f.begin(true);x.f.failed(busy(),'未更新');x.c.tick(29000);x.f.active(false);x.c.tick(60000);assert.equal(x.text,'');x.f.active(true);x.c.tick(1000);assert.equal(x.text,'');x.f.dispose();x.c.tick(60000);assert.equal(x.text,'');assert.equal(x.c.pending,0);
});
test('read feedback never initiates network work and repeated failures keep one display timer',()=>{
 const x=setup();x.f.begin(true);for(let i=0;i<100;i++)x.f.failed(busy(),'未更新');assert.equal(x.c.pending,1);x.f.succeeded();assert.equal(x.c.pending,0);
});
test('a later failure cannot wake an earlier retry timer before the extended deadline',()=>{
 const c=clock();let wakes=0;const gate=createRecoveryGate({...c,wake:()=>wakes++,base:2000});gate.failed();c.tick(1000);gate.failed();c.tick(1000);assert.equal(wakes,0);assert.equal(gate.ready(),false);c.tick(2999);assert.equal(wakes,0);c.tick(1);assert.equal(wakes,1);gate.completed();assert.equal(c.pending,0);
});
