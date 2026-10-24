import {jsonSnapshot} from '../session/jsonSnapshot.mjs';
// Shared read-through snapshots, partitioned by the real caller. No credentials.
export function createHubCache({get,put,remove,now=Date.now}){
 const memory=new Map(),flights=new Map();
 const id=(lease,key)=>JSON.stringify([lease.account,key]);
 const active=lease=>{if(!lease.valid())throw Object.assign(Error('session_changed'),{status:401,code:'session_changed'});};
 async function read(lease,key,loader,{onSnapshot=()=>{},force=false,maxAge=120000}={}){
  active(lease);const name=id(lease,key),flightKey=JSON.stringify([lease.account,lease.epoch,key]);
  let cached=memory.get(name);
  if(!cached){try{cached=await get(lease.account,'hub3:'+key);}catch{}active(lease);if(cached?.schema===1)memory.set(name,cached);else cached=null;}
  if(cached){onSnapshot(cached.value);if(lease.networkReady?.()===false||!force&&now()-cached.at<maxAge)return cached.value;}
  if(lease.networkReady?.()===false)throw Object.assign(Error('session_recovering'),{status:0,code:'session_recovering'});
  if(flights.has(flightKey))return flights.get(flightKey);
  const request=(async()=>{
   try{const value=jsonSnapshot(await loader());active(lease);const entry={schema:1,at:now(),value};memory.set(name,entry);await put(lease.account,'hub3:'+key,entry,lease.valid).catch(()=>{});active(lease);return value;}
   catch(e){if(lease.valid()&&[401,403,404].includes(e?.status)){memory.delete(name);await remove(lease.account,'hub3:'+key,lease.valid).catch(()=>{});}throw e;}
   finally{flights.delete(flightKey);}
  })();flights.set(flightKey,request);return request;
 }
 async function invalidate(lease,key){memory.delete(id(lease,key));await remove(lease.account,'hub3:'+key,lease.valid).catch(()=>{});}
 return {read,invalidate};
}
