import {apiRequest,captureApiLease} from '@/api/client';
import {resolveNativeFile,EMPLOYEECLIENT_PROJECT} from '@/files/native-library';
import {transcribeOperation} from './transcription-operation.mjs';
import {recoverTranscript} from './transcription-recovery.mjs';
import {privateDownload} from './private-files';
import {voiceSource} from './transcription-source.mjs';
import type {RequestOptions} from '@/api/client';
export async function transcribeVoice(id:string,signal:AbortSignal,onProgress:(text:string)=>void=()=>{},source?:{sha256:string}){
 const controller=new AbortController(),cancel=()=>controller.abort();
 let timedOut=false;
 if(signal.aborted)cancel();else signal.addEventListener('abort',cancel,{once:true});
 const timer=setTimeout(()=>{timedOut=true;controller.abort();},180000);
 try{return await transcribeVoiceOperation(id,controller.signal,onProgress,source);}
 catch(error){if(timedOut)throw Error('转文字等待超时，原操作已保留；重试会查询原结果');throw error;}
 finally{clearTimeout(timer);signal.removeEventListener('abort',cancel);}
}
async function transcribeVoiceOperation(id:string,signal:AbortSignal,onProgress:(text:string)=>void,source?:{sha256:string}){
 onProgress('正在读取语音…');
 const lease=captureApiLease();
 const key='qn.asr:'+lease.account+':'+id;
 const readState=(name:string)=>{try{return JSON.parse(localStorage.getItem(name)||'null');}catch{throw Error('转写历史记录无法读取，原记录已保留，请联系维护');}};
 const original=readState(key),oldProduct=readState(key+':central-v1'),unifiedKey=key+':product-v2';
 const voiceKey=key+':voice-v1',legacy=readState(unifiedKey)||oldProduct,central=!id.startsWith('private:')&&(!!legacy||!!original?.job?.run_id),stateKey=central?unifiedKey:voiceKey;
 const saved=readState(stateKey)|| (central?oldProduct:null),route=central?'asr':'voice-asr';
 const input=await voiceSource(id,source,saved,async()=>id.startsWith('private:')?{project_id:EMPLOYEECLIENT_PROJECT,private_attachment_id:id,sha256:(await privateDownload(id,signal)).attachment.sha256}:({project_id:EMPLOYEECLIENT_PROJECT,...(await resolveNativeFile(id,signal)).file.fixed_ref}),EMPLOYEECLIENT_PROJECT);
 if(signal.aborted||!lease.valid())throw new DOMException('账号已变化或操作已暂停','AbortError');
 return transcribeOperation((method:string,action:string,options:RequestOptions)=>apiRequest(method,'/business/v1/'+route+'/'+action,options),input,{signal,onProgress,valid:lease.valid,
  inline:!central,originalRun:central?original?.job?.run_id:undefined,load:()=>readState(stateKey)||(central?oldProduct:null),save:(state:any)=>localStorage.setItem(stateKey,JSON.stringify(state))});
}

// Re-entry only reads an existing actor-bound job; it never prepares or starts ASR.
export async function readExistingVoiceTranscript(id:string,signal:AbortSignal){
 const lease=captureApiLease(),key='qn.asr:'+lease.account+':'+id;
 let saved,route='asr';try{const voice=localStorage.getItem(key+':voice-v1');if(voice){saved=JSON.parse(voice);route='voice-asr';}else saved=JSON.parse(localStorage.getItem(key+':product-v2')||localStorage.getItem(key+':central-v1')||'null');}catch{throw Error('转写历史记录无法读取');}
 return recoverTranscript((method:string,action:string,options:RequestOptions)=>apiRequest(method,'/business/v1/'+route+'/'+action,options),saved,{signal,valid:lease.valid});
}
