import{createHash}from'node:crypto';
import{spawn}from'node:child_process';
export function registerLegacySelfInventory(app,{z,bearer,pool,DomainError}){
 const input=z.object({project_id:z.uuid().optional(),limit:z.number().int().min(1).max(200).default(100),cursor:z.string().min(1).max(256).optional()}).strict();
 app.post('/v2/personal/legacy-inventory',{logLevel:'silent'},async req=>{
  const parsed=input.safeParse(req.body??{});if(!parsed.success)throw new DomainError('invalid_input');
  const b=parsed.data,proof=createHash('sha256').update(bearer(req)).digest('hex');
  const r=await pool.query('SELECT authz.legacy_personal_inventory_scope($1,$2) AS scope',[proof,b.project_id??null]);
  const scope=r.rows[0]?.scope;if(!scope?.legacy_subject)throw new DomainError('verified_legacy_identity_missing',403);
  const result=await new Promise((resolve,reject)=>{
   const child=spawn('/usr/bin/python3',[new URL('./read-inventory.py',import.meta.url).pathname],{stdio:['pipe','pipe','pipe']});let out='',err='';
   const timer=setTimeout(()=>child.kill(),15000);
   child.stdout.on('data',x=>{out+=x;if(out.length>8*1024*1024)child.kill();});child.stderr.on('data',x=>{err+=x;if(err.length>8192)child.kill();});
   child.on('error',()=>{clearTimeout(timer);reject(new DomainError('legacy_metadata_source_unavailable',503,true));});
   child.on('close',code=>{clearTimeout(timer);if(code!==0)return reject(new DomainError('legacy_metadata_source_unavailable',503,true));try{resolve(JSON.parse(out));}catch{reject(new DomainError('legacy_metadata_source_invalid',503,true));}});
   child.stdin.end(JSON.stringify({legacy_subject:scope.legacy_subject,limit:b.limit,cursor:b.cursor}));
  });
  if(result.state==='failed')throw new DomainError(result.error_code,409);
  return{...result,actor_id:scope.actor_id,project_id:b.project_id??null,identity_source:'current_hufu_immutable_legacy_link',original_member_credential_required:false,next_step:'Agent_can_save_this_inventory_in_own_personal_project;do_not_request_full_engineering_access'};
 });
}
