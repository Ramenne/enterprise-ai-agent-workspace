import {waitForOperation} from './operationDeadline.mjs';
// Both foreground and worker submit through this revision protocol. A conflict
// grants one reconciliation, never permission to replay a captured old endpoint.
/** @param {{readCurrent:()=>Promise<any>,write:(subscription:any,expected:string|null)=>Promise<any>,readRevision:()=>Promise<string|null>,expected?:string|null,signal:AbortSignal,valid?:()=>boolean}} options */
export async function commitPushSubscription({readCurrent,write,readRevision,expected=null,signal,valid=()=>true}){
 const check=()=>{signal.throwIfAborted();if(!valid())throw new DOMException('订阅身份已变化','AbortError');};
 for(let attempt=0;attempt<2;attempt++){
  check();const current=await waitForOperation(readCurrent(),signal);check();
  if(!current)throw Object.assign(Error('push_subscription_missing'),{code:'push_subscription_missing',status:0});
  const subscription=typeof current.toJSON==='function'?current.toJSON():current;
  try{const result=await waitForOperation(write(subscription,expected),signal);check();return result;}
  catch(error){check();if(error.status===409&&error.code==='subscription_revision_changed'&&attempt===0){expected=await waitForOperation(readRevision(),signal);check();continue;}
   if(error&&typeof error==='object')error.rejectedSubscription=subscription;throw error;}
 }
}
