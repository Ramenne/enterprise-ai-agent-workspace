import {ref,onBeforeUnmount,onActivated,onDeactivated,onMounted,watch} from 'vue';
import {createReadFeedback} from '@/domain/readFeedback.mjs';
import {createRecoveryGate} from '@/platform/recoveryGate.mjs';
import {isRetryableFailure} from '@/domain/userError.mjs';
/** Scope-owned inline feedback. Hidden/deactivated views cannot retain a banner. */
export function useReadFeedback(options:{retry?:()=>unknown;ready?:()=>boolean}={}){
 const error=ref('');let viewActive=true,pending=false,disposed=false;
 const visible=()=>viewActive&&document.visibilityState!=='hidden';
 const display=createReadFeedback({publish:(text:string)=>error.value=text});
 const retry=()=>{if(!disposed&&pending&&visible()&&navigator.onLine!==false&&options.ready?.()!==false&&recovery.ready()){pending=false;try{void Promise.resolve(options.retry?.()).catch(e=>feedback.failed(e,'内容暂未读取，请重试'));}catch(e){feedback.failed(e,'内容暂未读取，请重试');}}};
 const recovery=createRecoveryGate({wake:retry});
 const feedback={
  begin:display.begin,
  failed(e:unknown,fallback:string){if(disposed)return;display.failed(e,fallback);pending=!!options.retry&&isRetryableFailure(e);if(pending)recovery.failed();else recovery.cancel();},
  succeeded(){pending=false;recovery.completed();display.succeeded();},
  dispose(){disposed=true;pending=false;recovery.cancel();display.dispose();}
 };
 const visibility=()=>{display.active(visible());if(visible())retry();};
 if(options.ready)watch(options.ready,ready=>{if(ready)retry();});
 onMounted(()=>{document.addEventListener('visibilitychange',visibility);window.addEventListener('online',visibility);visibility();});
 onActivated(()=>{viewActive=true;visibility();});
 onDeactivated(()=>{viewActive=false;visibility();});
 onBeforeUnmount(()=>{document.removeEventListener('visibilitychange',visibility);window.removeEventListener('online',visibility);feedback.dispose();});
 return {error,feedback};
}
