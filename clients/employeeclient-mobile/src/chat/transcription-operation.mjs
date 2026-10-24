import {NativeError} from '../native/client.mjs';
/** @param {{load?:()=>any,save?:(state:any)=>void,valid?:()=>boolean,signal?:AbortSignal,wait?:(ms:number)=>Promise<void>,deadline?:number,onProgress?:(text:string)=>void,originalRun?:string,inline?:boolean}} options */
export async function transcribeOperation(request,input,options={}){
 const {load=()=>null,save=(_state)=>{},valid=()=>Boolean(true),signal,wait=ms=>new Promise(r=>setTimeout(r,ms)),deadline=Date.now()+180000,onProgress=(_text)=>{},originalRun}=options;
 const active=()=>{if(signal?.aborted)throw new DOMException('已暂停','AbortError');if(!valid())throw new NativeError('session_changed',401);};active();
 let state=load();const identity=JSON.stringify(input.private_attachment_id?[input.project_id,'private',input.private_attachment_id,input.sha256]:[input.project_id,input.material_id,input.version_id,input.sha256]);
 if(state&&state.identity!==identity)throw new NativeError('transcription_source_changed',409);
 if(!state){state={identity,prepareKey:crypto.randomUUID()};save(state);}
 let result;
 if(!state.job){const prepared=await request('POST','prepare',{body:{input,external_audio_release:true,...(originalRun?{original_run_id:originalRun}:{})},idempotencyKey:state.prepareKey,signal,timeoutMs:60000});active();if(!prepared.job_id)throw new NativeError('transcription_job_missing',502);state.job=prepared.job_id;save(state);if(prepared.state)result=prepared;}
 onProgress('正在查询原转写…');
 if(!result)result=await request('GET','status',{query:{job_id:state.job},signal,timeoutMs:60000});active();
 if(result.state==='prepared'||options.inline&&result.transport!=='central'&&result.state==='running'){onProgress('正在连接转写服务…');result=await request('POST','start',{body:{job_id:state.job},idempotencyKey:(state.prepareKey||'qn-asr:'+state.job)+'-start',signal,timeoutMs:options.inline?150000:60000});active();}
 for(;;){
  active();if(result.state==='completed'&&(typeof result.result?.text!=='string'||!result.result.text.trim()))throw new NativeError('转写结束但没有可显示的文字，请重试读取原结果',502);
  if(result.state==='completed'&&typeof result.result?.text==='string')return {...result.result,job_id:state.job,machineGenerated:true};
  if(['submission_unknown','submitting'].includes(result.state))throw new NativeError('提交结果尚未确认，保留原作业，不会再次发送音频',409);
  if(['scope_needed','draft_ready_external_scope_needed'].includes(result.reason_code))throw new NativeError('这段语音尚未获得当前模型的外发授权，原操作已保留',403);
  if(result.state==='blocked'&&result.reason_code?.startsWith('voice_asr_'))throw new NativeError(result.reason_code==='voice_asr_not_configured'?'转写服务尚未配置，原操作已保留':result.reason_code==='voice_asr_audio_too_large'?'语音过长，请分段转写':result.reason_code==='voice_asr_provider_busy'?'转写服务繁忙，请稍后重试':'转写服务暂不可用，原操作已保留，请重试',409);
  if(result.state==='blocked')throw new NativeError(result.reason_code==='revision_conflict'?'转写启动版本已变化，请重试恢复原作业':'转写尚未启动，原作业已保留：'+(result.reason_code||'启动被拒绝'),409);
  if(result.state==='failed')throw new NativeError('语音转写失败，原作业已保留，请重试查询',502);
  if(Date.now()>=deadline)throw new NativeError('转写仍在处理，请稍后查询原作业',503);
  if(result.state==='prepared')throw new NativeError('转写尚未启动，请重试查询原作业',409);
  if(!['queued','running'].includes(result.state))throw new NativeError('转写状态无法确认，原作业已保留，请重试查询',502);
  if(options.inline&&result.transport!=='central')throw new NativeError('原转写仍在处理，请稍后查看原结果',409);
  onProgress(result.state==='queued'?'正在等待转写服务…':'正在转文字…');await wait(1500);active();result=await request('GET','poll',{query:{job_id:state.job},signal,timeoutMs:60000});active();
 }
}
