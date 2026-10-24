// A local recovery journal, never a second authoritative message ledger.
import {fileDigest} from './uploadReceipts';
import type {UploadFile,ChatAttachment} from '@/chat/files';
import type {ChatSendBody,ChatMessage} from '@/api/types';
export type TransferRecord={version:1;id:string;account:string;peer:string;requestKey:string;message:ChatSendBody;purpose:'file'|'voice';duration?:number;smallMedia:boolean;sendConfirmed?:boolean;receiptPending?:boolean;file:{name:string;type:string;size:number;lastModified:number;sha256:string};source?:Blob;attachment?:ChatAttachment;receipt?:ChatMessage;state:'pending'|'paused'|'error'|'complete';createdAt:number};
export const MAX_RECOVERY_SOURCE=8*1024*1024;
export const transferIdentity=(account:string,peer:string,key:string)=>JSON.stringify([account,peer,key]);
let database:Promise<IDBDatabase>|undefined;
function open(){return database??=new Promise<IDBDatabase>((resolve,reject)=>{
 const request=indexedDB.open('employeeclient-transfer-outbox',1);
 request.onupgradeneeded=()=>{const store=request.result.createObjectStore('tasks',{keyPath:'id'});store.createIndex('scope',['account','peer']);};
 request.onsuccess=()=>{request.result.onversionchange=()=>{request.result.close();database=undefined;};resolve(request.result);};
 request.onerror=()=>{database=undefined;reject(request.error||Error('本机恢复记录无法打开'));};
});}
function validate(r:TransferRecord,account=r?.account,peer=r?.peer){
 if(r?.version!==1||!account||r.account!==account||r.peer!==peer||typeof r.requestKey!=='string'||!r.requestKey||r.id!==transferIdentity(account,peer,r.requestKey)||!['file','voice'].includes(r.purpose)||typeof r.smallMedia!=='boolean'||!r.message||typeof r.message!=='object'||!r.file||!Number.isSafeInteger(r.file.size)||r.file.size<=0||r.file.size>100*1024**3||typeof r.file.name!=='string'||typeof r.file.type!=='string'||!/^[a-f0-9]{64}$/.test(r.file.sha256)||!['pending','paused','error','complete'].includes(r.state))throw Error('附件待发恢复记录无法读取，请保留本机数据');
 if(r.source&&(!(r.source instanceof Blob)||r.source.size!==r.file.size))throw Error('待发文件恢复记录不完整');
 if(r.sendConfirmed!==undefined&&typeof r.sendConfirmed!=='boolean'||r.sendConfirmed===false&&(r.attachment||r.receipt||r.state==='complete'))throw Error('待发文件确认状态不匹配，请保留本机数据');
 if(r.receiptPending!==undefined&&typeof r.receiptPending!=='boolean'||r.receiptPending&&(r.sendConfirmed===false||r.receipt))throw Error('附件回执确认状态不匹配');
 if(r.state==='complete'&&!r.receipt)throw Error('附件恢复记录缺少发送回执');
 if(r.receipt&&(!r.receipt.id||r.receipt.author_username!==account||(r.receipt.conversation_peer||'')!==peer||!r.attachment||!r.receipt.attachments?.some(a=>a.id===r.attachment!.id)))throw Error('附件发送恢复回执不匹配');
 return r;
}
export async function prepareTransfer(account:string,peer:string,key:string,message:ChatSendBody,file:UploadFile,purpose:'file'|'voice',duration:number|undefined,smallMedia:boolean,check:()=>void,progress:(loaded:number)=>void):Promise<TransferRecord>{
 check();const digest=await fileDigest(file,check,progress);check();
 let source:Blob|undefined;
 if(file.size<=MAX_RECOVERY_SOURCE){source=file instanceof Blob?file:file.readPart?await file.readPart(0,file.size):file.slice!(0,file.size);check();if(source.size!==file.size||await fileDigest(new File([source],file.name),check)!==digest)throw Error('待发原文件在准备期间已变化');}
 return validate({version:1,id:transferIdentity(account,peer,key),account,peer,requestKey:key,message:JSON.parse(JSON.stringify(message)),purpose,duration,smallMedia,file:{name:file.name,type:file.type||'',size:file.size,lastModified:file.lastModified||0,sha256:digest},source,state:'pending',createdAt:Date.now()});
}
export async function putTransfer(record:TransferRecord){
 validate(record);const db=await open();
 // Strip proxies from JSON fields while preserving the Blob's exact bytes.
 const plain={...JSON.parse(JSON.stringify({...record,source:undefined})),...(record.source?{source:record.source}:{})};
 const tx=db.transaction('tasks','readwrite');tx.objectStore('tasks').put(plain);
 await new Promise<void>((resolve,reject)=>{tx.oncomplete=()=>resolve();tx.onerror=tx.onabort=()=>reject(tx.error||Error('本机待发恢复记录未能保存'));});
}
export async function readTransfers(account:string,peer:string){
 const db=await open(),tx=db.transaction('tasks','readonly'),request=tx.objectStore('tasks').index('scope').getAll([account,peer]);
 const records=await new Promise<TransferRecord[]>((resolve,reject)=>{request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
 return records.map(r=>validate(r,account,peer));
}
export async function removeTransfer(id:string){const db=await open(),tx=db.transaction('tasks','readwrite');tx.objectStore('tasks').delete(id);await new Promise<void>((resolve,reject)=>{tx.oncomplete=()=>resolve();tx.onerror=tx.onabort=()=>reject(tx.error);});}
export function restoredTransferSource(record:TransferRecord):UploadFile|undefined{return record.source?new File([record.source],record.file.name,{type:record.file.type,lastModified:record.file.lastModified}):undefined;}
export async function verifyTransferSource(record:TransferRecord,file:UploadFile,check:()=>void){
 if(file.size!==record.file.size||await fileDigest(file,check)!==record.file.sha256)throw Error('选择的文件与原待发内容不一致，请选择原文件');check();
 return {name:record.file.name,type:record.file.type,size:record.file.size,lastModified:record.file.lastModified,readPart:(start:number,end:number)=>file.readPart?file.readPart(start,end):Promise.resolve(file.slice!(start,end))};
}
