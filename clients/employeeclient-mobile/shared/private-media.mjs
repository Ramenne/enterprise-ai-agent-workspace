// Authenticated, independently seekable blocks. Never reuse a grant for a
// different plaintext: its whole-file digest is bound before issuing the key.
export const PRIVATE_BLOCK=1024*1024;
export const encryptedSize=size=>size+16*Math.ceil(size/PRIVATE_BLOCK);
export function privateIV(prefix,index){
 const iv=new Uint8Array(12);iv.set(prefix);new DataView(iv.buffer).setUint32(8,index,false);return iv;
}
export function privateAAD(id,index,size){return new TextEncoder().encode(JSON.stringify(['qn-private-media-v1',id,index,size]));}
export async function encryptedSource(file,grant,check=()=>{}){
 const raw=Uint8Array.from(atob(grant.key_base64),c=>c.charCodeAt(0)),prefix=Uint8Array.from(atob(grant.iv_prefix),c=>c.charCodeAt(0));
 if(raw.length!==32||prefix.length!==8||grant.size!==file.size)throw Error('私聊文件授权无效');
 const key=await crypto.subtle.importKey('raw',raw,'AES-GCM',false,['encrypt']);
 const size=encryptedSize(file.size),stride=PRIVATE_BLOCK+16;
 return {name:grant.id+'.qnenc',type:'application/octet-stream',size,lastModified:0,readPart:async(start,end)=>{
  check();if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||end<start||end>size||end-start>16*1024*1024)throw Error('私聊文件读取范围无效');
  const parts=[];
  for(let index=Math.floor(start/stride);index*stride<end;index++){
   const from=index*PRIVATE_BLOCK,to=Math.min(file.size,from+PRIVATE_BLOCK);
   const plain=file.readPart?await file.readPart(from,to):file.slice(from,to);check();
   if(plain.size!==to-from)throw Error('私聊文件已变化');
   const bytes=new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv:privateIV(prefix,index),additionalData:privateAAD(grant.id,index,file.size)},key,await plain.arrayBuffer()));check();
   parts.push(bytes.slice(Math.max(0,start-index*stride),Math.min(bytes.length,end-index*stride)));
  }return new Blob(parts);
 }};
}
