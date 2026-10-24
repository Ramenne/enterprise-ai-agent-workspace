import test from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks,stripTypeScriptTypes} from 'node:module';
import {readFileSync, existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

// Run the real worker source without depending on an unrelated full-platform build.
const hooks=registerHooks({
 resolve(specifier,context,nextResolve) {
  try {return nextResolve(specifier,context);}
  catch(error) {
   if(error.code!=='ERR_MODULE_NOT_FOUND'||!specifier.endsWith('.js')||!specifier.startsWith('.'))throw error;
   const url=new URL(specifier.slice(0,-3)+'.ts',context.parentURL);
   if(!existsSync(url))throw error;
   return {url:url.href,shortCircuit:true};
  }
 },
 load(url,context,nextLoad) {
  if(!url.endsWith('.ts'))return nextLoad(url,context);
  return {format:'module',shortCircuit:true,source:stripTypeScriptTypes(readFileSync(fileURLToPath(url),'utf8'),{mode:'transform',sourceUrl:url})};
 }
});
const {DeterministicWorker}=await import('../apps/worker/src/worker.ts');
hooks.deregister();

function fixture({fail,gate}={}) {
 const calls=[];
 const pool={query:async(text,args)=>{
  const name=/^SELECT ([a-z_]+\.[a-z_]+)\(/.exec(text)?.[1];
  assert.ok(name,'unexpected SQL: '+text);
  calls.push({name,args});
  if(name==='evidence.dispatch_batch'&&gate)await gate;
  if(fail?.(name,args))throw Error('synthetic_dependency_failure');
  return {rows:[{result:name==='evidence.ready_tasks'?[]:{state:'ok'}}]};
 }};
 const worker=new DeterministicWorker(pool,'synthetic-unused-connection');
 worker.boss.supervise=async()=>{};
 worker.boss.fetch=async()=>[];
 worker.boss.stop=async()=>{};
 return {worker,calls};
}
const maintenanceFailures=[
 ['governance',(name,args)=>name==='evidence.enqueue_task'&&args[0]==='governance_rollup'],
 ['mem recovery',name=>name==='mem.worker_enqueue_recovery'],
 ['property',(name,args)=>name==='evidence.enqueue_task'&&args[0]==='property_snapshot'],
 ['compound recovery',name=>name==='evidence.recover_compound_creation']
];
for(const [label,fail] of maintenanceFailures)test('dispatch survives '+label+' failure',async()=>{
 const {worker,calls}=fixture({fail});
 await assert.rejects(worker.tick(),/synthetic_dependency_failure/);
 assert.equal(calls[0]?.name,'evidence.dispatch_batch');
 assert.equal(calls.filter(c=>c.name==='evidence.dispatch_batch').length,1);
 assert.ok(!calls.some(c=>c.name==='evidence.consume_batch'),'failed prerequisites must not advance projection');
 await worker.stop();
});
test('dispatch failure propagates and does not start unrelated maintenance',async()=>{
 const {worker,calls}=fixture({fail:name=>name==='evidence.dispatch_batch'});
 await assert.rejects(worker.tick(),/synthetic_dependency_failure/);
 assert.deepEqual(calls.map(c=>c.name),['evidence.dispatch_batch']);
 await worker.stop();
});
test('healthy tick preserves recovery before projection and bounded dispatch',async()=>{
 const {worker,calls}=fixture();
 const result=await worker.tick();
 assert.equal(calls[0].name,'evidence.dispatch_batch');
 assert.deepEqual(calls[0].args,[100]);
 assert.ok(calls.findIndex(c=>c.name==='evidence.recover_compound_creation')<calls.findIndex(c=>c.name==='evidence.consume_batch'));
 assert.deepEqual(result.delivery,{state:'ok'});
 assert.equal(result.processed,0);
 await worker.stop();
 assert.equal((await worker.tick()).state,'worker_stopping');
});
test('concurrent ticks share dispatch and failure clears the active tick for recovery',async()=>{
 let release;let broken=true;
 const gate=new Promise(resolve=>{release=resolve;});
 const {worker,calls}=fixture({gate,fail:name=>name==='mem.worker_enqueue_recovery'&&broken});
 const first=worker.tick(),second=worker.tick();
 assert.equal(calls.filter(c=>c.name==='evidence.dispatch_batch').length,1);
 const results=Promise.allSettled([first,second]);release();
 assert.ok((await results).every(r=>r.status==='rejected'));
 broken=false;
 await worker.tick();
 assert.equal(calls.filter(c=>c.name==='evidence.dispatch_batch').length,2);
 await worker.stop();
});
