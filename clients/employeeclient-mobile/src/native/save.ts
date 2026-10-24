import {Capacitor} from '@capacitor/core';
import {attachmentKey} from '@/platform/attachmentCache';
import {prepareBrowserSave,type BrowserSaveTarget} from '@/platform/saveFile';
import {native} from '@/collaboration/media';
export async function reserveSave(name:string):Promise<BrowserSaveTarget|undefined>{return Capacitor.isNativePlatform()?undefined:prepareBrowserSave(name);}
export async function saveVerified(blob:Blob,name:string,hash:string,identity:string[],valid:()=>boolean,target?:BrowserSaveTarget){
 if(!valid()){target?.cancel();throw Error('会话已变化');}
 if(!Capacitor.isNativePlatform())return (target||await prepareBrowserSave(name)).save(blob);
 const key=await attachmentKey(identity);if(!valid())throw Error('会话已变化');
 const {id}=await native.begin({name,mime:blob.type||'application/octet-stream',key});
 try{
  for(let offset=0;offset<blob.size;offset+=131072){
   if(!valid())throw Error('会话已变化');
   const bytes=new Uint8Array(await blob.slice(offset,offset+131072).arrayBuffer());let str='';for(const b of bytes)str+=String.fromCharCode(b);
   await native.append({id,data:btoa(str),offset});
  }
  if(!valid())throw Error('会话已变化');
  await native.finish({id,size:blob.size,sha256:hash});
  if(!valid())throw Error('会话已变化');
  const saved=await native.save({id});
  if(!saved.saved||saved.size!==blob.size||saved.sha256!==hash)throw Error('设备保存结果未通过校验');
  return {state:'saved',message:'已保存到'+saved.location};
 }catch(e){await native.remove({id}).catch(()=>{});throw e;}finally{await native.release({id}).catch(()=>{});}
}
