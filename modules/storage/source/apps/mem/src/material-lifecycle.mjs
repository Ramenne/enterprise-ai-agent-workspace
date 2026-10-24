/** Shared lifecycle use case; each item rechecks current policy and authority. */
export function createMaterialLifecycle({z,call,DomainError,storage}){
 const runningScopes=new Set();
 const scope={project_id:z.uuid(),material_id:z.uuid().optional(),version_id:z.uuid().optional(),limit:z.number().int().min(1).max(100).default(20),after_version_id:z.uuid().optional()};
 return async(route,authority,input)=>{
  if(!['plan','run'].includes(route))throw new DomainError('invalid_input');
  const parsed=z.object(scope).strict().safeParse(input);if(!parsed.success)throw new DomainError('invalid_input');
  const b=parsed.data,{token,source}=authority;
  if(route==='run'&&runningScopes.has(b.project_id))throw new DomainError('lifecycle_scope_busy',409,true);
  if(route==='run')runningScopes.add(b.project_id);
  try{
  const plan=await call(token,source,'storage_lifecycle_plan','mem.read',b);
  if(route==='plan')return plan;
  const command=async(name,payload)=>{const r=await storage(name,authority,payload);return{status:r.status,result:r.body};};
  const outcomes=[];
  for(const item of plan.items){
   const ref={project_id:item.project_id,material_id:item.material_id,version_id:item.version_id};
   try {
    const fresh=await call(token,source,'storage_lifecycle_plan','mem.read',{...ref,limit:1});
    if(!fresh.items.some(x=>x.idempotency_key===item.idempotency_key)){outcomes.push({...ref,state:'skipped_activity_or_placement_changed'});continue;}
    if(item.target_tier==='retire'){
     const {status,result}=await command('resume-retirement',{...ref,operation_id:item.placement_operation_id});
     outcomes.push({...ref,target_tier:'archive',http_status:status,state:status>=400?'pending_dependency':result.state,operation_id:item.placement_operation_id,placement:result,error_code:result.error_code??null});continue;
    }
    let {status,result}=await command((item.target_tier==='standard'?'warm':'archive'),{...ref,idempotency_key:item.idempotency_key,...(item.target_tier==='archive'?{tier:'archive'}:{})});
    if(item.target_tier==='archive'&&result.operation_id&&['dispatched','unknown'].includes(result.state)){
     const observation=await command('status',{...ref,operation_id:result.operation_id,command:'archive_copy'});
     status=observation.status;result=observation.result;
    }
    let placement=result.placement??null;
    // A successful repeated COPY request must also resume a held switch/retirement.
    if(item.target_tier==='archive'&&result.operation_id&&result.state==='copy_created'){
     const resumed=await command('resume-retirement',{...ref,operation_id:result.operation_id});
     placement=resumed.result;
     // An unknown COPY discovered by HEAD cannot authorize retirement. Restore
     // the registered target and verify its bytes through the existing flow.
     if(placement?.state==='failed'&&result.receipt?.copy_id&&result.receipt.copy_lineage_verified!==true){
      let verification=await command('restore',{...ref,copy_id:result.receipt.copy_id,idempotency_key:item.idempotency_key+':verify-restore',days:7,retrieval:'Standard'});
      if(verification.result.operation_id&&verification.result.state!=='verified')verification=await command('status',{...ref,operation_id:verification.result.operation_id,command:'restore'});
      if(verification.result.state==='verified')placement=(await command('resume-retirement',{...ref,operation_id:result.operation_id})).result;
      else{outcomes.push({...ref,target_tier:item.target_tier,state:'restore_verification_pending',operation_id:result.operation_id,verification_operation_id:verification.result.operation_id,primary_tier:result.primary_tier??null});continue;}
     }
    }
    outcomes.push({...ref,target_tier:item.target_tier,http_status:status,state:status>=400||placement?.state==='failed'?'pending_dependency':result.state,
     operation_id:result.operation_id??null,primary_tier:placement?.primary_tier??result.primary_tier??null,placement,
     error_code:result.error_code??placement?.error_code??null,next_step:result.next_step??null});
   }catch(e){outcomes.push({...ref,state:'pending_dependency',error_code:e.code??'lifecycle_dependency_unavailable'});}
  }
  return{state:'lifecycle_batch',policy:plan.policy,outcomes,next_after_version_id:plan.next_after_version_id,
   logical_files_deleted:0,version_identity_unchanged:true};
  }finally{if(route==='run')runningScopes.delete(b.project_id);}
 };
}

