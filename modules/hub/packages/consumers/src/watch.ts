import{open,unlink}from'node:fs/promises';
import{constants}from'node:fs';
import{join}from'node:path';
import{createHash}from'node:crypto';
import{HubApiClient,ConsumerError}from'./transport.js';
import{ProjectConsumer,requireUuid,type ProjectionView}from'./projection.js';
import{FileProjectionStore,controlledDirectory}from'./local-files.js';

export interface WatchOptions {project:string;directory:string;intervalMs?:number;heartbeatMs?:number;signal?:AbortSignal;resync?:boolean;log?:(value:Record<string,unknown>)=>void;}
/** Continuous member-owned projection. Polling does not issue credentials or business writes. */
export async function watchProject(api:HubApiClient,options:WatchOptions):Promise<void>{
 const project=requireUuid(options.project),interval=options.intervalMs??10000,heartbeat=options.heartbeatMs??300000;
 if(!Number.isFinite(interval)||interval<1000||!Number.isFinite(heartbeat)||heartbeat<interval)throw new ConsumerError('invalid_watch_interval');
 const root=await controlledDirectory(options.directory),store=new FileProjectionStore(root),lockPath=join(root,project+'.watch-lock.json');let lock;
 try{lock=await open(lockPath,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);}catch{throw new ConsumerError('project_watch_lock_present;stop_existing_watch_or_inspect_own_stale_lock');}
 await lock.writeFile(JSON.stringify({pid:process.pid,project,started_at:new Date().toISOString()}));await lock.sync();
 let consumer:ProjectConsumer|undefined,binding='',signature='',lastLog=0,first=true;
 const signal=options.signal,log=options.log??(v=>console.log(JSON.stringify(v)));
 const wait=()=>new Promise<void>(resolve=>{if(signal?.aborted){resolve();return;}let timer:NodeJS.Timeout;const end=()=>{clearTimeout(timer);signal?.removeEventListener('abort',end);resolve();};timer=setTimeout(end,interval);signal?.addEventListener('abort',end,{once:true});});
 try{while(!signal?.aborted){
  let view:ProjectionView|undefined;
  try{
   const nowBinding=await api.bindingId();
   if(!consumer||nowBinding!==binding){binding=nowBinding;consumer=new ProjectConsumer(api,project,()=>api.bindingId(),await store.load(project,binding));}
   view=await consumer.sync({...(signal?{signal}:{}),resync:first&&options.resync===true});first=false;
   await store.save(consumer.exportCheckpoint());
   const next=createHash('sha256').update(JSON.stringify([view.status,view.items,view.pending_groups,view.error_code])).digest('hex');
   if(next!==signature||Date.now()-lastLog>=heartbeat){log({state:'consumer_watch',project_id:project,status:view.status,item_count:view.items.length,pending_groups:view.pending_groups,...(view.error_code?{error_code:view.error_code}:{}),checked_at:view.checked_at,checkpoint_preserved:true});signature=next;lastLog=Date.now();}
  }catch(error){
   if(consumer)await store.save(consumer.exportCheckpoint());
   const code=error instanceof ConsumerError?error.code:'consumer_watch_unavailable';
   if(signature!==code||Date.now()-lastLog>=heartbeat){log({state:'consumer_watch',project_id:project,status:'offline_or_current_credential_required',error_code:code,checkpoint_preserved:true});signature=code;lastLog=Date.now();}
  }
  if(!signal?.aborted)await wait();
 }}finally{await lock.close();await unlink(lockPath);log({state:'consumer_watch_stopped',project_id:project,checkpoint_preserved:true});}
}
