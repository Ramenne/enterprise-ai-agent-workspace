import {mkdir,open,readFile,rename,unlink,lstat} from 'node:fs/promises';import {join} from 'node:path';
import {requireThat} from './core.mjs';
/** Durable per-operation admission. A crash leaves a pending receipt; replay
 * returns uncertainty and does not silently repeat a nontransactional action.
 */
export class FileReceipts{
 constructor(root){this.root=root}
 async init(){await mkdir(this.root,{recursive:true,mode:0o700});const s=await lstat(this.root);requireThat(s.isDirectory()&&!s.isSymbolicLink()&&s.uid===process.geteuid()&&!(s.mode&0o077),'private_receipt_root_required');return this}
 path(key){requireThat(/^[a-f0-9]{64}$/.test(key),'operation_key_required');return join(this.root,key+'.json')}
 async get(key){try{return JSON.parse(await readFile(this.path(key),'utf8'))}catch(e){if(e.code==='ENOENT')return null;throw e}}
 async begin(key,row){const p=this.path(key);try{const f=await open(p,'wx',0o600);try{await f.writeFile(JSON.stringify(row));await f.sync()}finally{await f.close()}await this.sync();return true}catch(e){if(e.code==='EEXIST')return false;throw e}}
 async retry(key,row){const lock=this.path(key)+'.retry-lock';let f;try{f=await open(lock,'wx',0o600)}catch(e){if(e.code==='EEXIST')return false;throw e}try{const old=await this.get(key);if(old?.state!=='no_effect_retryable'||old.request_hash!==row.request_hash)return false;await this.put(key,row);return true}finally{await f.close();await unlink(lock)}}
 async put(key,row){const p=this.path(key),tmp=p+'.'+process.pid+'.tmp';const f=await open(tmp,'wx',0o600);try{await f.writeFile(JSON.stringify(row));await f.sync()}finally{await f.close()}await rename(tmp,p);await this.sync()}
 async sync(){const d=await open(this.root,'r');try{await d.sync()}finally{await d.close()}}
}
