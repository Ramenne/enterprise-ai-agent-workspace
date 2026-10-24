/** Canonical owner: Hufu packages/platform/src/authorization-transport.mjs.
 * One protected authorization request, no permission cache and no automatic retry. */
export async function requestAuthorization(config,token,path,body,DomainError,{fetchImpl=globalThis.fetch,timeoutMs=5000}={}){
 const url=new URL(path,config.hufuUrl);
 if(!['/internal/decision','/internal/discovery-decision'].includes(path)||!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||url.username||url.password)throw Error('internal Hufu must use protected local channel');
 let response;
 try{response=await fetchImpl(url,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+token,'x-hub-service-key':config.serviceKey},body:JSON.stringify(body),signal:AbortSignal.timeout(timeoutMs)});}
 catch{throw new DomainError('authorization_unavailable',503,true);}
 let payload;try{payload=await response.json();}catch{payload=null;}
 if(!response.ok){
  const fallback=response.status===401?'unauthenticated':response.status===403?'forbidden':'authorization_unavailable';
  const code=typeof payload?.error_code==='string'&&/^[a-z][a-z0-9_]{0,119}$/.test(payload.error_code)?payload.error_code:fallback;
  const status=code===fallback&&fallback==='authorization_unavailable'?503:response.status;
  throw new DomainError(code,status,status>=500);
 }
 if(!payload||typeof payload!=='object'||Array.isArray(payload)||typeof payload.handle!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(payload.handle))throw new DomainError('authorization_unavailable',503,true);
 return payload;
}
