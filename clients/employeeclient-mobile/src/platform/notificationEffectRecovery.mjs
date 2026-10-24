// A visible page lends the Worker a wake for its durable tasks. Only an actual
// pending task (or a failed local handoff) arms one timer; an empty queue is idle.
export function createNotificationEffectRecovery({attempt,visible=()=>document.visibilityState!=='hidden',now=Date.now,setTimer=setTimeout,clearTimer=clearTimeout}){
 let flight=null,timer,notBefore=0,failures=0,disposed=false,queuedAt=null;
 const clear=()=>{if(timer!==undefined)clearTimer(timer);timer=undefined;};
 const arm=()=>{if(disposed||!visible()||timer!==undefined||!notBefore)return;timer=setTimer(()=>{timer=undefined;void wake();},Math.max(250,notBefore-now()));};
 function wake(){
  if(disposed||!visible())return Promise.resolve();
  if(flight)return flight;
  if(notBefore>now()){arm();return Promise.resolve();}
  clear();
  const work=(async()=>{
   try{const retryAt=await attempt();if(disposed)return;failures=0;notBefore=typeof retryAt==='number'&&Number.isFinite(retryAt)?Math.max(now()+250,retryAt):0;if(queuedAt!==null)notBefore=Math.max(now()+250,Math.min(notBefore||Infinity,queuedAt));queuedAt=null;}
   catch{queuedAt=null;if(disposed)return;notBefore=now()+Math.min(300000,5000*2**Math.min(failures++,6));}
  })();flight=work;
  void work.finally(()=>{if(flight===work)flight=null;arm();});return work;
 }
 return {wake,wakeAt(at){
  if(disposed||typeof at!=='number'||!Number.isFinite(at)||at<0)return;
  if(flight){queuedAt=queuedAt===null?at:Math.min(queuedAt,at);return;}
  if(!notBefore||at<notBefore){notBefore=Math.max(now()+250,at);clear();}arm();
 },stop(){disposed=true;clear();}};
}
