import { createHash } from 'node:crypto';
import { mkdtemp,lstat,stat,rename,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {IOBudget,BudgetLease} from '../../../packages/platform/src/machine-budget.js';
import { prepareVerifiedRead,type ObjectAdapter,type FixedObject } from './objects.js';

interface Entry {path:string;size:number;ino:number;mtimeMs:number;lastUse:number;readers:number;lease?:BudgetLease;}
export interface ByteLease {path:string;cleanup:()=>Promise<void>;cache_hit:boolean;meterOutput?:(input:AsyncIterable<Uint8Array>)=>Promise<AsyncIterable<Uint8Array>>;}

/** Cached bytes have no access authority. Every caller must authorize independently before delivery. */
export class VerifiedByteCache {
 private entries=new Map<string,Entry>();
 private pending=new Map<string,Promise<Entry>>();
 private directory:Promise<string>|undefined;
 constructor(readonly adapter:ObjectAdapter,readonly maxBytes=1280*1024*1024,readonly ttlMs=15*60*1000,readonly budget?:IOBudget){}
 private root(){return this.directory??=mkdtemp(join(tmpdir(),'hub2-verified-byte-cache-'));}
 private key(object:FixedObject,expected:{sha256:string;size:number}){
  return createHash('sha256').update(JSON.stringify([object.provider,object.bucket,object.key,object.versionId,expected.sha256,expected.size])).digest('hex');
 }
 private async valid(entry:Entry){
  try{const info=await lstat(entry.path);return (!entry.lease||!entry.lease.signal.aborted)&&info.isFile()&&!info.isSymbolicLink()&&info.size===entry.size&&info.ino===entry.ino&&info.mtimeMs===entry.mtimeMs&&(info.mode&0o077)===0;}
  catch{return false;}
 }
 private async prune(required=0){
  let used=[...this.entries.values()].reduce((sum,e)=>sum+e.size,0);
  for(const [key,entry]of [...this.entries].sort((a,b)=>a[1].lastUse-b[1].lastUse)){
   if(entry.readers)continue;
   if(Date.now()-entry.lastUse<=this.ttlMs&&used+required<=this.maxBytes&&this.entries.size<16)continue;
   this.entries.delete(key);await rm(entry.path,{force:true});await entry.lease?.release();used-=entry.size;
  }
 }
 async acquire(object:FixedObject,expected:{sha256:string;size:number},beforeRead?:()=>Promise<void>):Promise<ByteLease>{
  // Oversize objects use the original bounded-memory path; they do not evict active readers.
  if(expected.size>this.maxBytes){const temp=await prepareVerifiedRead(this.adapter,object,expected,this.budget,beforeRead);await temp.lease?.phase('retained');return {...temp,cache_hit:false};}
  const key=this.key(object,expected);let entry=this.entries.get(key);let cacheHit=!!entry;
  if(entry&&!await this.valid(entry)){this.entries.delete(key);if(!entry.readers){await rm(entry.path,{force:true});await entry.lease?.release();}entry=undefined;cacheHit=false;}
  if(!entry){
   let load=this.pending.get(key);
   if(!load){load=(async()=>{
    await this.prune(expected.size);
    const temporary=await prepareVerifiedRead(this.adapter,object,expected,this.budget,beforeRead);
    const path=join(await this.root(),key+'.bytes');
    try{await rename(temporary.path,path);const info=await stat(path);await temporary.lease?.phase('retained');const created:Entry={path,size:info.size,ino:info.ino,mtimeMs:info.mtimeMs,lastUse:Date.now(),readers:0,...(temporary.lease?{lease:temporary.lease}:{})};this.entries.set(key,created);return created;}
    catch(e){await temporary.cleanup();throw e;}finally{await temporary.cleanup(true);}
   })();this.pending.set(key,load);load.finally(()=>this.pending.delete(key)).catch(()=>undefined);}
   else cacheHit=true;
   entry=await load;
  }
  entry.readers++;entry.lastUse=Date.now();let released=false;
  return {path:entry.path,cache_hit:cacheHit,cleanup:async()=>{if(released)return;released=true;entry!.readers--;entry!.lastUse=Date.now();if(!entry!.readers&&this.entries.get(key)!==entry){const info=await lstat(entry!.path).catch(()=>null);if(info?.ino===entry!.ino)await rm(entry!.path,{force:true});await entry!.lease?.release();}await this.prune();}};
 }
 async close(){
  for(const [key,entry]of this.entries){if(entry.readers)continue;await rm(entry.path,{force:true});await entry.lease?.release();this.entries.delete(key);}
  if(!this.entries.size&&this.directory){await rm(await this.directory,{recursive:true,force:true});this.directory=undefined;}
 }
}

const caches=new WeakMap<ObjectAdapter,VerifiedByteCache>();
export function cacheFor(adapter:ObjectAdapter,budget?:IOBudget){let cache=caches.get(adapter);if(!cache){cache=new VerifiedByteCache(adapter,1280*1024*1024,15*60*1000,budget);caches.set(adapter,cache);}return cache;}
