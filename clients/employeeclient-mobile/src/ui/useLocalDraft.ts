import {ref,watch,onBeforeUnmount} from 'vue';
import {captureApiLease} from '@/api/client';
import {metaGet,metaSet} from '@/session/db';
// Serialize the same slot across unmount/remount, so a returning page cannot
// read yesterday's value while its outgoing instance is still saving.
const writes=new Map<string,Promise<void>>();
export function useLocalDraft<T>(slot:string,snapshot:()=>T|null,restore:(value:T)=>void){
 const account=captureApiLease().account,key=JSON.stringify([account,slot]);
 const restoring=ref(true),readyToEdit=ref(false),error=ref('');let hydrated=false,disposed=false,timer:ReturnType<typeof setTimeout>|undefined;
 const valid=()=>{const lease=captureApiLease();return lease.account===account&&lease.valid();};
 async function hydrate(){
  restoring.value=true;error.value='';
  try{await writes.get(key)?.catch(()=>{});const saved=await metaGet<T>(account,slot);if(disposed||!valid())return;if(saved!==null)restore(saved);hydrated=true;readyToEdit.value=true;}
  catch{if(!disposed&&valid())error.value='草稿未能读取，请重试';}
  finally{if(!disposed)restoring.value=false;}
 }
 function flush():Promise<void>{
  clearTimeout(timer);
  if(!hydrated)return Promise.reject(Error('草稿尚未读取完成'));
  if(!valid())return Promise.reject(new DOMException('身份已变化','AbortError'));
  const value=JSON.parse(JSON.stringify(snapshot()));
  const work=(writes.get(key)||Promise.resolve()).catch(()=>{}).then(async()=>{
   if(!valid())throw new DOMException('身份已变化','AbortError');
   await metaSet(account,slot,value,valid);
  });writes.set(key,work);
  return work.then(()=>{if(!disposed)error.value='';},cause=>{if(!disposed&&valid())error.value='草稿未能保留，请重试';throw cause;}).finally(()=>{if(writes.get(key)===work)writes.delete(key);});
 }
 const ready=hydrate();
 watch(snapshot,()=>{if(!hydrated||restoring.value||disposed)return;clearTimeout(timer);timer=setTimeout(()=>{void flush().catch(()=>{});},160);},{deep:true,flush:'sync'});
 async function retry(){if(hydrated)await flush();else await hydrate();}
 onBeforeUnmount(()=>{clearTimeout(timer);if(hydrated&&valid())void flush().catch(()=>{});disposed=true;});
 return {ready,restoring,readyToEdit,error,flush,retry};
}
