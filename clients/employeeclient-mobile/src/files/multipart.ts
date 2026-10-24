import {sha256} from '@noble/hashes/sha2.js';
import {md5} from '@noble/hashes/legacy.js';
import {bytesToHex} from '@noble/hashes/utils.js';
export type UploadSource={size:number;slice?:(start:number,end:number)=>Blob;readPart?:(start:number,end:number)=>Promise<Blob>};
export type UploadGrant={id:string;endpoint:string;capability:string;size:number;part_size:number;state:string;sha256?:string};
export function validGrant(g:UploadGrant){if(!/^https:\/\/mengchu\.workspace\.cloud\/api\/uploads\/[A-Za-z0-9_-]{24}$/.test(g.endpoint)||!/^[A-Za-z0-9_-]{43}$/.test(g.capability)||g.part_size!==16*1024**2||!Number.isSafeInteger(g.size)||g.size<1||g.size>100*1024**3)throw Error('云端上传授权无效');}
export async function uploadCall(g:UploadGrant,action:string,body:unknown={},signal?:AbortSignal){
 validGrant(g);if(!['status','wait','part','complete','cancel'].includes(action))throw Error('上传操作无效');
 const c=new AbortController(),cancel=()=>c.abort(signal?.reason);if(signal?.aborted)cancel();else signal?.addEventListener('abort',cancel,{once:true});const timer=setTimeout(()=>c.abort(),60000);try{
 const r=await fetch(g.endpoint+'/'+action,{method:'POST',headers:{Authorization:'Upload '+g.capability,'Content-Type':'application/json'},body:JSON.stringify(body),signal:c.signal,redirect:'error',credentials:'omit'});
 if(!r.ok)throw Error(r.status===403?'上传授权已过期，请重新点击保存':'上传暂未完成，可重试继续');return await r.json();}finally{clearTimeout(timer);signal?.removeEventListener('abort',cancel);}
}
const wait=(signal:AbortSignal|undefined,ms=1000)=>new Promise<void>((resolve,reject)=>{const cancel=()=>{clearTimeout(timer);reject(new DOMException('已暂停','AbortError'));};const timer=setTimeout(()=>{signal?.removeEventListener('abort',cancel);resolve();},ms);if(signal?.aborted)cancel();else signal?.addEventListener('abort',cancel,{once:true});});
export async function waitUpload(g:UploadGrant,signal?:AbortSignal,progress:(s:string)=>void=()=>{}){
 let previous=-1,lastChange=Date.now();
 let r=await uploadCall(g,'status',{},signal);
 for(;;){if(signal?.aborted)throw new DOMException('已暂停','AbortError');
  if(r.state==='complete')return r;if(r.error||['cancelled','failed'].includes(r.state))throw Error('保存未完成，可以重试继续');
  const loaded=(r.parts||[]).reduce((n:number,p:{size:number})=>n+p.size,0);
  if(loaded!==previous){previous=loaded;lastChange=Date.now();}
  if(r.state==='uploading'&&Date.now()-lastChange>90000)throw Error('上传暂时没有进展，请检查电脑连接后重试');
  progress(['merging','verifying'].includes(r.state)?'校验云端文件…':r.state==='copying'?'准备群附件…':`保存到梦空间 ${Math.floor(loaded/g.size*100)}%`);
  // Dream Storage wakes this bounded wait on state transitions. The 15-second
  // timeout only reconciles direct COS parts or a restarted server process.
  r=await uploadCall(g,'wait',{after:Number(r.revision)||0},signal);
 }
}
export async function uploadBlob(file:UploadSource,g:UploadGrant,signal?:AbortSignal,progress:(s:string)=>void=()=>{}){
 validGrant(g);if(file.size!==g.size)throw Error('文件大小已变化');const state=await uploadCall(g,'status',{},signal),existing=new Map<number,{size:number;etag:string}>((state.parts||[]).map((p:any)=>[p.number,p]));
 const hash=sha256.create();let n=0;
 for(let offset=0;offset<file.size;offset+=g.part_size){
  if(signal?.aborted)throw new DOMException('已暂停','AbortError');n++;
  const end=Math.min(file.size,offset+g.part_size),part=file.readPart?await file.readPart(offset,end):file.slice!(offset,end),bytes=new Uint8Array(await part.arrayBuffer());
  // Bounded chunks, never file.arrayBuffer() for the entire original.
  for(let i=0;i<bytes.length;i+=524288){hash.update(bytes.subarray(i,i+524288));if(signal?.aborted)throw new DOMException('已暂停','AbortError');await wait(signal,0);}
  const old=existing.get(n);
  if(state.state!=='complete'&&(!old||old.size!==bytes.length||old.etag.replaceAll('"','')!==bytesToHex(md5(bytes)))){
   const ticket=await uploadCall(g,'part',{number:n},signal),u=new URL(ticket.url);
   if(u.protocol!=='https:'||u.hostname!=='mengstore-1316920087.cos.ap-shanghai.myqcloud.com'||u.port||u.username||u.password||ticket.size!==part.size)throw Error('云端分片地址无效');
   const r=await fetch(ticket.url,{method:'PUT',headers:ticket.headers,body:part,signal,credentials:'omit',redirect:'error'});if(!r.ok)throw Error('上传中断，重试将继续未完成部分');
  }
  progress(`上传 ${Math.floor(Math.min(file.size,offset+part.size)/file.size*100)}%`);
 }
 const sha=bytesToHex(hash.digest());if(state.state==='complete'){if(state.sha256!==sha)throw Error('重试文件内容已变化');return state;}
 await uploadCall(g,'complete',{sha256:sha},signal);return waitUpload(g,signal,progress);
}
