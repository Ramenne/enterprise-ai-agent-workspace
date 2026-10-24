import type pg from 'pg';
import {loadBudget,type IOBudget} from '../../../packages/platform/src/machine-budget.js';
import { createServer } from './server.js';
import { DeterministicWorker } from './worker.js';
import {loadRuntime,objectStoreConfig} from '../../../packages/platform/src/runtime.js';
import {WorkerService} from './service.js';
import {S3Objects} from '../../../packages/platform/src/s3.js';
const runtime=await loadRuntime('worker');
const url = runtime.optional('database_url','DATABASE_URL')??'';
// Delivery owns a bounded slot and starts independently of task/object-store initialization.
const deliveryPool = await runtime.databasePool('DATABASE_URL',{max:1}), app = createServer();
let pool:pg.Pool|undefined,objects:S3Objects|undefined,ioBudget:IOBudget|undefined;
const service=new WorkerService(deliveryPool,async()=>{
 pool??=await runtime.databasePool('DATABASE_URL',{max:2});
 const store=await objectStoreConfig(runtime,process.env['HUB_OBJECT_STORE_SECRET_REF']??'bao:hub2/object-store/worker','WORKER_S3');
 const budget=await loadBudget(runtime,'worker');
 let adapter:S3Objects|undefined;
 try{
  adapter=store?new S3Objects(store):undefined;
  const tempDirectory=process.env['HUB_WORKER_READ_TEMP_DIRECTORY'];
  const tickBudget=process.env['HUB_WORKER_MAX_TASKS_PER_TICK'];
  const worker=new DeterministicWorker(pool,url,{externalDispatch:true,ioBudget:budget,
   ...(tempDirectory?{readTempDirectory:tempDirectory}:{}),...(adapter?{objectAdapter:adapter}:{}),
   ...(tickBudget?{maxTasksPerTick:Number(tickBudget)}:{})});
  objects=adapter;ioBudget=budget;return worker;
 }catch(error){adapter?.close();await budget.close();throw error;}
},{
 onResult:(phase,result)=>app.log.info({service:'worker',phase,state:'tick',...result}),
 onFailure:phase=>app.log.warn({service:'worker',phase,error_code:'worker_dependency_failed'})
});
app.get('/ready',async(_request,reply)=>{
 const lanes=service.status();
 return reply.code(lanes.ready?200:503).send({state:lanes.ready?'ready':'degraded',lanes,
  capabilities:{secrets:runtime.mode,index_object_store:objects?'configured_not_provider_verified':'configuration_required'}});
});
await app.listen({ host: '127.0.0.1', port: Number(process.env['PORT'] ?? 4615) });
let closePromise:Promise<void>|undefined;
const stop=()=>closePromise??=(async()=>{
 // Join initialization, dispatch, and leased task attempts before closing any pool or secret client.
 await Promise.all([app.close(),service.stop()]);
 await Promise.all([pool?.end(),deliveryPool.end()]);objects?.close();await ioBudget?.close();await runtime.close();
})().catch(()=>{
 process.stderr.write('{"service":"worker","error_code":"worker_shutdown_incomplete_lease_recovery_required"}\n');
 process.exitCode=1;
});
await new Promise<void>(resolve=>{
 const join=()=>{void stop().then(resolve);};
 process.once('SIGTERM',join);process.once('SIGINT',join);
 service.start();
});
await closePromise;
