import {savePushRenewal,claimPushRenewal,type PendingPushRenewal} from './webPushState';
import {waitForOperation} from './operationDeadline.mjs';

// Foreground and Worker share one durable attempt lease and failure deadline.
// A page may disappear mid-request; its lease expires without deleting intent.
export async function claimPushTask(account:string,owner:string,leaseMs:number,signal:AbortSignal,valid=()=>true,sourceInstallationId?:string):Promise<{pending:PendingPushRenewal|null;waitUntil:number}>{
 return await waitForOperation(claimPushRenewal(account,owner,leaseMs,()=>valid()&&!signal.aborted,sourceInstallationId),signal);
}
export async function failPushTask(pending:PendingPushRenewal,error:unknown,valid=()=>true):Promise<void>{
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),2000);
 try{
  const failures=Math.min(9,(pending.failures||0)+1),e=error as {code?:string;name?:string};
  await waitForOperation(savePushRenewal({...pending,lease:undefined,failures,retryAt:Date.now()+Math.min(300000,5000*2**(failures-1)),lastError:String(e?.code||e?.name||'push_registration_failed').slice(0,64)},undefined,()=>valid()&&!controller.signal.aborted,pending),controller.signal);
 }catch{/* Original durable intent and its expiring lease remain. */}finally{clearTimeout(timer);}
}
