import type {IOBudget} from '../../../packages/platform/src/machine-budget.js';
import { PgBoss } from 'pg-boss';
import type pg from 'pg';
import { sqlFunction, transaction } from '../../../packages/platform/src/db.js';
import type { ObjectAdapter } from '../../mem/src/objects.js';
import { cleanReadTemps } from './temp-cleanup.js';
import { completenessHandlers } from './handlers390.js';
import { maintainAttempt, queueDatabase, renewQueue, requireHeld } from './heartbeat.js';
export interface Task { id: string; kind: string; attempt: string | number; fencing_token: string; payload: Record<string, unknown> }
export interface HandlerContext { signal: AbortSignal }
export interface DeterministicHandler { prepare(task: Task, context?: HandlerContext): Promise<Record<string, unknown>>; apply(client: pg.PoolClient, task: Task, prepared: Record<string, unknown>): Promise<Record<string, unknown>> }
export interface WorkerOptions { externalDispatch?:boolean; ioBudget?:IOBudget; readTempDirectory?: string; readTempTtlSeconds?: number; handlers?: Readonly<Record<string, DeterministicHandler>>; objectAdapter?: ObjectAdapter; leaseSeconds?: number; heartbeatIntervalMs?: number; maxTasksPerTick?: number }
export class DeterministicWorker {
 readonly boss: PgBoss;
 private readonly controllers = new Set<AbortController>();
 private stopping=false;
 private activeStart:Promise<void>|undefined;
 private activeTick:Promise<Record<string,unknown>>|undefined;
 private stopPromise:Promise<void>|undefined;
 private readonly handlers: Readonly<Record<string, DeterministicHandler>>;
 private readonly leaseSeconds: number;
 private readonly heartbeatIntervalMs: number;
 private readonly maxTasksPerTick: number;
 constructor(readonly pool: pg.Pool, connectionString: string, readonly options: WorkerOptions = {}) {
  this.leaseSeconds=options.leaseSeconds??60;this.heartbeatIntervalMs=options.heartbeatIntervalMs??Math.floor(this.leaseSeconds*1000/3);
  this.maxTasksPerTick=options.maxTasksPerTick??16;
  if (!Number.isInteger(this.maxTasksPerTick)||this.maxTasksPerTick<1||this.maxTasksPerTick>100) throw new Error('invalid_worker_tick_budget');
  if (!Number.isInteger(this.leaseSeconds) || this.leaseSeconds<1 || this.leaseSeconds>600 || this.heartbeatIntervalMs<50 || this.heartbeatIntervalMs>=this.leaseSeconds*1000/2) throw new Error('invalid_worker_heartbeat');
  this.handlers={...completenessHandlers(pool,options.objectAdapter,options.ioBudget),...options.handlers};
  this.boss = new PgBoss({ db: { executeSql: (text, values) => pool.query(text, values) }, schema: 'worker_queue', migrate: false, createSchema: false,
   supervise: false, schedule: false, persistQueueStats: false, reindex: false, max: 2 });
  this.boss.on('error', () => process.stderr.write('{"service":"worker","error_code":"queue_dependency_error"}\n'));
 }
 async start(): Promise<void> {
  if(this.stopping)return;
  if(this.activeStart)return this.activeStart;
  const running=(async()=>{
   try{await this.boss.start();}
   catch(error){await this.boss.stop({graceful:false,timeout:5000});throw error;}
  })();this.activeStart=running;
  try{await running;}finally{if(this.activeStart===running)this.activeStart=undefined;}
 }
 async stop(timeoutMs=30000):Promise<void>{
  if(this.stopPromise)return this.stopPromise;
  if(!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>120000)throw Error('invalid_worker_stop_budget');
  this.stopping=true;
  for(const controller of this.controllers)controller.abort(new Error('worker_stopping'));
  const settle=(async()=>{await this.activeStart?.catch(()=>{});await this.activeTick?.catch(()=>{});await this.boss.stop({graceful:true,timeout:5000});})();
  this.stopPromise=new Promise<void>((resolve,reject)=>{
   const timer=setTimeout(()=>reject(Error('worker_shutdown_incomplete_lease_recovery_required')),timeoutMs);
   settle.then(()=>{clearTimeout(timer);resolve();},error=>{clearTimeout(timer);reject(error);});
  });
  return this.stopPromise;
 }
 async tick():Promise<Record<string,unknown>>{
  if(this.stopping)return{state:'worker_stopping',processed:0,completed:0};
  if(this.activeTick)return this.activeTick;
  const running=this.tickOnce();this.activeTick=running;
  try{return await running;}finally{if(this.activeTick===running)this.activeTick=undefined;}
 }
 private async tickOnce():Promise<Record<string,unknown>>{
  // Deliver committed events before maintenance; a domain recovery failure must not starve the public feed.
  const delivery = this.options.externalDispatch?{state:'independent_lane'}:await sqlFunction(this.pool, 'evidence.dispatch_batch', [100]);
  const today = Math.floor(Date.now() / 86400000) * 86400000;
  const periodStart = new Date(today - 86400000).toISOString(), periodEnd = new Date(today).toISOString();
  await sqlFunction(this.pool, 'evidence.enqueue_task', ['governance_rollup', 'governance-day:' + periodStart.slice(0, 10), { period_start: periodStart, period_end: periodEnd }]);
  await sqlFunction(this.pool,'mem.worker_enqueue_recovery',[100]);
  await sqlFunction(this.pool,'evidence.enqueue_task',['property_snapshot','property-day:'+new Date(today).toISOString().slice(0,10),{period_start:new Date(today).toISOString()}]);
  const recovery=await sqlFunction(this.pool,'evidence.recover_compound_creation',[100]);
  let consumption = await sqlFunction(this.pool, 'evidence.consume_batch', ['worker-projection', 100]);
  if (consumption['state'] === 'resync_required') {
   await transaction(this.pool, async client => { await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ'); await client.query("SELECT evidence.seed_consumer('worker-projection')"); });
   consumption = await sqlFunction(this.pool, 'evidence.consume_batch', ['worker-projection', 100]);
  }
  const backfill=await sqlFunction(this.pool,'evidence.backfill_derived_tasks',[100]);
  const transport=await sqlFunction(this.pool,'evidence.ack_transport_tasks',[500]);
  const ready = await sqlFunction<{id:string;broker_priority:number}[]>(this.pool, 'evidence.ready_tasks', [100]);
  for (const task of ready) {
   if(this.stopping)break;
   await this.boss.send('hub2-work', { task_id: task.id }, { id: task.id, priority:task.broker_priority,heartbeatSeconds:Math.max(10,this.leaseSeconds),expireInSeconds:Math.max(30,this.leaseSeconds*2) });
   // Already queued jobs retain their ID and broker attempt; update scheduling only.
   await this.pool.query("UPDATE worker_queue.job SET priority=$2 WHERE name='hub2-work' AND id=$1 AND data->>'task_id'=$1::text AND state IN('created','retry') AND priority IS DISTINCT FROM $2",[task.id,task.broker_priority]);
  }
  if(this.stopping)return{state:'worker_stopping',delivery,consumption,recovery,backfill,transport,processed:0,completed:0};
  await this.boss.supervise(undefined, { reindex: false });
  let completed = 0;
  let processed=0;
  // Fetch one actual attempt at a time; unstarted batch members never lose their lease while another object is read.
  for(let slot=0;slot<this.maxTasksPerTick;slot++) {
  if(this.stopping)break;
  const jobs = await this.boss.fetch<{task_id:string}>('hub2-work', { batchSize: 1, includeMetadata: true });
  if(!jobs.length)break;
  for (const job of jobs) {
   if(this.stopping){await this.boss.fail('hub2-work',job,{error_code:'worker_stopping'}).catch(()=>{});break;}
   processed++;
   const task = await sqlFunction<Task | null>(this.pool, 'evidence.claim_task', [this.leaseSeconds, job.data.task_id]);
   if (!task) {
    const receipt = await sqlFunction<Record<string, unknown> | null>(this.pool, 'evidence.task_receipt', [job.data.task_id]);
    if (receipt?.['state'] === 'done') await this.boss.complete('hub2-work', { id: job.id, retryCount: job.retryCount }, { state: 'already_done' });
    else await this.boss.fail('hub2-work', { id: job.id, retryCount: job.retryCount }, { error_code: 'business_task_not_claimable' });
    continue;
   }
   const controller=new AbortController();this.controllers.add(controller);
   if(this.stopping)controller.abort(new Error('worker_stopping'));
   const heartbeat=maintainAttempt(this.pool,this.boss,task,job,this.leaseSeconds,this.heartbeatIntervalMs,controller);
   try {
    controller.signal.throwIfAborted();
    const handler = this.handlers[task.kind];
    let prepared:Record<string,unknown>={};
    if (handler) prepared=await abortable(handler.prepare(task,{signal:controller.signal}),controller.signal);
    else if (task.kind==='read_temp_cleanup') {
     if (!this.options.readTempDirectory) throw new Error('read_temp_directory_unconfigured');
     prepared=await abortable(cleanReadTemps(this.options.readTempDirectory,this.options.readTempTtlSeconds??86400),controller.signal);
    }
    await heartbeat.stop();controller.signal.throwIfAborted();
    await transaction(this.pool,async client=>{
     await client.query('SELECT evidence.renew_task($1,$2,$3,$4)',[task.id,task.attempt,task.fencing_token,this.leaseSeconds]);
     await renewQueue(client,this.boss,job,this.leaseSeconds); // Locks actual active broker attempt before any final effects.
     controller.signal.throwIfAborted();
     const result=handler?await handler.apply(client,task,prepared):task.kind==='governance_rollup'?
      (await client.query('SELECT evidence.rollup_usage($1,$2) AS result',[task.payload['period_start'],task.payload['period_end']])).rows[0]['result'] as Record<string,unknown>:
      task.kind==='property_snapshot'?(await client.query('SELECT evidence.collect_property_snapshots($1,100) AS result',[task.payload['period_start']])).rows[0]['result'] as Record<string,unknown>:
      task.kind==='read_temp_cleanup'?prepared:(await client.query('SELECT evidence.plan_task($1,$2,$3) AS result',[task.id,task.attempt,task.fencing_token])).rows[0]['result'] as Record<string,unknown>;
     if(result['state']==='awaiting_domain_capability')throw new Error('domain_capability_unavailable');
     await client.query('SELECT evidence.finish_task($1,$2,$3,$4,NULL)',[task.id,task.attempt,task.fencing_token,result]);
     controller.signal.throwIfAborted();
     requireHeld(await this.boss.complete('hub2-work',job,{state:'done'},{db:queueDatabase(client)}));
    });
    completed++;
   } catch (error) {
    await heartbeat.stop();
    const knownCodes=new Set(['domain_capability_unavailable','read_temp_directory_unconfigured','unsafe_temp_ttl','unsafe_temp_directory','queue_attempt_lost','worker_attempt_lost','worker_stopping','index_object_store_unconfigured','index_object_integrity_mismatch','index_object_store_forbidden','index_object_version_unavailable','index_object_store_unavailable','task_event_scope_mismatch','task_event_group_incomplete','index_task_scope_mismatch','index_publication_scope_mismatch','index_publication_fixed_ref_mismatch','index_restore_receipt_missing','index_object_unavailable','index_publication_not_delivered']);
    const code=error instanceof Error&&knownCodes.has(error.message)?error.message:'worker_task_failed';
    await sqlFunction(this.pool,'evidence.finish_task',[task.id,task.attempt,task.fencing_token,{state:'failed'},code]).catch(()=>undefined);
    await this.boss.fail('hub2-work',job,{error_code:code}).catch(()=>undefined);
   } finally {await heartbeat.stop();this.controllers.delete(controller);}
  }
  }
  return { delivery, consumption, recovery,backfill,transport,processed,completed };
 }
}
async function abortable<T>(work:Promise<T>,signal:AbortSignal):Promise<T> {
 signal.throwIfAborted();let rejectAbort:()=>void;
 const aborted=new Promise<never>((_resolve,reject)=>{rejectAbort=()=>reject(signal.reason);signal.addEventListener('abort',rejectAbort,{once:true});});
 try{return await Promise.race([work,aborted]);}finally{signal.removeEventListener('abort',rejectAbort!);}
}
