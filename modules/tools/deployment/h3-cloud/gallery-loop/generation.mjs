import {createHash} from 'node:crypto';
const fail=(status,message)=>Object.assign(Error(message),{status});
const uuid=s=>typeof s==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s);
const canonical=v=>v&&typeof v==='object'?(Array.isArray(v)?'['+v.map(canonical).join(',')+']':'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}'):JSON.stringify(v);
const stamp=()=>new Date().toISOString();
const terminal=s=>['published','failed','cancelled','canceled','rejected','rejected_payment_required'].includes(s);
export function generationInput(args,{paid=false}={}){
 if(!args||typeof args!=='object'||Array.isArray(args))throw fail(400,'生成参数无效');
 const allowed=['prompt','width','height','seed','title','kind','sources','idempotency_key','generation_authorized','estimated_credits','budget_credits','lora_id','lora_strength'];
 if(Object.keys(args).some(k=>!allowed.includes(k)))throw fail(400,'包含当前生成接口不支持的字段');
 if(typeof args.prompt!=='string'||!args.prompt.trim()||args.prompt.length>10000)throw fail(400,'请填写10000字以内的实际提示词');
 if(/[\r\n]/.test(args.prompt)||args.prompt.includes('--')||args.prompt.startsWith('-'))throw fail(400,'统一生成通路要求单行纯提示词');
 const width=args.width??1024,height=args.height??1024,seed=args.seed??42424242;
 if([width,height].some(v=>!Number.isInteger(v)||v<512||v>2048||v%16)||width*height>2097152)throw fail(400,'宽高须为512–2048之间的16倍数，总像素不超过2MP');
 if(!Number.isSafeInteger(seed)||seed<0||seed>4294967295)throw fail(400,'种子须为0至4294967295的整数');
 if(args.title!==undefined&&(typeof args.title!=='string'||args.title.length>120))throw fail(400,'作品名称最多120字');
 if(args.kind!==undefined&&!['场景','角色','静物'].includes(args.kind))throw fail(400,'作品类型无效');
 if(args.sources!==undefined&&(!Array.isArray(args.sources)||args.sources.length>40))throw fail(400,'来源片段最多40条');
 if(args.lora_id!==undefined&&!uuid(args.lora_id))throw fail(400,'LoRA编号无效');
 if(args.lora_strength!==undefined&&(!args.lora_id||typeof args.lora_strength!=='number'||!Number.isFinite(args.lora_strength)||args.lora_strength < -2||args.lora_strength>2))throw fail(400,'LoRA权重需配合已导入的LoRA，范围-2至2');
 if(paid){
  if(!uuid(args.idempotency_key))throw fail(400,'请保留有效生成任务编号');
  if(args.generation_authorized!==true)throw fail(400,'请通过生成按钮明确提交本次任务');
  if([args.estimated_credits,args.budget_credits].some(v=>typeof v!=='number'||!Number.isFinite(v)||v<=0)||args.estimated_credits>args.budget_credits)throw fail(400,'请填写预计积分和预算，预计值不能超过预算');
 }
 const upstream={prompt:args.prompt.trim(),profile:'turbo',width,height,seed,...(args.lora_id?{lora_id:args.lora_id,...(args.lora_strength!==undefined?{lora_strength:args.lora_strength}:{})}:{})};
 if(paid)Object.assign(upstream,{generation_authorized:true,estimated_credits:args.estimated_credits,budget_credits:args.budget_credits});
 return upstream;
}
export function createGeneration({db,galleryTools,base=process.env.COMFY_API_BASE||'http://127.0.0.1:18292/api/h3-cloud/unified/krea2'}){
 db.exec('CREATE TABLE IF NOT EXISTS gallery_generation_jobs(actor_id TEXT NOT NULL,id TEXT NOT NULL,request_hash TEXT NOT NULL,body TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(actor_id,id));');
 const pending=new Set(),syncing=new Map(),submitting=new Set();let closed=false;
 const put=j=>db.prepare('UPDATE gallery_generation_jobs SET body=? WHERE actor_id=? AND id=?').run(JSON.stringify({...j,updated_at:stamp()}),j.actor_id,j.id);
 const get=(id,me)=>{if(!uuid(id))throw fail(400,'任务编号无效');const row=db.prepare('SELECT body FROM gallery_generation_jobs WHERE actor_id=? AND id=?').get(me.id,id);if(!row)throw fail(404,'当前成员没有这个生成任务');return JSON.parse(row.body)};
 const publicJob=j=>{const {actor_id,upstream,...rest}=j;return rest};
 async function request(path,token,{method='GET',body,idem,bytes=false}={}){
  let r;try{r=await fetch(base+path,{method,headers:{Authorization:'Bearer '+token,...(body?{'Content-Type':'application/json'}:{}),...(idem?{'Idempotency-Key':idem}:{})},...(body?{body:JSON.stringify(body)}:{}),redirect:'error',signal:AbortSignal.timeout(method==='POST'?120000:25000)})}catch{throw fail(502,'生成服务暂时无法确认状态，请保留任务编号后查询')}
  if(!r.ok){let code='';try{const d=await r.json();code=typeof d.detail==='object'?d.detail?.code:d.code||d.detail||''}catch{}
   const messages={401:'当前成员身份未能通过生成服务验证',403:'当前成员没有可用的Comfy调用配置权限',402:'Comfy账户余额不足',404:'生成服务尚未找到这个任务',409:'任务编号已绑定其他内容',422:'生成参数或授权配置未通过检查',429:'生成服务繁忙，请稍后查询'};
   const error=fail(r.status,messages[r.status]||'生成服务暂时不可用');error.code=typeof code==='string'&&/^[a-z0-9_]+$/.test(code)?code:'';throw error;
  }
  if(bytes){let n=0,chunks=[];for await(const c of r.body){n+=c.length;if(n>8*1024*1024)throw fail(413,'生成图片超过画廊8MB限制，请保留任务后另行处理');chunks.push(c)}return Buffer.concat(chunks)}
  try{return await r.json()}catch{throw fail(502,'生成服务返回了无法识别的状态')}
 }
 async function capabilities(token){
  const d=await request('/capabilities',token);
  return {provider:'Comfy Cloud',model:'Krea 2',version:'Krea 2 Turbo FP8',steps:d.steps,dimension_min:d.dimension_min,dimension_max:d.dimension_max,max_pixels:d.max_pixels,reference_images_supported:d.reference_images_supported===true,batch_size:1,lora_supported:!!d.lora_import,execution_entry:d.provider==='unified-visual'?'visual_unified':'legacy_cloud',...(d.routing?{routing:d.routing,autodl:d.autodl}:{})};
 }
 async function preview(args,token){const body=generationInput(args);const r=await request('/preview',token,{method:'POST',body});return {state:'previewed',submitted:false,parameters:r.parameters,...(r.route?{route:r.route}:{}),model:'Krea 2',version:'Krea 2 Turbo FP8'};}
 async function submitBackground(job,me,token){
  try{const r=await request('/jobs',token,{method:'POST',body:job.upstream,idem:job.id});if(closed)return;const current=get(job.id,me);if(terminal(current.state))return;put({...current,state:r.state||'queued',parameters:r.parameters||current.parameters,last_error:'',provider_job_id:r.provider_job_id||null,provider:r.provider||'comfy_cloud'});}
  catch(e){if(closed)return;const current=get(job.id,me);put({...current,state:[400,401,402,403,409,422].includes(e.status)?'rejected':'submission_unknown',last_error:e.message});}
 }
 async function create(args,me,token){
  const upstream=generationInput(args,{paid:true}),id=args.idempotency_key;
  const input={title:args.title?.trim()||'Krea 2 · 网页生成',kind:args.kind||'场景',upstream,sources:args.sources||[]};
  const hash=createHash('sha256').update(canonical(input)).digest('hex');
  const old=db.prepare('SELECT request_hash,body FROM gallery_generation_jobs WHERE actor_id=? AND id=?').get(me.id,id);
  if(old){if(old.request_hash!==hash)throw fail(409,'任务编号已用于另一组参数，请查询原任务或明确开始新任务');return {job:publicJob(JSON.parse(old.body)),replayed:true};}
  const recipe=await galleryTools.invoke('gallery.recipe.save',{title:input.title,prompt:upstream.prompt,model:'Krea 2',version:'Krea 2 Turbo FP8',sources:input.sources,idempotency_key:'web-generation:'+id},me);
  const concurrent=db.prepare('SELECT request_hash,body FROM gallery_generation_jobs WHERE actor_id=? AND id=?').get(me.id,id);
  if(concurrent){if(concurrent.request_hash!==hash)throw fail(409,'任务编号已绑定其他参数');return {job:publicJob(JSON.parse(concurrent.body)),replayed:true};}
  const at=stamp(),job={id,actor_id:me.id,author:me.name,title:input.title,kind:input.kind,prompt:upstream.prompt,estimated_credits:upstream.estimated_credits,budget_credits:upstream.budget_credits,upstream,recipe_id:recipe.recipe.id,source_slices:recipe.recipe.sources,state:'submitting',parameters:{width:upstream.width,height:upstream.height,seed:upstream.seed,steps:8,profile:'krea2_turbo_fp8'},created_at:at,updated_at:at,outputs:[],post_id:null,last_error:''};
  db.prepare('INSERT INTO gallery_generation_jobs VALUES(?,?,?,?,?)').run(me.id,id,hash,JSON.stringify(job),at);
  const key=me.id+':'+id;submitting.add(key);const promise=submitBackground(job,me,token);pending.add(promise);promise.finally(()=>{pending.delete(promise);submitting.delete(key)});return {job:publicJob(job),replayed:false};
 }
 async function sync(id,me,token){
  const key=me.id+':'+id;if(syncing.has(key))return syncing.get(key);
  const promise=(async()=>{
   let j=get(id,me);if(submitting.has(key))return publicJob(j);if(terminal(j.state))return publicJob(j);
   let d;try{d=await request('/jobs/'+id,token)}catch(e){if(e.status===404&&j.state==='submitting')return publicJob(j);throw e}
   const supplier=d.supplier||{},state=supplier.status||d.state||j.state;
   j={...j,state,progress:typeof supplier.progress==='number'?supplier.progress:null,queue_position:supplier.queue_position??null,outputs:(supplier.outputs||[]).filter(o=>uuid(o.id)).map(o=>({id:o.id,content_type:o.content_type||'',name:o.name||''})),last_error:''};
   if(['succeeded','success','completed'].includes(state)&&j.outputs.length){
    const output=j.outputs.find(o=>o.content_type.startsWith('image/'))||j.outputs[0];
    try{
     const image=await request('/jobs/'+id+'/outputs/'+output.id,token,{bytes:true});
     const slices=j.source_slices.filter(s=>j.prompt.includes(s.text)).map(s=>({dimension:s.dimension,text:s.text,translation_zh:s.translation_zh||'',...(s.context_note?{context_note:s.context_note}:{}),keywords:s.keywords||[]}));
     const result=await galleryTools.publish({title:j.title,model:'Krea 2',kind:j.kind,version:'Krea 2 Turbo FP8',prompt:j.prompt,parameters:{...j.parameters,cfg:1,sampler:'euler',scheduler:'simple',...(j.upstream.lora_id?{lora_id:j.upstream.lora_id,lora_strength:j.upstream.lora_strength??1}:{}),reference_images_used:false,provider:j.provider||'comfy_cloud'},note:'由中枢统一生成通路生成；尚未人工验图。',keywords:[...new Set(slices.flatMap(s=>s.keywords))].slice(0,40),slices,recipe_id:j.recipe_id,source_context:{gallery_generation_job_id:j.id},idempotency_key:'gallery-generation:'+j.id},me,{bytes:image,channel:'web'});
     j={...j,state:'published',post_id:result.post_id,url:result.url,image:'/visual-lab'+new URL(result.image_url).pathname.replace(/^\/visual-lab/,''),sha256:result.sha256};
    }catch(e){j={...j,state:'archive_pending',last_error:e.message};}
   }
   if(['error','failed','cancelled','canceled'].includes(state))j={...j,state:state==='error'?'failed':state,last_error:'生成未完成，请查看任务信息；不会自动重新提交'};
   put(j);return publicJob(j);
  })();syncing.set(key,promise);try{return await promise}finally{syncing.delete(key)}
 }
 return {capabilities,preview,create,sync,get:(id,me)=>publicJob(get(id,me)),list:me=>db.prepare('SELECT body FROM gallery_generation_jobs WHERE actor_id=? ORDER BY created_at DESC LIMIT 30').all(me.id).map(r=>publicJob(JSON.parse(r.body))),close:async()=>{await Promise.allSettled([...pending,...syncing.values()]);closed=true}};
}
