// Read projections only. Never cache permission to execute or approval requests.
const prefix='employeeclient:collaboration:read:';
type Entry<T=unknown>={at:number;value:T};
const memory=new Map<string,Entry>();
const invalidations=new Map<string,number>();
let accountEpoch=0;
let database:Promise<IDBDatabase>|undefined;
let pending:Promise<unknown>=Promise.resolve();
function db(){
  return database??=new Promise<IDBDatabase>((resolve,reject)=>{
    const request=indexedDB.open('employeeclient-collaboration-read',1);
    request.onupgradeneeded=()=>request.result.createObjectStore('entries');
    request.onsuccess=()=>resolve(request.result);
    request.onerror=()=>reject(request.error);
    request.onblocked=()=>reject(new Error('缓存数据库暂不可用'));
  });
}
function persist(action:(store:IDBObjectStore)=>void){
  // Ordered saves/deletion prevent stale writes recreating deleted conversations.
  pending=pending.then(async()=>{
    const database=await db();
    await new Promise<void>((resolve,reject)=>{
      const tx=database.transaction('entries','readwrite');action(tx.objectStore('entries'));
      tx.oncomplete=()=>resolve();tx.onerror=tx.onabort=()=>reject(tx.error);
    });
  }).catch(()=>{}); // A full disk must not prevent reading the in-memory copy.
}
export function cacheKey(account:string,computer:string,provider:string,kind:string){
  return prefix+JSON.stringify([account,computer,provider,kind]);
}
export async function readCache<T>(key:string):Promise<Entry<T>|null>{
  const epoch=accountEpoch,version=invalidations.get(key)||0;
  const current=()=>epoch===accountEpoch&&version===(invalidations.get(key)||0);
  if(memory.has(key))return memory.get(key) as Entry<T>;
  try{
    await pending;
    const database=await db();
    const value=await new Promise<Entry<T>|undefined>((resolve,reject)=>{
      const request=database.transaction('entries').objectStore('entries').get(key);
      request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);
    });
    if(!current())return null;
    if(value){memory.set(key,value);return value;}
  }catch{}
  // Migrate old localStorage projections without discarding previously read text.
  try{
    if(!current())return null;
    const value=JSON.parse(localStorage.getItem(key)||'null');
    if(value?.at&&value.value){memory.set(key,value);persist(s=>s.put(value,key));return value;}
  }catch{}
  return null;
}
export function writeCache(key:string,value:unknown){
  // Vue proxies cannot be structured-cloned; persist an immutable projection.
  const entry={at:Date.now(),value:JSON.parse(JSON.stringify(value))};
  memory.set(key,entry);persist(s=>s.put(entry,key));
}
export function removeReadCache(key:string){
  invalidations.set(key,(invalidations.get(key)||0)+1);
  memory.delete(key);try{localStorage.removeItem(key);}catch{}
  persist(s=>s.delete(key));
}
export function clearReadCache(account:string){
  accountEpoch++;
  const owned=(key:string)=>{
    try{return key.startsWith(prefix)&&JSON.parse(key.slice(prefix.length))[0]===account;}catch{return false;}
  };
  for(const key of memory.keys())if(owned(key))memory.delete(key);
  try{for(const key of Object.keys(localStorage))if(owned(key))localStorage.removeItem(key);}catch{}
  persist(s=>{const request=s.openCursor();request.onsuccess=()=>{
    const cursor=request.result;if(!cursor)return;
    if(owned(String(cursor.key)))cursor.delete();cursor.continue();
  };});
}
