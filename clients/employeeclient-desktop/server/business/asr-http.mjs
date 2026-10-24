import {assertActorNeutralBody} from './native-authority.mjs';
const fail=(code,status=400)=>{throw Object.assign(Error(code),{code,status});};
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function createASRHandler(jobs,sessionFactory,{prefix='asr',diagnostic=record=>console.warn(JSON.stringify(record))}={}){
 return async(req,res)=>{
  const url=new URL(req.url,'http://localhost'),base='/business/v1/'+prefix+'/';if(!url.pathname.startsWith(base))return false;
  const action=url.pathname.slice(base.length);const reply=(status,value)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(value));};
  let actor,job;
  try{
   if(!['prepare','start','status','poll'].includes(action)||!['GET','POST'].includes(req.method))fail('asr_route_not_found',404);
   if((action==='prepare'||action==='start')&&req.method!=='POST')fail('method_not_allowed',405);
   if((action==='status'||action==='poll')&&req.method!=='GET')fail('method_not_allowed',405);
   const cookie=req.headers.cookie||'',initial=await sessionFactory(cookie),session={...initial,reauthorize:()=>sessionFactory(cookie)};actor=session.context.actor_id;let body={};
   if(req.method==='POST'){
    if(!req.headers['idempotency-key'])fail('idempotency_required');const chunks=[];let size=0;
    for await(const part of req){size+=part.length;if(size>8192)fail('request_too_large',413);chunks.push(part);}try{body=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{fail('invalid_json');}
    if(!body||typeof body!=='object'||Array.isArray(body))fail('invalid_json');assertActorNeutralBody(body);
   }
   const id=body.job_id||url.searchParams.get('job_id');if(action!=='prepare'&&!UUID.test(id||''))fail('asr_original_job_required');
   job=id;
   const value=action==='prepare'?await jobs.prepare(session.context,body,req.headers['idempotency-key'],session):await jobs[action](session.context,id,session);
   reply(200,value);
  }catch(e){diagnostic({event:'employeeclient_asr_rejected',action,actor_id:actor||null,job_id:job||null,stage:e.asr_stage||'product_or_source',status:e.status||503,error_code:e.code||'asr_dependency_unavailable'});reply(e.status||503,{error_code:e.code||'asr_dependency_unavailable'});}return true;
 };
}
