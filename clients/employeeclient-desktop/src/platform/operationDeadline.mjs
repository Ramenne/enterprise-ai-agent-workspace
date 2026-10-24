/** Ends the caller's wait even for browser APIs without AbortSignal support.
 * The caller must use signal checkpoints before publishing any late result.
 */
export function waitForOperation(work,signal){
 signal.throwIfAborted();
 return new Promise((resolve,reject)=>{
  const abort=()=>{cleanup();reject(signal.reason||new DOMException('操作已取消','AbortError'));};
  const cleanup=()=>signal.removeEventListener('abort',abort);
  signal.addEventListener('abort',abort,{once:true});
  Promise.resolve(work).then(value=>{cleanup();if(signal.aborted)reject(signal.reason);else resolve(value);},error=>{cleanup();reject(error);});
 });
}
