import{createHash}from'node:crypto';
const canonical=x=>x&&typeof x==='object'?(Array.isArray(x)?'['+x.map(canonical).join(',')+']':'{'+Object.keys(x).sort().filter(k=>x[k]!==undefined).map(k=>JSON.stringify(k)+':'+canonical(x[k])).join(',')+'}'):JSON.stringify(x);
const digest=x=>createHash('sha256').update(canonical(x)).digest('hex');
const fail=(message,status=400)=>Object.assign(Error(message),{status});
export const uploadTool={name:'mengchu_upload',description:'Save authorized personal/shared text or binary using the current upload application. Keep idempotency_key to resume the same intent; fixed native versions return UUIDs.',inputSchema:{type:'object',properties:{space:{enum:['shared','personal']},path:{type:'string'},content_text:{type:'string'},content_base64:{type:'string'},note:{type:'string'},apply_month_prefix:{type:'boolean'},project_id:{type:'string'},project_name:{type:'string'},project:{type:'string'},kind:{enum:['project','dialogue']},native_personal:{type:'boolean'},idempotency_key:{type:'string',minLength:1,maxLength:200}},required:['space','path']}};
export function uploadInvocationKey(caller,name,args,legacy){return name==='mengchu_upload'&&args.idempotency_key!==undefined?'upload-intent:'+digest(args.idempotency_key):legacy();}
// Routing order is shared by protocol adapters; each existing writer retains its journal.
// This small record freezes only request identity and calendar-dependent addressing, not bytes/results.
export function createUpload({routes,identity,state,describe,now=()=>new Date()}){
 const dispatch=async(caller,args)=>{for(const route of routes){const r=await route(caller,args);if(r.handled)return r;}return{handled:false};};
 return async(caller,args,{requireKey=false}={})=>{
  const key=args.idempotency_key;
  if(key===undefined){if(requireKey)throw fail('idempotency_key_required');return dispatch(caller,args);}
  if(typeof key!=='string'||!key.trim()||key.length>200)throw fail('invalid_idempotency_key');
  const unknown=Object.keys(args).filter(k=>!Object.hasOwn(uploadTool.inputSchema.properties,k));if(unknown.length)throw Object.assign(fail('unknown_upload_fields'),{detail:{fields:unknown}});
  if(!['personal','shared'].includes(args.space)||typeof args.path!=='string'||!args.path||args.path.length>1024||args.path.startsWith('/')||args.path.split('/').includes('..')||/[\x00\r\n]/.test(args.path))throw fail('invalid_upload_target');
  if((typeof args.content_text==='string')===(typeof args.content_base64==='string'))throw fail('exactly_one_content_required');
  if(args.note!==undefined&&(typeof args.note!=='string'||[...args.note].length>500))throw fail('invalid_note');
  if(args.apply_month_prefix!==undefined&&typeof args.apply_month_prefix!=='boolean')throw fail('invalid_month_prefix');
  const auth=await identity(caller),actor=auth.actor_id??auth.identity?.actor_id;if(!actor)throw fail('unauthenticated',401);
  const id=digest({actor,key}),fingerprint=digest(args);
  return state.exclusive(id,async()=>{
   let j=await state.load(id);if(j&&j.fingerprint!==fingerprint)throw fail('idempotency_conflict',409);
   if(!j){let path=args.path;if(args.space==='shared'&&args.apply_month_prefix!==false&&!/^\d{4}-\d{2}\//.test(path)&&!path.startsWith('企业 AI 协作平台/')){const d=now();path=d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'/'+path;}j={fingerprint,path};await state.save(id,j);}
   const routed=await dispatch(caller,{...args,path:j.path,...(args.space==='shared'?{apply_month_prefix:false}:{})});
   if(!routed.handled)return routed;
   const result={...(routed.result||{})},published=result.state==='published'&&Boolean(result.fixed_ref?.version_id);
   if(published&&args.note!==undefined&&(!result.description||result.description.state==='not_requested')&&describe){const d=await describe(auth,result.fixed_ref,args.note,'upload-description:'+digest(key));result.description=d.saved;result.index=d.index;}
   const pending=Object.entries({metadata:result.enrichment?.metadata,description:result.description,index:result.index}).filter(([,v])=>v&&['pending','enrichment_pending','needs_condense','failed'].includes(v.state)).map(([k])=>k);
   // Missing requested description is explicit, including old binary paths that never maintained one.
   if(published&&args.note!==undefined&&(!result.description||result.description.state==='not_requested'))pending.push('description');
   return{handled:true,result:{...result,idempotency_key:key,publication_state:published?'published':result.publication_state||'unconfirmed',completion_state:published&&!pending.length?'complete':'partial',pending_steps:pending,recovery:{mode:'resume_original_intent',idempotency_key:key,automatic_new_upload:false}}};
  });
 };
}
