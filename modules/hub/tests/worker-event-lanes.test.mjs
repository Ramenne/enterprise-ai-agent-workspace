import test from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks,stripTypeScriptTypes} from 'node:module';
import {readFileSync,existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {setTimeout as pause} from 'node:timers/promises';
const hooks=registerHooks({
 resolve(specifier,context,next){
  try{return next(specifier,context);}catch(error){
   if(error.code!=='ERR_MODULE_NOT_FOUND'||!specifier.startsWith('.')||!specifier.endsWith('.js'))throw error;
   const url=new URL(specifier.slice(0,-3)+'.ts',context.parentURL);
   if(!existsSync(url))throw error;return{url:url.href,shortCircuit:true};
  }
 },
 load(url,context,next){
  if(!url.endsWith('.ts'))return next(url,context);
  return{format:'module',shortCircuit:true,source:stripTypeScriptTypes(readFileSync(fileURLToPath(url),'utf8'),{mode:'transform',sourceUrl:url})};
 }
});
const {DeterministicWorker}=await import('../apps/worker/src/worker.ts');
const {WorkerService}=await import('../apps/worker/src/service.ts');
hooks.deregister();
const deferred=()=>{let resolve;return{promise:new Promise(r=>{resolve=r;}),resolve};};
async function until(check){const end=Date.now()+1500;while(!check()){if(Date.now()>end)assert.fail('bounded progress deadline');await pause(2);}}
function fixture(t,controls={}){
 const calls=[],results=[],failures=[];
 let eventActive=0,maxEventActive=0,starts=0,stops=0,taskTicks=0;
 const deliveryPool={query:async(sql,args)=>{
  assert.equal(sql,'SELECT evidence.dispatch_batch($1) AS result');assert.deepEqual(args,[100]);
  calls.push('dispatch');eventActive++;maxEventActive=Math.max(maxEventActive,eventActive);
  try{await controls.dispatch?.();return{rows:[{result:{delivered:1}}]};}finally{eventActive--;}
 }};
 const taskPool={query:async(sql,args)=>{
  const name=/^SELECT ([a-z_]+\.[a-z_]+)\(/.exec(sql)?.[1];
  assert.ok(name,'unexpected task SQL');assert.notEqual(name,'evidence.dispatch_batch','task lane must never dispatch');
  calls.push(name);if(name==='evidence.enqueue_task'&&args[0]==='governance_rollup')taskTicks++;
  await controls.task?.(name,args);
  return{rows:[{result:name==='evidence.ready_tasks'?[]:{state:'ok'}}]};
 }};
 const worker=new DeterministicWorker(taskPool,'synthetic-unused',{externalDispatch:true});
 worker.boss.start=async()=>{starts++;await controls.start?.();};
 worker.boss.stop=async()=>{stops++;await controls.stop?.();};
 worker.boss.supervise=async()=>{};
 worker.boss.fetch=async()=>[];
 const source=controls.initialize?async()=>{await controls.initialize();return worker;}:worker;
 const service=new WorkerService(deliveryPool,source,{intervalMs:10,maxRetryMs:80,
  onResult:(phase,result)=>results.push({phase,result}),onFailure:phase=>failures.push(phase)});
 t.after(()=>service.stop(1000));
 return{worker,service,calls,results,failures,get starts(){return starts;},get stops(){return stops;},
  get taskTicks(){return taskTicks;},get maxEventActive(){return maxEventActive;}};
}
for(const [label,match]of[
 ['governance',(name,args)=>name==='evidence.enqueue_task'&&args[0]==='governance_rollup'],
 ['mem recovery',name=>name==='mem.worker_enqueue_recovery'],
 ['property',(name,args)=>name==='evidence.enqueue_task'&&args[0]==='property_snapshot'],
 ['compound recovery',name=>name==='evidence.recover_compound_creation']
])test(label+' failure leaves delivery live and recovers without restart',async t=>{
 let broken=true;const f=fixture(t,{task:async(name,args)=>{if(broken&&match(name,args))throw Error('private synthetic failure');}});
 assert.equal(f.service.status().ready,false);f.service.start();
 await until(()=>f.calls.filter(x=>x==='dispatch').length>=3);
 assert.ok(f.failures.includes('task_tick'));assert.equal(f.service.status().tasks,'retrying');
 broken=false;await until(()=>f.results.some(x=>x.phase==='task_tick'));
 assert.equal(f.service.status().ready,true);
});
test('dispatch failure leaves task execution live; recovery uses same service',async t=>{
 let broken=true;const f=fixture(t,{dispatch:async()=>{if(broken)throw Error('private synthetic failure');}});
 f.service.start();await until(()=>f.taskTicks>=3);
 assert.ok(f.failures.includes('event_dispatch'));assert.equal(f.service.status().delivery,'retrying');
 broken=false;await until(()=>f.service.status().ready);
});
test('failed queue startup cleans partial resources, backs off, and does not block events',async t=>{
 let broken=true;const f=fixture(t,{start:async()=>{if(broken)throw Error('synthetic queue unavailable');}});
 f.service.start();await until(()=>f.calls.filter(x=>x==='dispatch').length>=3);
 assert.equal(f.taskTicks,0);assert.ok(f.stops>=1);assert.ok(f.failures.includes('queue_start'));
 broken=false;await until(()=>f.taskTicks>0);assert.ok(f.starts>=2);
});
test('hung queue startup does not block delivery; shutdown joins it and admits no tick',async t=>{
 const gate=deferred();const f=fixture(t,{start:()=>gate.promise});f.service.start();
 await until(()=>f.calls.filter(x=>x==='dispatch').length>=3);
 assert.equal(f.taskTicks,0);let closed=false;const stopping=f.service.stop(1000).then(()=>{closed=true;});
 await pause(10);assert.equal(closed,false);gate.resolve();await stopping;
 assert.equal(f.taskTicks,0);assert.equal(f.service.status().ready,false);
});
test('slow task does not hold delivery lane; repeated start cannot create extra loops',async t=>{
 const gate=deferred();let held=true,entered=false;
 const f=fixture(t,{task:async name=>{if(name==='evidence.ready_tasks'&&held){entered=true;await gate.promise;}}});
 f.service.start();f.service.start();await until(()=>entered&&f.calls.filter(x=>x==='dispatch').length>=4);
 assert.equal(f.taskTicks,1);assert.equal(f.starts,1);assert.equal(f.maxEventActive,1);
 held=false;gate.resolve();await until(()=>f.results.some(x=>x.phase==='task_tick'));
});
test('shutdown joins actual delivery and cancels pending retries before pools may close',async t=>{
 const gate=deferred();const f=fixture(t,{dispatch:()=>gate.promise});f.service.start();await until(()=>f.calls.includes('dispatch'));
 let closed=false;const stopped=f.service.stop(1000).then(()=>{closed=true;});await pause(10);assert.equal(closed,false);
 gate.resolve();await stopped;const count=f.calls.length;await pause(30);
 assert.equal(f.calls.length,count);assert.equal(f.service.status().delivery,'stopped');f.service.start();assert.equal(f.calls.length,count);
});
test('persistent dispatch failures have one bounded retry schedule rather than a request storm',async t=>{
 const f=fixture(t,{dispatch:async()=>{throw Error('synthetic unavailable');}});f.service.start();await pause(75);await f.service.stop(1000);
 const count=f.calls.filter(x=>x==='dispatch').length;assert.ok(count>=2&&count<=5,'bounded exponential retries: '+count);
});
test('concurrent worker startup shares the actual attempt',async t=>{
 const gate=deferred();const f=fixture(t,{start:()=>gate.promise});
 const a=f.worker.start(),b=f.worker.start();assert.equal(f.starts,1);gate.resolve();await Promise.all([a,b]);
});

test('task resource initialization failure is isolated from event delivery and retries',async t=>{
 let broken=true;const f=fixture(t,{initialize:async()=>{if(broken)throw Error('synthetic object store dependency');}});
 f.service.start();await until(()=>f.calls.filter(x=>x==='dispatch').length>=3);
 assert.equal(f.starts,0);assert.ok(f.failures.includes('task_initialize'));
 broken=false;await until(()=>f.taskTicks>0);assert.equal(f.starts,1);
});
test('shutdown joins late task initialization and disposes its worker before any startup',async t=>{
 const gate=deferred();const f=fixture(t,{initialize:()=>gate.promise});f.service.start();
 await until(()=>f.calls.filter(x=>x==='dispatch').length>=3);
 let closed=false;const stopped=f.service.stop(1000).then(()=>{closed=true;});await pause(10);assert.equal(closed,false);
 gate.resolve();await stopped;assert.equal(f.starts,0);assert.equal(f.stops,1);assert.equal(f.taskTicks,0);
});

test('shutdown joins failed-start cleanup before closing queue resources',async t=>{
 const cleanup=deferred();let stopCalls=0;
 const f=fixture(t,{start:async()=>{throw Error('synthetic queue failure');},
  stop:async()=>{if(++stopCalls===1)await cleanup.promise;}});
 const started=f.worker.start();const failed=assert.rejects(started,/synthetic queue failure/);
 await until(()=>stopCalls===1);let stopped=false;
 const closing=f.service.stop(1000).then(()=>{stopped=true;});await pause(10);assert.equal(stopped,false);
 cleanup.resolve();await failed;await closing;assert.ok(stopCalls>=2);
});
