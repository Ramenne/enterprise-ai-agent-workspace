// Only the authenticated same-origin relay receives bytes. Never expose a
// provider ticket or credential to XMLHttpRequest.
// A slow upload with advancing bytes is healthy. Bound idle time separately
// from total time so a progressing part is not restarted every two minutes.
export async function uploadResponse(url,source,signal,progress,fetcher=globalThis.fetch,headers={},policy={}) {
 signal?.throwIfAborted();
 const idleMs=policy.idleMs??120000,maxMs=policy.maxMs??1800000;
 if(!Number.isSafeInteger(idleMs)||idleMs<1||!Number.isSafeInteger(maxMs)||maxMs<idleMs)throw new TypeError('上传超时配置无效');
 if(typeof XMLHttpRequest==='undefined'||fetcher!==globalThis.fetch){
  // This path has no observable upload progress, so retain the bounded wait.
  const timeout=AbortSignal.timeout(Math.min(idleMs,maxMs));
  const active=signal?AbortSignal.any([signal,timeout]):timeout;
  let response;
  try{response=await fetcher(url,{method:'POST',headers,body:source,credentials:'include',redirect:'error',signal:active});}
  catch(error){active.throwIfAborted();throw error;}
  active.throwIfAborted();
  if(response.ok)progress?.(source.size);
  return response;
 }
 return new Promise((resolve,reject)=>{
  const xhr=new XMLHttpRequest();let finished=false,idle,total,lastLoaded=0;
  const cancel=()=>{xhr.abort();done(reject,signal?.reason||new DOMException('上传已暂停','AbortError'));};
  const done=(fn,value)=>{if(finished)return;finished=true;clearTimeout(idle);clearTimeout(total);signal?.removeEventListener('abort',cancel);fn(value);};
  const stop=error=>{done(reject,error);xhr.abort();};
  const resetIdle=()=>{clearTimeout(idle);idle=setTimeout(()=>stop(new DOMException('上传长时间没有进展，请重试','TimeoutError')),idleMs);};
  xhr.open('POST',url);for(const [name,value] of Object.entries(headers))xhr.setRequestHeader(name,value);xhr.withCredentials=true;xhr.timeout=0;
  xhr.upload.onprogress=e=>{
   if(finished)return;
   const loaded=Math.min(source.size,Math.max(0,e.loaded));
   if(loaded>lastLoaded){lastLoaded=loaded;resetIdle();}
   try{progress?.(lastLoaded);}catch(error){stop(error);}
  };
  xhr.onerror=()=>done(reject,new TypeError('上传连接中断'));
  xhr.ontimeout=()=>done(reject,new DOMException('上传超时','TimeoutError'));
  xhr.onabort=()=>done(reject,signal?.reason||new DOMException('上传已暂停','AbortError'));
  xhr.onload=()=>{
   if(finished)return;
   try{
    if(xhr.responseURL&&new URL(xhr.responseURL).href!==new URL(url,globalThis.location.href).href)return done(reject,new Error('上传地址已改变'));
    done(resolve,new Response(xhr.responseText,{status:xhr.status||502,headers:{'content-type':'application/json'}}));
   }catch(error){done(reject,error);}
  };
  signal?.addEventListener('abort',cancel,{once:true});
  if(signal?.aborted){done(reject,signal.reason||new DOMException('上传已暂停','AbortError'));return;}
  resetIdle();total=setTimeout(()=>stop(new DOMException('单次上传已达到时限，请重试','TimeoutError')),maxMs);
  try{xhr.send(source);}catch(error){done(reject,error);}
 });
}
