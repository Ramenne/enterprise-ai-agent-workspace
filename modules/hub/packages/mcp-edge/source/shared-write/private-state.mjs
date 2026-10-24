import{constants as C}from'node:fs';
import{open,mkdir,lstat,rename,unlink}from'node:fs/promises';
import{join}from'node:path';
import{randomUUID}from'node:crypto';
import{spawn}from'node:child_process';
import{fileURLToPath}from'node:url';
const check=id=>{if(!/^[a-f0-9]{64}$/.test(id))throw Error('invalid_item_id');};
export async function createPrivateState(root,uid=process.getuid()){
 await mkdir(root,{recursive:true,mode:0o700});const st=await lstat(root);
 if(!st.isDirectory()||st.isSymbolicLink()||st.uid!==uid||(st.mode&0o777)!==0o700)throw Error('private_state_directory_required');
 const syncDir=async()=>{const f=await open(root,C.O_RDONLY|C.O_DIRECTORY);try{await f.sync();}finally{await f.close();}};
 return{
  async load(id){check(id);let f;try{f=await open(join(root,id+'.json'),C.O_RDONLY|C.O_NOFOLLOW);}catch(e){if(e.code==='ENOENT')return null;throw e;}
   try{const s=await f.stat();if(!s.isFile()||s.uid!==uid||(s.mode&0o777)!==0o600||s.size>1048576)throw Error('unsafe_item_state');return JSON.parse(await f.readFile('utf8'));}finally{await f.close();}},
  async save(id,value){check(id);const text=JSON.stringify(value);
   if(Buffer.byteLength(text,'utf8')>1048576||/"(?:access_token|session_token|secret_access_key|password|credential)"\s*:/.test(text))throw Error('unsafe_item_state');
   const temp=join(root,id+'.'+randomUUID()+'.tmp');const f=await open(temp,C.O_CREAT|C.O_EXCL|C.O_WRONLY|C.O_NOFOLLOW,0o600);
   try{await f.writeFile(text);await f.sync();}finally{await f.close();}
   try{await rename(temp,join(root,id+'.json'));await syncDir();}catch(e){await unlink(temp).catch(()=>{});throw e;}},
  async exclusive(id,work){check(id);
   const child=spawn('python3',[fileURLToPath(new URL('./item-lock.py',import.meta.url)),join(root,id+'.lock')],{stdio:['pipe','pipe','pipe']});
   const ready=new Promise((resolve,reject)=>{let data='';child.stdout.on('data',b=>{data+=b.toString('ascii');if(data==='locked\n')resolve();});
    child.once('error',reject);child.once('exit',code=>{if(data!=='locked\n')reject(Object.assign(Error(code===3?'item_in_progress':'item_lock_unavailable'),{status:code===3?409:503,retryable:true}));});});
   const closed=new Promise(resolve=>child.once('close',resolve));
   try{await ready;return await work();}finally{child.stdin.end();await closed;}
  }
 };
}
