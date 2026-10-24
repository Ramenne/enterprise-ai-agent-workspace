import type pg from 'pg';
import type { PgBoss } from 'pg-boss';
import { transaction } from '../../../packages/platform/src/db.js';
import type { Task } from './worker.js';
export interface BrokerAttempt { id:string; retryCount:number }
export function queueDatabase(client: pg.PoolClient) { return {executeSql:(text:string,values?:unknown[])=>client.query(text,values)}; }
export function requireHeld(result: unknown): void {
 if ((result as {affected?:number}).affected!==1) throw new Error('queue_attempt_lost');
}
/** PgBoss.touch refreshes heartbeat_on, but expire_seconds is still measured from started_on.
 * Extend that absolute bound while holding the exact active queue attempt. Never alter started_on or retry_count. */
export async function renewQueue(client: pg.PoolClient, boss: PgBoss, job: BrokerAttempt, leaseSeconds: number): Promise<void> {
 requireHeld(await boss.touch('hub2-work',job,{db:queueDatabase(client)}));
 const result=await client.query("UPDATE worker_queue.job SET expire_seconds=greatest(expire_seconds,ceil(extract(epoch FROM (worker_queue.job_now()-started_on)))::integer+$4) WHERE name=$1 AND id=$2 AND retry_count=$3 AND state='active' RETURNING id",
  ['hub2-work',job.id,job.retryCount,Math.max(30,leaseSeconds*2)]);
 if (result.rowCount!==1) throw new Error('queue_attempt_lost');
}
export function maintainAttempt(pool: pg.Pool, boss: PgBoss, task: Task, job: BrokerAttempt, leaseSeconds:number, intervalMs:number, controller:AbortController) {
 let timer:ReturnType<typeof setTimeout>|undefined;let current:Promise<void>|undefined;let stopped=false;
 const renew=()=>transaction(pool,async client=>{
  await client.query('SELECT evidence.renew_task($1,$2,$3,$4)',[task.id,task.attempt,task.fencing_token,leaseSeconds]);
  await renewQueue(client,boss,job,leaseSeconds);
 });
 const schedule=()=>{timer=setTimeout(()=>{
  current=renew().then(()=>{if(!stopped)schedule();},()=>{controller.abort(new Error('worker_attempt_lost'));});
 },intervalMs);timer.unref();};
 schedule();
 return {async stop(){stopped=true;if(timer)clearTimeout(timer);await current;},renew};
}
