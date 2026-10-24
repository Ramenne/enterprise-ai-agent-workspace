// Lifecycle-driven discovery; coalesced and separate from downloading/installing.
export function createUpdateNotice({read,onChange=(_result)=>{},now=Date.now,minInterval=30*60*1000}) {
 let flight=null,lastSuccess=null;
 async function check(force=false){
  if(flight)return flight;
  if(!force&&lastSuccess!==null&&now()-lastSuccess<minInterval)return null;
  flight=(async()=>{const result=await read();if(!Number.isSafeInteger(result.versionCode)||!Number.isSafeInteger(result.currentVersionCode)||result.versionCode<1||result.currentVersionCode<1)throw Error('update_manifest_invalid');
   onChange({...result,available:result.versionCode>result.currentVersionCode});lastSuccess=now();return result;
  })();
  try{return await flight;}finally{flight=null;}
 }
 return {check};
}
export function bindUpdateNotice(check,page=document,host=window){
 const discover=()=>{if(page.visibilityState!=='hidden')void check().catch(()=>{});};
 page.addEventListener('visibilitychange',discover);host.addEventListener('online',discover);host.addEventListener('pageshow',discover);discover();
 return ()=>{page.removeEventListener('visibilitychange',discover);host.removeEventListener('online',discover);host.removeEventListener('pageshow',discover);};
}
