import {waitForOperation} from './operationDeadline.mjs';

// This transports demand, never business data. Each task keeps its own durable
// deadline/lease. Visible pages share one timer; BackgroundSync is another wake.
export async function scheduleRecoveryWake(registration:ServiceWorkerRegistration,tag:string,retryAt:number|null,notifyPages=true){
 if(retryAt===null)return;
 const signal=AbortSignal.timeout(2000);
 try{
  const sync=(registration as ServiceWorkerRegistration&{sync?:{register:(tag:string)=>Promise<void>}}).sync;
  const pages=notifyPages?(async()=>{
   const scope=globalThis as unknown as {clients?:{matchAll(options:{type:'window'}):Promise<Array<{visibilityState:string;postMessage(message:unknown):void}>>}};
   // Keep the v138 wake wire name so already-open pages can use the new Worker.
   for(const client of await scope.clients?.matchAll({type:'window'})||[])if(client.visibilityState==='visible')client.postMessage({type:'qn-notification-effects-pending',retryAt});
  })():Promise.resolve();
  await waitForOperation(Promise.allSettled([pages,Promise.resolve().then(()=>sync?.register(tag))]),signal);
 }catch{/* Durable task survives an unavailable wake surface. */}
}
