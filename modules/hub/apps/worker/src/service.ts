import type pg from 'pg';
import {setTimeout as pause} from 'node:timers/promises';
import {sqlFunction} from '../../../packages/platform/src/db.js';
import {DeterministicWorker} from './worker.js';

type LaneState='starting'|'ready'|'retrying'|'stopped';
type Phase='event_dispatch'|'task_initialize'|'queue_start'|'task_tick';
export interface WorkerServiceOptions {
 intervalMs?:number;
 maxRetryMs?:number;
 onResult?:(phase:Phase,result:Record<string,unknown>)=>void;
 onFailure?:(phase:Phase)=>void;
}
/** Independent committed-event delivery and task execution; neither lane owns the other's progress. */
export class WorkerService {
 private readonly cancel=new AbortController();
 private readonly intervalMs:number;
 private readonly maxRetryMs:number;
 private loops:Promise<void>[]=[];
 private stopping=false;
 private started=false;
 private stopPromise:Promise<void>|undefined;
 private deliveryState:LaneState='starting';
 private taskState:LaneState='starting';
 private lastDeliveryAt=0;
 private worker:DeterministicWorker|undefined;
 constructor(readonly deliveryPool:pg.Pool,private readonly source:DeterministicWorker|(()=>Promise<DeterministicWorker>),readonly options:WorkerServiceOptions={}) {
  if(typeof source!=='function'){
   if(!source.options.externalDispatch)throw Error('independent_dispatch_required');
   this.worker=source;
  }
  this.intervalMs=options.intervalMs??1000;
  this.maxRetryMs=options.maxRetryMs??30000;
  if(!Number.isInteger(this.intervalMs)||this.intervalMs<1||this.intervalMs>60000||
    !Number.isInteger(this.maxRetryMs)||this.maxRetryMs<this.intervalMs||this.maxRetryMs>300000)throw Error('invalid_worker_loop_budget');
 }
 start():void {
  if(this.started||this.stopping)return;
  this.started=true;
  this.loops=[this.deliver(),this.executeTasks()];
 }
 status():{ready:boolean;delivery:LaneState;tasks:LaneState} {
  const delivery=this.deliveryState==='ready'&&Date.now()-this.lastDeliveryAt>Math.max(15000,this.intervalMs*3)?'retrying':this.deliveryState;
  return {ready:!this.stopping&&delivery==='ready'&&this.taskState==='ready',delivery,tasks:this.taskState};
 }
 private async wait(failures:number):Promise<void> {
  if(this.stopping)return;
  const delay=Math.min(this.maxRetryMs,this.intervalMs*2**Math.min(Math.max(0,failures-1),10));
  try{await pause(delay,undefined,{signal:this.cancel.signal});}
  catch(error){if(!this.cancel.signal.aborted)throw error;}
 }
 private async deliver():Promise<void> {
  let failures=0;
  try{
   while(!this.stopping){
    try{
     const result=await sqlFunction(this.deliveryPool,'evidence.dispatch_batch',[100]);
     this.deliveryState='ready';this.lastDeliveryAt=Date.now();failures=0;this.options.onResult?.('event_dispatch',result);
    }catch{this.deliveryState='retrying';failures++;this.options.onFailure?.('event_dispatch');}
    await this.wait(failures);
   }
  }finally{this.deliveryState='stopped';}
 }
 private async executeTasks():Promise<void> {
  let initialized=false,failures=0;
  try{
   while(!this.stopping){
    let phase:Phase='task_initialize';
    try{
     if(!this.worker){
      const worker=await (this.source as ()=>Promise<DeterministicWorker>)();
      if(!worker.options.externalDispatch){await worker.stop();throw Error('independent_dispatch_required');}
      this.worker=worker;
      if(this.stopping){await worker.stop();break;}
     }
     phase='queue_start';
     if(!initialized){await this.worker.start();initialized=true;}
     if(this.stopping)break;
     phase='task_tick';
     const result=await this.worker.tick();
     this.taskState='ready';failures=0;this.options.onResult?.(phase,result);
    }catch{this.taskState='retrying';failures++;this.options.onFailure?.(phase);}
    await this.wait(failures);
   }
  }finally{this.taskState='stopped';}
 }
 stop(timeoutMs=30000):Promise<void>{
  if(this.stopPromise)return this.stopPromise;
  if(!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>120000)throw Error('invalid_worker_stop_budget');
  this.stopping=true;this.cancel.abort();
  // Abort task attempts now, join queue startup and both actual loops before the caller closes pools.
  const joined=Promise.all([this.worker?.stop(timeoutMs),...this.loops]).then(()=>{});
  this.stopPromise=new Promise<void>((resolve,reject)=>{
   const timer=setTimeout(()=>reject(Error('worker_shutdown_incomplete_lease_recovery_required')),timeoutMs);
   joined.then(()=>{clearTimeout(timer);resolve();},error=>{clearTimeout(timer);reject(error);});
  });
  return this.stopPromise;
 }
}
