import {createHash,randomUUID} from 'node:crypto';
import {galleryLoopTools} from './gallery-loop-contract.mjs';
const fail=(status,message)=>Object.assign(Error(message),{status});
const canonical=x=>x&&typeof x==='object'?(Array.isArray(x)?'['+x.map(canonical).join(',')+']':'{'+Object.keys(x).sort().map(k=>JSON.stringify(k)+':'+canonical(x[k])).join(',')+'}'):JSON.stringify(x);
export function validateLoop(name,args){
 const spec=galleryLoopTools.find(t=>t.name===name)?.inputSchema;
 if(!spec||!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).some(k=>!Object.hasOwn(spec.properties,k))||spec.required.some(k=>!Object.hasOwn(args,k)))throw fail(400,'工具参数缺失或包含未知字段');
 for(const[k,v]of Object.entries(args)){const s=spec.properties[k];if(s.type==='string'&&(typeof v!=='string'||v.length>(s.maxLength??20000)||v.length<(s.minLength??0))||s.type==='integer'&&!Number.isInteger(v)||s.type==='number'&&(typeof v!=='number'||!Number.isFinite(v))||s.type==='boolean'&&typeof v!=='boolean'||s.type==='array'&&(!Array.isArray(v)||v.length>(s.maxItems??100)))throw fail(400,'参数类型或长度无效:'+k);
 if(s.enum&&!s.enum.includes(v)||typeof v==='number'&&(v<(s.minimum??-Infinity)||v>(s.maximum??Infinity)||s.exclusiveMinimum!==undefined&&v<=s.exclusiveMinimum||s.multipleOf&&v%s.multipleOf))throw fail(400,'参数取值无效:'+k);
 if(s.format==='uuid'&&!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v))throw fail(400,'任务或LoRA编号无效');}
}
export function createGalleryLoop({db,galleryTools,generation,library}){
 db.exec('CREATE TABLE IF NOT EXISTS gallery_feedback_requests(actor_id TEXT NOT NULL,idempotency_key TEXT NOT NULL,request_hash TEXT NOT NULL,comment_id TEXT NOT NULL,source TEXT NOT NULL,PRIMARY KEY(actor_id,idempotency_key),UNIQUE(comment_id));');
 async function post(id,me){return galleryTools.invoke('gallery.get',{post_id:id},me)}
 const feedback=id=>db.prepare('SELECT c.id,c.author,c.body,c.created_at,f.source FROM comments c LEFT JOIN gallery_feedback_requests f ON f.comment_id=c.id WHERE c.post_id=? ORDER BY c.created_at,c.id').all(id).map(r=>({...r,source:r.source||'web_comment',source_authority:'caller_declared_not_proof_of_human_origin'}));
 return {async invoke(name,args,me,token){
  validateLoop(name,args);
  if(name==='gallery.generation.capabilities')return generation.capabilities(token);
  if(name==='gallery.generation.preview')return generation.preview(args,token);
  if(name==='gallery.generation.create')return generation.create(args,me,token);
  if(name==='gallery.generation.get')return {state:'read',job:generation.get(args.id,me)};
  if(name==='gallery.generation.sync')return {state:'observed',job:await generation.sync(args.id,me,token)};
  if(name==='gallery.generation.list')return {state:'read',jobs:generation.list(me)};
  const p=await post(args.post_id,me);
  if(name==='gallery.feedback.list'){const all=feedback(args.post_id);return {state:'read',post_id:args.post_id,items:all.slice(-(args.limit||100)),total:all.length};}
  if(name==='gallery.provenance.get')return {state:'read',post_id:p.post_id,url:p.url,sha256:p.sha256,model:p.model,version:p.version,prompt:p.post.prompt||null,parameters:p.post.parameters||null,source_context:p.post.source_context||{},recipe:p.recipe_id?library.recipe(p.recipe_id):null,reference:p.reference,feedback:feedback(args.post_id)};
  if(name==='gallery.feedback.add'){
   if(!args.body.trim()||!args.idempotency_key.trim())throw fail(400,'反馈正文与幂等标识不能为空');
   const digest=createHash('sha256').update(canonical(args)).digest('hex');db.exec('BEGIN IMMEDIATE');
   try{
    const old=db.prepare('SELECT request_hash,comment_id,source FROM gallery_feedback_requests WHERE actor_id=? AND idempotency_key=?').get(me.id,args.idempotency_key);
    if(old){if(old.request_hash!==digest)throw fail(409,'反馈幂等键已用于其他内容');const comment=db.prepare('SELECT id,author,body,created_at FROM comments WHERE id=?').get(old.comment_id);db.exec('COMMIT');return {state:'saved',post_id:args.post_id,feedback:{...comment,source:old.source},replayed:true};}
    const id=randomUUID(),at=new Date().toISOString(),body=(args.source==='agent_observation'?'AI观察：':'用户原话（调用者声明）：')+args.body.trim();
    db.prepare('INSERT INTO comments VALUES(?,?,?,?,?,?)').run(id,args.post_id,me.id,me.name,body,at);
    db.prepare('INSERT INTO gallery_feedback_requests VALUES(?,?,?,?,?)').run(me.id,args.idempotency_key,digest,id,args.source);db.exec('COMMIT');
    return {state:'saved',post_id:args.post_id,feedback:{id,author:me.name,body,created_at:at,source:args.source},replayed:false};
   }catch(e){db.exec('ROLLBACK');throw e}
  }
  throw fail(404,'未知反馈链路工具');
 }};
}
