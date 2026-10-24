import {readPushIdentity} from './webPushState';
import {createNotificationEffectRecovery} from './notificationEffectRecovery.mjs';
import {waitForOperation} from './operationDeadline.mjs';

export function createPwaNotificationEffectRecovery(){
 const recovery=createNotificationEffectRecovery({attempt:async()=>{
  const signal=AbortSignal.timeout(30000);
  let worker=navigator.serviceWorker?.controller;
  if(!worker){
   // An absent/unavailable Worker waits for ready/controllerchange/online.
   // It cannot accept a handoff, so it must not create an empty retry loop.
   try{const registration=await waitForOperation(navigator.serviceWorker?.getRegistration(),signal) as ServiceWorkerRegistration|undefined;worker=navigator.serviceWorker?.controller||registration?.active||null;}
   // A readiness event can join this flight while the lookup is pending. If
   // the Worker arrived meanwhile, lend it one fresh attempt after this wait.
   catch{return navigator.serviceWorker?.controller?Date.now():null;}
  }
  if(!worker)return null;
  const identity=await waitForOperation(readPushIdentity(),signal);
  return await new Promise<number|null>((resolve,reject)=>{
   const channel=new MessageChannel();
   const finish=(value:number|null,error?:Error)=>{signal.removeEventListener('abort',abort);channel.port1.close();error?reject(error):resolve(value);};
   const abort=()=>finish(null,Error('notification_resume_timeout'));
   signal.addEventListener('abort',abort,{once:true});if(signal.aborted){abort();return;}
   channel.port1.onmessage=event=>{const value=event.data;if(value?.ok!==true){finish(null,Error('notification_resume_failed'));return;}finish(value.retryAt??null);};
   try{worker.postMessage({type:'qn-resume-recovery',identity},[channel.port2]);}catch{finish(null,Error('notification_resume_unavailable'));}
  });
 }});
 const worker=navigator.serviceWorker;
 const pending=(event:MessageEvent)=>{if(['qn-recovery-pending','qn-notification-effects-pending'].includes(event.data?.type))recovery.wakeAt(event.data.retryAt);};
 worker?.addEventListener('message',pending);
 return {wake:recovery.wake,stop(){worker?.removeEventListener('message',pending);recovery.stop();}};
}
