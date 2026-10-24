// Recovery is read-only: opening a page cannot create or restart a model task.
/** @param {any} request @param {any} saved @param {{signal?:AbortSignal,valid?:()=>boolean}} options */
export async function recoverTranscript(request,saved,options={}){
 const {signal,valid=()=>Boolean(true)}=options;
 if(!saved?.job)throw Error('原转写记录尚未建立，请重新查询');
 const r=await request('GET','status',{query:{job_id:saved.job},signal,timeoutMs:15000});
 if(!valid())throw new DOMException('账号已变化','AbortError');
 if(r.state==='no_speech')return {text:'',noSpeech:true};
 if(r.state!=='completed'||typeof r.result?.text!=='string'||!r.result.text.trim())throw Error('原转写尚未完成，请点击重试继续查询');
 return r.result;
}
