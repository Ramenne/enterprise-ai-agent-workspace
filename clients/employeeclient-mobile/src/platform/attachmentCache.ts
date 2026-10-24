import {Capacitor,registerPlugin} from '@capacitor/core';
// Durable byte cache. Identity includes the authenticated owner and immutable source version.
let database:Promise<IDBDatabase>|undefined;
function open(){return database??=new Promise<IDBDatabase>((resolve,reject)=>{const r=indexedDB.open('employeeclient-attachments',1);r.onupgradeneeded=()=>r.result.createObjectStore('files');r.onsuccess=()=>resolve(r.result);r.onerror=()=>{database=undefined;reject(r.error);};});}
export async function cachedBlob(key:string):Promise<Blob|undefined>{try{const db=await open();return await new Promise((resolve,reject)=>{const r=db.transaction('files').objectStore('files').get(key);r.onsuccess=()=>{const value=r.result;if(value instanceof Blob)resolve(value);else if(value?.opfs)void readLargeBlob(value).then(resolve,()=>resolve(undefined));else resolve(undefined);};r.onerror=()=>reject(r.error);});}catch{return undefined;}}
export async function storeBlob(key:string,blob:Blob,valid:()=>boolean=()=>true){try{const db=await open();await new Promise<void>((resolve,reject)=>{const t=db.transaction('files','readwrite');if(valid())t.objectStore('files').put(blob,key);t.oncomplete=()=>resolve();t.onerror=t.onabort=()=>reject(t.error);});if(!valid()){db.transaction('files','readwrite').objectStore('files').delete(key);return false;}return true;}catch{return false;}}
export async function removeBlob(key:string){const db=await open();const old=await cacheRecord(key);if(old?.opfs)await deleteLargeFile(old.opfs);await new Promise<void>((resolve,reject)=>{const t=db.transaction('files','readwrite');t.objectStore('files').delete(key);t.oncomplete=()=>resolve();t.onerror=t.onabort=()=>reject(t.error);});}
async function hash(parts:unknown[]){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(parts)))),b=>b.toString(16).padStart(2,'0')).join('');}

const epochs=new Map<string,number>();
export function cacheLease(account:string){const epoch=epochs.get(account)||0;return ()=>epoch===(epochs.get(account)||0);}
export async function attachmentKey(parts:unknown[]){return await hash([parts[0]])+':'+await hash(parts);}
export async function clearAttachmentCache(account:string){
 epochs.set(account,(epochs.get(account)||0)+1);
 const prefix=await hash([account])+':';
 for(const key of Object.keys(localStorage))if(key.startsWith('qn.attachment-alias:'+prefix))localStorage.removeItem(key);
 if(Capacitor.isNativePlatform())await registerPlugin<{clearAccount(o:{prefix:string}):Promise<void>}>('EmployeeClientAttachment').clearAccount({prefix});
 else {const names:string[]=[];const db=await open();await new Promise<void>((resolve,reject)=>{const tx=db.transaction('files','readwrite'),store=tx.objectStore('files'),r=store.openCursor(IDBKeyRange.bound(prefix,prefix+'\uffff'));r.onsuccess=()=>{const c=r.result;if(c){if(c.value?.opfs)names.push(c.value.opfs);store.delete(c.primaryKey);c.continue();}};tx.oncomplete=()=>resolve();tx.onerror=tx.onabort=()=>reject(tx.error);});await Promise.all(names.map(deleteLargeFile));}
}

// A verified share may give identical bytes a new company attachment identity.
// Alias within one account so that opening the new group entry reuses local bytes.
export function resolveAttachmentKey(key:string){try{const target=localStorage.getItem('qn.attachment-alias:'+key);if(target&&target.split(':')[0]===key.split(':')[0])return target;}catch{}return key;}
export function rememberAttachmentAlias(from:string,to:string){if(from.split(':')[0]!==to.split(':')[0])return;try{localStorage.setItem('qn.attachment-alias:'+to,resolveAttachmentKey(from));}catch{}}


// Large browser files are written a chunk at a time to origin-private disk.
// Only a fully verified file receives a cache pointer; partial bytes cannot
// appear as a completed attachment after a reload.
async function largeDirectory(){if(!navigator.storage?.getDirectory)throw Error('当前浏览器不支持大文件缓存，请使用安卓员工客户端传输');return (await navigator.storage.getDirectory()).getDirectoryHandle('employeeclient-large-files',{create:true});}
async function cacheRecord(key:string):Promise<any>{const db=await open();return new Promise((resolve,reject)=>{const r=db.transaction('files').objectStore('files').get(key);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});}
async function deleteLargeFile(name:string){try{await(await largeDirectory()).removeEntry(name);}catch{}}
async function readLargeBlob(record:{opfs:string;size:number;mime:string}){const file=await(await(await largeDirectory()).getFileHandle(record.opfs)).getFile();return file.size===record.size?new Blob([file],{type:record.mime}):undefined;}
export async function beginLargeBlob(key:string,valid:()=>boolean){
 const directory=await largeDirectory(),name=key.split(':')[0]+'-'+crypto.randomUUID();
 const handle=await directory.getFileHandle(name,{create:true}),writer=await handle.createWritable();let closed=false;
 const check=()=>{if(!valid())throw new DOMException('缓存身份已改变','AbortError');};
 return {
  append:async(bytes:Uint8Array<ArrayBuffer>)=>{check();await writer.write(bytes);check();},
  finish:async(mime:string,size:number)=>{
   check();await writer.close();closed=true;check();const file=await handle.getFile();if(file.size!==size)throw Error('大文件缓存长度不符');
   const old=await cacheRecord(key),db=await open();check();
   await new Promise<void>((resolve,reject)=>{const tx=db.transaction('files','readwrite');check();tx.objectStore('files').put({opfs:name,size,mime},key);tx.oncomplete=()=>resolve();tx.onerror=tx.onabort=()=>reject(tx.error);});
   if(!valid()){await removeBlob(key);throw new DOMException('缓存身份已改变','AbortError');}
   if(old?.opfs&&old.opfs!==name)await deleteLargeFile(old.opfs);
   return new Blob([file],{type:mime});
  },
  cancel:async()=>{if(!closed)await writer.abort().catch(()=>{});await deleteLargeFile(name);}
 };
}