export function registerMaterialLifecycle(app,deps){
 app.post('/v2/materials/classification/pending',async request=>{
  const parsed=deps.z.object({project_id:deps.z.uuid(),limit:deps.z.number().int().min(1).max(100).default(20),after_file_no:deps.z.string().regex(/^[0-9]{1,19}$/).optional()}).strict().safeParse(request.body);
  if(!parsed.success)throw new deps.DomainError('invalid_input');
  return deps.call(deps.bearer(request),deps.sourceFromRequest(request),'material_classification_pending','mem.read',parsed.data);
 });
 const execute=createMaterialLifecycle(deps);
 for(const route of ['plan','run'])app.post('/v2/materials/lifecycle/'+route,request=>execute(route,{token:deps.bearer(request),source:deps.sourceFromRequest(request),request_id:request.id},request.body));
 return execute;
}

/** One timer in the existing Mem process. A dedicated revocable member client is
 * read from a private file, never retained in reports, SQL, job payloads or logs. */
export function installMaterialLifecycleScheduler(app,{pool,credentialPath,intervalMs=3600000,batchSize=20,maxBatches=5,runLifecycle,errorResponse,initialDelayMs=30000}) {
 if(!credentialPath)return;
 let stopped=false,running=false,timer;const cursors=new Map();
 const tick=async()=>{
  if(stopped||running)return;running=true;
  try {
   const {open,constants}=await import('node:fs/promises').then(async fs=>({...fs,constants:(await import('node:fs')).constants}));
   const f=await open(credentialPath,constants.O_RDONLY|constants.O_NOFOLLOW);
   let token;try{const stat=await f.stat();if(!stat.isFile()||stat.size>4096||(stat.mode&0o077)!==0||stat.uid!==process.getuid())throw Error('unsafe_lifecycle_credential_file');token=(await f.readFile('utf8')).trim();}finally{await f.close();}
   if(!/^hub2_[A-Za-z0-9_-]+$/.test(token))throw Error('invalid_lifecycle_credential');
   const projects=await pool.query('SELECT mem.storage_lifecycle_projects() AS project_id');
   let changed=0,pending=0,denied=0;
   for(const {project_id}of projects.rows){
    if(stopped)break;let after_version_id=cursors.get(project_id);
    for(let batch=0;batch<maxBatches&&!stopped;batch++){
     let result;try{result=await runLifecycle('run',{token},{project_id,limit:batchSize,...(after_version_id?{after_version_id}:{})});}catch(error){denied++;const info=errorResponse?.(error);app.log.warn({event:'material_lifecycle_project_failed',project_id,...(info?.diagnostic||{})},'lifecycle project failed');break;}
     for(const item of result.outcomes){if(['pending_dependency','unknown','restoring','restore_pending','restore_verification_pending','new_intent_required'].includes(item.state)||['held','pending','unknown'].includes(item.placement?.state))pending++;else changed++;}
     after_version_id=result.next_after_version_id;if(after_version_id)cursors.set(project_id,after_version_id);else{cursors.delete(project_id);break;}
    }
   }
   app.log.info({event:'material_lifecycle_cycle',changed,pending,denied,logical_files_deleted:0});
  }catch{app.log.warn({event:'material_lifecycle_cycle',state:'pending_dependency'});}
  finally{running=false;if(!stopped){timer=setTimeout(tick,intervalMs);timer.unref();}}
 };
 app.addHook('onReady',async()=>{timer=setTimeout(tick,initialDelayMs);timer.unref();});
 app.addHook('onClose',async()=>{stopped=true;clearTimeout(timer);});
}
