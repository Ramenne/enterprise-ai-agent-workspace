import {readFileSync} from 'node:fs';
export const visualTools=JSON.parse(readFileSync(new URL('./visual-contract.json',import.meta.url),'utf8'));
const origin='http://127.0.0.1:18292/api/h3-cloud/mcp/';
async function domain(name,args,token){
 const r=await fetch(origin+encodeURIComponent(name),{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify(args),redirect:'error',signal:AbortSignal.timeout(120000)});
 const d=await r.json();
 if(!r.ok)throw Object.assign(Error(d.detail?.code||'visual_domain_rejected'),{status:r.status,detail:d});
 return d;
}
export async function invokeVisual(name,args,token){
 if(name==='visual.lora.import'&&args.target==='autodl')throw Object.assign(Error('autodl_reserved_for_lora_training'),{status:409});
 if(name==='visual.image.generate'){
  let existing=false;
  try{await domain('visual.job.get',{id:args.idempotency_key,kind:'image'},token);existing=true;}
  catch(e){if(e.status!==404||e.message!=='job_not_found_in_current_owner_scope')throw e;}
  if(!existing){
   const {idempotency_key,...previewArgs}=args;
   const p=await domain('visual.image.preview',previewArgs,token);
   if(p.route?.provider!=='comfy_cloud'||p.route?.action!=='route_new_job')throw Object.assign(Error('generation_cloud_only_backend_route_not_ready'),{status:503});
  }
 }
 const d=await domain(name,args,token);
 if(name==='visual.image.preview'){
  if(d.route?.provider!=='comfy_cloud'||d.route?.action!=='route_new_job')throw Object.assign(Error('generation_cloud_only_backend_route_not_ready'),{status:503});
  d.route={...d.route,reason:'generation_cloud_only'};d.autodl={state:'training_only',ready:false};
 }
 if(name==='visual.capabilities'){
  d.routing={batch_images:'comfy_cloud_only',sporadic_images:'comfy_cloud_only',video_reference_images:'comfy_cloud_only',video:'comfy_cloud_only',training:'autodl_only',max_autodl_wait_seconds:0,historical_jobs:'observe_original_provider'};
  d.autodl={state:'training_only',ready:false};
  d.policy_version='2026-10-21-cloud-generation-autodl-training';
 }
 return d;
}
export function visualResult(id,data){
 if(data.image_base64){const {image_base64,...metadata}=data;return {jsonrpc:'2.0',id,result:{content:[{type:'text',text:JSON.stringify(metadata)},{type:'image',mimeType:data.mime_type,data:image_base64}],structuredContent:metadata}};}
 return {jsonrpc:'2.0',id,result:{content:[{type:'text',text:JSON.stringify(data)}],structuredContent:data}};
}
