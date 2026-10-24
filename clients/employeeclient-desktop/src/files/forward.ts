import type {ChatAttachment} from '@/chat/files';
import type {CloudFile} from './cloud';
export type ForwardAttachment=ChatAttachment&{cloud_file?:CloudFile};
export const isCloudForward=(a:ForwardAttachment):a is ForwardAttachment&{cloud_file:CloudFile}=>!!a.cloud_file;
// Read/edit only: recover drafts created by older releases; new sends use groupSend.
const key=(account:string)=>'qn.forward:'+account;
function pending(account:string):ForwardAttachment[]{
 let raw:string|null;
 try{raw=localStorage.getItem(key(account));}catch{throw Error('无法读取待发送群附件，请检查本机存储');}
 if(!raw)return [];
 try{const value=JSON.parse(raw);const items=Array.isArray(value)?value:[value];if(items.every(a=>a?.id&&a?.file_id))return items;}
 catch{}
 throw Error('待发送群附件数据异常，已停止写入以免覆盖原稿');
}
export function clearForwards(account:string){try{localStorage.removeItem(key(account));}catch{}}
export function pendingForwards(account:string,capacity=6,already:string[]=[]):ForwardAttachment[]{
 if(capacity<1)return [];
 const selected:ForwardAttachment[]=[],seen=new Set(already);
 for(const a of pending(account)){
  if(seen.has(a.id))continue;
  if(selected.length<capacity){selected.push(a);seen.add(a.id);}
 }
 return selected;
}
export function updateForward(account:string,a:ForwardAttachment){
 const items=pending(account),at=items.findIndex(x=>x.id===a.id);
 if(at<0)return;
 items[at]=a;
 try{localStorage.setItem(key(account),JSON.stringify(items));}
 catch{throw Error('无法更新待发送群附件名称，请检查本机存储');}
}
export function replaceForward(account:string,oldId:string,a:ForwardAttachment){
 const items=pending(account),at=items.findIndex(x=>x.id===oldId);
 if(at<0)return;
 items[at]=a;
 try{localStorage.setItem(key(account),JSON.stringify(items));}
 catch{throw Error('无法保存已准备的群附件，请检查本机存储');}
}
export function removeForwards(account:string,ids:string[]){
 if(!ids.length)return;
 const remove=new Set(ids),remaining=pending(account).filter(a=>!remove.has(a.id));
 try{if(remaining.length)localStorage.setItem(key(account),JSON.stringify(remaining));else localStorage.removeItem(key(account));}
 catch{throw Error('无法清除已发送的群附件草稿，请检查本机存储');}
 window.dispatchEvent(new Event('qn-file-forward'));
}
