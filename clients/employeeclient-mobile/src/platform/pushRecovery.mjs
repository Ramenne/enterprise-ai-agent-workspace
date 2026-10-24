// Lifecycle wakeups only. Registration retry/backoff belongs to the session store.
export function bindPushRecovery(repair,{page=document,host=window,worker=navigator.serviceWorker,permissions=globalThis.navigator?.permissions}={}){
 let disposed=false,dirty=false,permission;
 const check=()=>{if(!disposed&&page.visibilityState!=='hidden'){const force=dirty;dirty=false;void repair(force);}};
 const changed=event=>{if(event.data?.type==='qn-push-subscription-change'){dirty=true;check();}};
 page.addEventListener('visibilitychange',check);
 for(const name of ['focus','pageshow','online'])host.addEventListener(name,check);
 worker?.addEventListener('controllerchange',check);worker?.addEventListener('message',changed);
 const permissionChanged=()=>{dirty=true;check();};
 // Supported browsers can grant/revoke while this page stays visible.
 // Query once; unsupported permission descriptors wait for lifecycle events.
 try{void permissions?.query({name:'notifications'}).then(status=>{if(!disposed){permission=status;permission.addEventListener('change',permissionChanged);}}).catch(()=>{});}catch{}
 // Registration can become ready after the initial login binding timed out.
 void worker?.ready?.then(check).catch(()=>{});
 check();
 return ()=>{disposed=true;permission?.removeEventListener('change',permissionChanged);page.removeEventListener('visibilitychange',check);for(const name of ['focus','pageshow','online'])host.removeEventListener(name,check);worker?.removeEventListener('controllerchange',check);worker?.removeEventListener('message',changed);};
}

// A restored login has no submit click. Ask once on its first genuine app
// interaction, while browser user activation is still available. A dismissal
// or denial is respected; manual controls remain available for another try.
export function bindPushPermissionRequest({allowed,isDefault,request,complete,page=document}){
 let disposed=false,attempted=false;
 const remove=()=>{page.removeEventListener('pointerup',interact,true);page.removeEventListener('keydown',interact,true);};
 const interact=event=>{
  if(disposed||attempted||!event.isTrusted||page.visibilityState==='hidden'||!allowed()||!isDefault())return;
  if(event.type==='keydown'&&(event.repeat||event.altKey||event.ctrlKey||event.metaKey||!['Enter',' '].includes(event.key)))return;
  attempted=true;remove();
  try{void Promise.resolve(request()).then(value=>{if(!disposed)complete(value);}).catch(()=>{});}catch{}
 };
 page.addEventListener('pointerup',interact,true);page.addEventListener('keydown',interact,true);
 return ()=>{disposed=true;remove();};
}
