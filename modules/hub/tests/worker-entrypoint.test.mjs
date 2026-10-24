import test from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {setTimeout as pause} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
for(const mode of ['healthy','queue-fails','dispatch-fails'])test('actual worker entrypoint: '+mode,async t=>{
 const messages=[];let stderr='',port,exited=false;
 const child=fork(fileURLToPath(new URL('../apps/worker/src/start.ts',import.meta.url)),[],{
  execArgv:['--import',fileURLToPath(new URL('./fixtures/worker-entry-loader.mjs',import.meta.url))],
  env:{PATH:process.env.PATH,PORT:'0',DATABASE_URL:'postgresql://synthetic.invalid/isolated-test',WORKER_TEST_MODE:mode},
  stdio:['ignore','ignore','pipe','ipc']
 });
 child.stderr.on('data',x=>{stderr+=x;});
 child.on('message',x=>{messages.push(x);if(x.kind==='listening')port=x.port;});
 const closed=new Promise(resolve=>child.once('exit',(code,signal)=>{exited=true;resolve({code,signal});}));
 t.after(()=>{if(!exited)child.kill('SIGKILL');});
 async function until(check){const end=Date.now()+6000;while(!check()){if(exited||Date.now()>end)assert.fail('entrypoint progress failed: '+stderr);await pause(5);}}
 const capability=mode==='dispatch-fails'?'evidence.enqueue_task':'evidence.dispatch_batch';
 await until(()=>port&&messages.filter(x=>x.kind==='query'&&x.capability===capability).length>=2);
 const response=await fetch('http://127.0.0.1:'+port+'/ready');
 const body=await response.json();
 assert.equal(response.status,mode==='healthy'?200:503);
 assert.equal(body.lanes.ready,mode==='healthy');
 if(mode==='queue-fails'){assert.equal(body.lanes.delivery,'ready');assert.equal(body.lanes.tasks,'retrying');}
 if(mode==='dispatch-fails'){assert.equal(body.lanes.delivery,'retrying');assert.equal(body.lanes.tasks,'ready');}
 assert.ok(messages.some(x=>x.kind==='query'&&x.max===1));
 assert.ok(!messages.some(x=>x.kind==='query'&&x.max===2&&x.capability==='evidence.dispatch_batch'));
 child.kill('SIGTERM');
 const timeout=new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('shutdown deadline: '+stderr)),3000);timer.unref();});
 assert.deepEqual(await Promise.race([closed,timeout]),{code:0,signal:null});
 assert.equal(messages.filter(x=>x.kind==='pool_end').length,2,'both independent pools close after shutdown');
});
