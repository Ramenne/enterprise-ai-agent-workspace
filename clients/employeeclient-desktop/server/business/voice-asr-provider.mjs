import {readFile,stat} from 'node:fs/promises';
import {boundedJSON} from './bounded-json.mjs';
import {transcriptText} from '../../src/native/transcript-text.mjs';
export const VOICE_LIMIT=7*1024*1024;
const DEFAULT_BASE='https://dashscope.aliyuncs.com/api/v1';
const REGISTERED_CONFIG='/srv/workspace-services/357b97c5-380c-4017-a332-c747385a7011/private-config/cd46731f-8acc-430a-aa1f-0a8c782152ce/bailian-beijing-asr.private';
const fail=(code,status=503,not_started=true)=>{throw Object.assign(Error(code),{code,status,not_started});};
const wait=(ms,signal)=>new Promise((resolve,reject)=>{const abort=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);reject(new DOMException('Stopped','AbortError'));};const timer=setTimeout(()=>{signal?.removeEventListener('abort',abort);resolve();},ms);signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();});
// The existing ASR key permits this native transcription endpoint, not ordinary
// chat completions. Inline data URI was verified against that actual endpoint.
export function createVoiceASRProvider(config,{fetcher=globalThis.fetch.bind(globalThis),pause=wait}={}){
 if(typeof config?.api_key!=='string'||!config.api_key.trim()||/[\r\n]/.test(config.api_key))fail('voice_asr_configuration_invalid');
 let base;try{base=new URL(config.base_url||DEFAULT_BASE);}catch{fail('voice_asr_configuration_invalid');}
 if(base.protocol!=='https:'||base.username||base.password||base.port||!['/api/v1','/api/v1/'].includes(base.pathname)||base.search||base.hash||!(base.hostname==='dashscope.aliyuncs.com'||/^[a-z0-9-]+\.cn-beijing\.maas\.aliyuncs\.com$/.test(base.hostname))||(config.model&&config.model!=='qwen3-asr-flash-filetrans'))fail('voice_asr_configuration_invalid');
 const BASE=base.href.replace(/\/$/,'');
 const headers={authorization:'Bearer '+config.api_key,'content-type':'application/json'};
 async function json(response,definite=false){
  if(!response.ok){await response.body?.cancel().catch(()=>{});fail(response.status===401||response.status===403?'voice_asr_provider_access_denied':response.status===429?'voice_asr_provider_busy':'voice_asr_provider_rejected',502,definite&&[400,401,403,404,413,415,422,429].includes(response.status));}
  try{return await boundedJSON(response,512*1024);}catch{fail('voice_asr_submission_unconfirmed',502,false);}
 }
 const taskId=id=>{if(typeof id!=='string'||! /^[a-z0-9-]{16,100}$/i.test(id))fail('voice_asr_task_invalid',502,false);return id;};
 async function status(id,{signal}={}){
  taskId(id);signal?.throwIfAborted();let response;
  try{response=await fetcher(BASE+'/tasks/'+encodeURIComponent(id),{headers,signal,redirect:'error'});}catch{fail('voice_asr_result_temporarily_unavailable',503,false);}
  const value=await json(response);if(value.output?.task_id!==id)fail('voice_asr_task_invalid',502,false);
  if(['FAILED','CANCELED'].includes(value.output?.task_status))fail(value.output?.code==='SUCCESS_WITH_NO_VALID_FRAGMENT'?'voice_asr_no_speech':'voice_asr_run_failed',502,false);
  if(['PENDING','RUNNING'].includes(value.output?.task_status))return {state:'running',provider_task_id:id};
  if(value.output?.task_status!=='SUCCEEDED')fail('voice_asr_task_state_unknown',502,false);
  const reference=value.output.result?.transcription_url||value.output.results?.[0]?.transcription_url;
  let url;try{url=new URL(reference);}catch{fail('voice_asr_result_unavailable',502,false);}
  // Some native results use HTTP in their signed URL. Upgrade to HTTPS; OSS
  // signatures cover the object/query, so no plaintext transcript crosses HTTP.
  if(!['https:','http:'].includes(url.protocol)||url.username||url.password||url.port||!/^[-a-z0-9.]+\.oss-[a-z0-9-]+\.aliyuncs\.com$/i.test(url.hostname))fail('voice_asr_result_host_invalid',502,false);url.protocol='https:';
  let result;try{result=await json(await fetcher(url.href,{signal,redirect:'error'}));}catch(e){fail(e.code||'voice_asr_result_unavailable',502,false);}
  const normalized=transcriptText(JSON.stringify(result));if(!normalized.text?.trim()||Buffer.byteLength(normalized.text)>256*1024)fail('voice_asr_result_empty',502,false);
  return {state:'completed',result:{...normalized,machineGenerated:true,provider_task_id:id,...(typeof value.request_id==='string'?{provider_request_id:value.request_id.slice(0,200)}:{})}};
 }
 async function resume(id,{signal}={}){for(;;){signal?.throwIfAborted();const value=await status(id,{signal});if(value.state==='completed')return value.result;await pause(1500,signal);}}
 return {status,resume,async recognize(bytes,mime,{signal,onAccepted=()=>{}}={}){
  signal?.throwIfAborted();if(!Buffer.isBuffer(bytes)||!bytes.length||bytes.length>VOICE_LIMIT)fail('voice_asr_audio_too_large',413);
  const types=new Set(['audio/wav','audio/x-wav','audio/mpeg','audio/mp3','audio/mp4','audio/x-m4a','audio/aac','audio/webm','audio/ogg','audio/flac']);mime=String(mime).split(';')[0].trim().toLowerCase();if(!types.has(mime))fail('voice_asr_format_unsupported',422);
  const body={model:'qwen3-asr-flash-filetrans',input:{file_url:`data:${mime};base64,${bytes.toString('base64')}`},parameters:{enable_itn:false}};
  let response;try{response=await fetcher(BASE+'/services/audio/asr/transcription',{method:'POST',headers:{...headers,'x-dashscope-async':'enable'},body:JSON.stringify(body),signal,redirect:'error'});}catch{fail('voice_asr_submission_unconfirmed',503,false);}
  const submitted=await json(response,true),id=taskId(submitted.output?.task_id);onAccepted(id);return resume(id,{signal});
 }};
}
export async function loadVoiceASRProvider({path=process.env.QN_VOICE_ASR_CONFIG||REGISTERED_CONFIG}={}){
 if(!path)fail('voice_asr_not_configured');
 try{const info=await stat(path);if(!info.isFile()||info.size>16384||(info.mode&0o077))fail('voice_asr_configuration_invalid');return createVoiceASRProvider(JSON.parse(await readFile(path,'utf8')));}
 catch(e){if(e.code==='voice_asr_configuration_invalid')throw e;fail('voice_asr_not_configured');}
}
