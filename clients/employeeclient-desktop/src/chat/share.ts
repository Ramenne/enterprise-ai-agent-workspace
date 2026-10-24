import type {UploadFile} from './files';
import { Capacitor, registerPlugin } from '@capacitor/core';
interface SharedFile { id: string; name: string; size: number; mime?: string; path: string; }
const Share = registerPlugin<{ readPart(o:{id:string;offset:number;size:number}):Promise<{data:string;size:number}>;peek(): Promise<{ files: SharedFile[] }>; clear(): Promise<void>; acknowledge(body: { id: string }): Promise<void> }>('EmployeeClientShare');
export const supportsIncomingShare = () => Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';
export const pendingSharedFiles = async () => supportsIncomingShare() ? (await Share.peek()).files : [];
export const clearSharedFiles = async () => { if (supportsIncomingShare()) await Share.clear(); };
export async function readSharedFile(source:SharedFile,signal?:AbortSignal):Promise<UploadFile>{
 if(source.size<1||source.size>100*1024**3)throw Error('分享文件超出100GB');
 return {name:source.name,type:source.mime||'application/octet-stream',size:source.size,lastModified:0,async readPart(start,end){
  const chunks:Uint8Array<ArrayBuffer>[]=[];for(let offset=start;offset<end;){if(signal?.aborted)throw new DOMException('已暂停','AbortError');const n=Math.min(524288,end-offset),r=await Share.readPart({id:source.id,offset,size:n}),bytes=Uint8Array.from(atob(r.data),c=>c.charCodeAt(0));if(bytes.length!==n||r.size!==source.size)throw Error('分享文件读取不完整');chunks.push(bytes);offset+=n;}return new Blob(chunks,{type:source.mime||'application/octet-stream'});
 }};
}

export const acknowledgeSharedFile = (id: string) => Share.acknowledge({ id });
