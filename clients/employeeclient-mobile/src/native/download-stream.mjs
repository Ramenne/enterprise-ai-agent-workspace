// Shared network waits for preview/cache downloads and direct file saving.
// Slow local verification/writing does not consume the network idle budget.
const policy=idleMs=>{if(!Number.isSafeInteger(idleMs)||idleMs<1)throw new TypeError('下载超时配置无效');};
async function withNetworkWait(signal,work){
 signal?.throwIfAborted();
 const controller=new AbortController();let rejectCancelled;
 const cancelled=new Promise((_resolve,reject)=>{rejectCancelled=reject;});cancelled.catch(()=>{});
 const abort=()=>{const error=signal.reason||new DOMException('下载已暂停','AbortError');controller.abort(error);rejectCancelled(error);};
 signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
 const wait=async(promise,budget)=>{
  controller.signal.throwIfAborted();let timer;
  try{
   const value=await Promise.race([promise,cancelled,new Promise((_resolve,reject)=>{timer=setTimeout(()=>{const error=new DOMException('下载长时间没有进展，请重试','TimeoutError');controller.abort(error);reject(error);},Math.max(1,budget));})]);
   controller.signal.throwIfAborted();return value;
  }finally{clearTimeout(timer);}
 };
 try{return await work(controller,wait);}catch(error){controller.abort(error);throw error;}
 finally{signal?.removeEventListener('abort',abort);}
}
/** Bound response headers, then let the stream consumer own body cancellation.
 * @param {string} url
 * @param {{signal?:AbortSignal,credentials?:RequestCredentials,fetcher?:typeof fetch,idleMs?:number}} options
 */
export async function fetchDownloadResponse(url,{signal,credentials='omit',fetcher=globalThis.fetch,idleMs=120000}={}){
 policy(idleMs);
 return withNetworkWait(signal,async(controller,wait)=>{
  let response;
  const request=Promise.resolve(fetcher(url,{signal:controller.signal,credentials,referrerPolicy:'no-referrer',redirect:'error'})).then(value=>{
   response=value;if(controller.signal.aborted){void value.body?.cancel().catch(()=>{});controller.signal.throwIfAborted();}return value;
  });
  try{return await wait(request,idleMs);}catch(error){void response?.body?.cancel().catch(()=>{});throw error;}
 });
}
/** Consume bytes with backpressure; cancel a stalled reader without waiting on an unbounded provider cleanup.
 * @param {ReadableStream<Uint8Array>} stream
 * @param {{signal?:AbortSignal,onChunk:(bytes:Uint8Array)=>Promise<void>|void,idleMs?:number}} options
 */
export async function consumeDownloadStream(stream,{signal,onChunk,idleMs=120000}){
 policy(idleMs);
 return withNetworkWait(signal,async(_controller,wait)=>{
  const reader=stream.getReader();let ended=false,idleStarted=performance.now();
  try{
   for(;;){
    const part=await wait(reader.read(),idleMs-(performance.now()-idleStarted));
    if(part.done){ended=true;break;}if(!part.value?.byteLength)continue;
    await onChunk(part.value);signal?.throwIfAborted();idleStarted=performance.now();
   }
  }finally{if(!ended)void reader.cancel().catch(()=>{});reader.releaseLock();}
 });
}
/** Stream to the existing verifier/cache writer, without whole-file buffering.
 * @param {string} url
 * @param {{signal?:AbortSignal,onChunk:(bytes:Uint8Array,total?:number)=>Promise<void>|void,credentials?:RequestCredentials,fetcher?:typeof fetch,idleMs?:number}} options
 */
export async function streamDownload(url,{signal,onChunk,credentials='omit',fetcher=globalThis.fetch,idleMs=120000}){
 const response=await fetchDownloadResponse(url,{signal,credentials,fetcher,idleMs});
 try{
  signal?.throwIfAborted();if(!response.ok||!response.body)throw Error('文件来源暂时无法读取，请稍后重试');
  const estimate=Number(response.headers.get('content-length')),total=Number.isFinite(estimate)&&estimate>0?estimate:undefined;
  await consumeDownloadStream(response.body,{signal,idleMs,onChunk:bytes=>onChunk(bytes,total)});
 }finally{void response.body?.cancel().catch(()=>{});}
}
