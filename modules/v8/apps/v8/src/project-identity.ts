import {z} from 'zod';
import {DomainError} from '../../../packages/platform/src/http.js';
const identitySchema=z.object({actor_id:z.uuid(),organization_id:z.uuid()});
/** Needed to derive project ownership; never supplies an authorization verdict or caches it. */
export async function readProjectIdentity(hufuUrl:string,token:string){
 const url=new URL('/whoami',hufuUrl);
 if(!['127.0.0.1','localhost','[::1]'].includes(url.hostname))throw new Error('local Hufu required');
 let response:Response;
 try{response=await fetch(url,{headers:{authorization:'Bearer '+token},signal:AbortSignal.timeout(5000)});}
 catch{throw new DomainError('authorization_unavailable',503,true);}
 if(!response.ok){
  if(response.status===401)throw new DomainError('unauthenticated',401);
  if(response.status===403)throw new DomainError('forbidden',403);
  throw new DomainError('authorization_unavailable',503,true);
 }
 let value:unknown;try{value=await response.json();}catch{throw new DomainError('identity_unavailable',503,true);}
 const identity=identitySchema.safeParse(value);
 if(!identity.success)throw new DomainError('identity_unavailable',503,true);
 return identity.data;
}
