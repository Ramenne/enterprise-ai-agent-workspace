import type{FastifyInstance}from'fastify';
import type pg from'pg';
import{createHash}from'node:crypto';
import{spawn}from'node:child_process';
import{z}from'zod';
import{bearer,DomainError}from'../../../packages/platform/src/http.js';
export function registerLegacySelfWork(app:FastifyInstance,pool:pg.Pool){
 const input=z.object({project_id:z.uuid().optional(),legacy_project_id:z.string().min(1).max(256).optional(),limit:z.number().int().min(1).max(50).default(10),cursor:z.string().min(1).max(256).optional()}).strict();
 app.post('/v2/personal/legacy-work-inventory',{logLevel:'silent'},async req=>{
  const p=input.safeParse(req.body??{});if(!p.success)throw new DomainError('invalid_input');const b=p.data;
  const proof=createHash('sha256').update(bearer(req)).digest('hex');
  const row=await pool.query('SELECT authz.legacy_personal_work_scope($1,$2)AS scope',[proof,b.project_id??null]);const scope=row.rows[0]?.scope;
  if(!scope?.legacy_subject)throw new DomainError('verified_legacy_identity_missing',403);
  const result:Record<string,unknown>=await new Promise((resolve,reject)=>{
   const child=spawn('/usr/bin/python3',[new URL('./read-work-inventory.py',import.meta.url).pathname],{stdio:['pipe','pipe','pipe']});let out='';const timer=setTimeout(()=>child.kill(),15000);
   child.stdout.on('data',x=>{out+=x;if(out.length>16*1024*1024)child.kill();});child.stderr.resume();
   child.on('error',()=>{clearTimeout(timer);reject(new DomainError('legacy_work_source_unavailable',503,true));});
   child.on('close',code=>{clearTimeout(timer);if(code!==0)return reject(new DomainError('legacy_work_source_unavailable',503,true));try{resolve(JSON.parse(out));}catch{reject(new DomainError('legacy_work_source_invalid',503,true));}});
   child.stdin.end(JSON.stringify({legacy_subject:scope.legacy_subject,legacy_project_id:b.legacy_project_id,cursor:b.cursor,limit:b.limit}));
  });
  if(result['state']==='failed')throw new DomainError(String(result['error_code']),403);
  return{...result,actor_id:scope.actor_id,project_id:b.project_id??null,identity_source:'current_hufu_immutable_legacy_link',next_step:'Agent_saves_original_facts_in_own_personal_project;do_not_grant_full_engineering_or_infer_completion'};
 });
}
