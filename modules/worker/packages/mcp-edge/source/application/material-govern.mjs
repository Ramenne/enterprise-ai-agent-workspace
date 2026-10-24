import {createHash,randomUUID} from 'node:crypto';
const canonical=value=>value&&typeof value==='object'?(Array.isArray(value)?'['+value.map(canonical).join(',')+']':'{'+Object.keys(value).sort().filter(k=>value[k]!==undefined).map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}'):JSON.stringify(value);
const digest=value=>createHash('sha256').update(canonical(value)).digest('hex');
const childKey=value=>value.length<=200?value:'govern:'+digest(value);
export const governFields={path:{type:'string'},material_id:{type:'string'},version_id:{type:'string'},sha256:{type:'string'},importance_level:{type:'integer',enum:[1,2,3]},important:{type:'boolean'},storage_tier:{enum:['standard','infrequent','archive','deep_archive']},desired_storage_tier:{enum:['standard','infrequent','archive','deep_archive'],description:'Compatibility spelling of storage_tier; conflicting values are rejected.'},reason:{},note:{type:'string'},index:{type:'boolean'},expected_metadata_revision:{type:'integer',minimum:0},expected_description_revision:{type:'integer',minimum:0},idempotency_key:{type:'string'}};
const fields=new Set([...Object.keys(governFields),'project_id','project_name','project','create_if_missing','visibility','kind','manager_id']);
/** Journals freeze composition inputs, not another copy of current domain truth. */
export function createMaterialGovern({state,invokeNext,resolveProject,findPath,error}){
 return async function govern(auth,args,req){
  if(!state)throw error('maintenance_journal_required',503);
  if(!args||Array.isArray(args)||typeof args!=='object'||Object.keys(args).some(k=>!fields.has(k)))throw error('invalid_governance_input');
  if(args.importance_level!==undefined&&![1,2,3].includes(args.importance_level)||args.important!==undefined&&typeof args.important!=='boolean'||args.index!==undefined&&typeof args.index!=='boolean'||args.note!==undefined&&(typeof args.note!=='string'||args.note.length>10000))throw error('invalid_governance_input');
  for(const field of ['expected_metadata_revision','expected_description_revision'])if(args[field]!==undefined&&(!Number.isSafeInteger(args[field])||args[field]<0))throw error('invalid_expected_revision');
  if(args.importance_level!==undefined&&args.important!==undefined&&args.important!==(args.importance_level===1))throw error('importance_judgment_conflict');
  if(args.storage_tier&&args.desired_storage_tier&&args.storage_tier!==args.desired_storage_tier)throw error('governance_storage_tier_conflict');
  let tier=args.storage_tier??args.desired_storage_tier;if(tier&&!['standard','infrequent','archive','deep_archive'].includes(tier))throw error('invalid_storage_tier');if(tier==='infrequent')tier='archive';
  const key=args.idempotency_key??randomUUID();if(typeof key!=='string'||!key||key.length>200)throw error('invalid_idempotency_key');
  const id=digest({actor_id:auth.identity.actor_id,key,kind:'material-govern'}),signature=digest({...args,idempotency_key:undefined});
  const invoke=(name,b)=>invokeNext(auth,name,b,req);
  return state.exclusive(id,async()=>{
   let j=await state.load(id);const replay=Boolean(j);if(j&&j.signature!==signature)throw error('idempotency_conflict',409);
   const store=()=>state.save(id,j);
   if(!j){
    let located;const project=!args.project_id&&!args.project_name&&!args.project&&args.material_id?(located=await invoke('mem.material.locate',{material_id:args.material_id,...(args.version_id?{version_id:args.version_id}:{})}),{id:located.project_id}):await resolveProject(auth,args,req);const project_id=project.id||project.project_id;let material_id=args.material_id;
    if(!material_id){if(!args.path)throw error('path_or_material_required');const found=await findPath(auth,{project_id,paths:[args.path]},req);const exact=found.items.filter(x=>x.logical_path===args.path);if(exact.length!==1)throw Object.assign(error(exact.length?'document_path_ambiguous':'document_not_found',409),{detail:{candidates:exact}});material_id=exact[0].material_id;}
    const head=await invoke('mem.material.head',{project_id,material_id});let fixed=head.fixed_ref;
    if(args.version_id&&args.version_id!==fixed?.version_id){const loc=located??await invoke('mem.material.locate',{material_id,version_id:args.version_id});if(loc.project_id!==project_id)throw error('permission_project_mismatch',409);fixed=loc.fixed_ref;}
    if(!fixed)throw error('no_published_original',409);if(args.sha256&&args.sha256!==fixed.sha256)throw error('fixed_reference_mismatch',409);
    if(args.expected_metadata_revision!==undefined&&args.expected_metadata_revision!==head.metadata_revision)throw error('metadata_changed_refresh',409);
    const prior=head.properties?.governance||{},changesImportance=args.importance_level!==undefined||args.important!==undefined,changesMetadata=changesImportance||Boolean(tier);
    const {physical_transition,observed_storage_tier,...intent}=prior;
    const level=args.importance_level??(args.important!==undefined?(args.important?1:3):prior.importance_level);
    const judgment={...intent,...(changesImportance?{importance_level:level,important:level===1,reason:args.reason??prior.reason??null,judged_by:auth.identity.actor_id,judged_at:new Date().toISOString()}:{}),...(tier?{desired_storage_tier:tier,storage_reason:args.reason??prior.storage_reason??null,storage_judged_by:auth.identity.actor_id,storage_judged_at:new Date().toISOString()}: {})};
    const same=(!changesImportance||prior.importance_level===level)&&(!tier||prior.desired_storage_tier===tier)&&(args.reason===undefined||canonical(args.reason)===canonical(changesImportance?prior.reason:prior.storage_reason));
    j={schema:1,signature,key,project:{id:project_id,title:project.title},scope:{project_id,material_id},fixed,judgment,requests:{},receipts:{},legacy_default_physical_key:args.idempotency_key===undefined};
    if(changesMetadata&&!same)j.requests.metadata={project_id,material_id,expected_revision:head.metadata_revision,properties:{governance:judgment},idempotency_key:key};
    else j.receipts.metadata={state:'unchanged',metadata_revision:head.metadata_revision};
    await store();
   }
   // A journal is never authority. Recheck current access even for old receipts.
   if(replay){const loc=await invoke('mem.material.locate',{material_id:j.scope.material_id,version_id:j.fixed.version_id});
    if(loc.project_id!==j.scope.project_id||loc.fixed_ref?.sha256!==j.fixed.sha256)throw error('fixed_scope_changed',409);}
   const pending=[],completed=[];
   async function attempt(name,run){try{const value=await run();completed.push(name);if(name==='description'&&!j.requests.description){j.receipts.description=value;await store();}return value;}catch(e){if(e.status===401||e.status===403&&name!=='index')throw e;pending.push(name);return{state:'pending',error_code:e.message,http_status:e.status??502,retryable:e.retryable??![400,409,410].includes(e.status),original_intent_preserved:true};}}
   const recovery={tool:'hub.material.govern',arguments:{...args,idempotency_key:key},mode:'resume_original_intent',next_step:'reuse_original_input_and_key;resolve_conflicts_before_new_intent'};
   try{
    const metadata=j.requests.metadata?await attempt('metadata',()=>invoke('mem.metadata.patch',j.requests.metadata)):j.receipts.metadata;
    if(pending.includes('metadata'))return{state:'governance_pending',completion_state:'partial',idempotency_key:key,metadata,fixed_ref:j.fixed,pending_steps:pending,recovery};
    let description=null,index=null,physical=null,currentStorage=null,beforeStorage=null;
    if(args.note!==undefined){
     description=await attempt('description',async()=>{
      if(!j.requests.description&&!j.receipts.description){const old=await invoke('mem.description.read',{...j.scope,version_id:j.fixed.version_id,sha256:j.fixed.sha256});const revision=old.description?.revision||0;
       if(args.expected_description_revision!==undefined&&args.expected_description_revision!==revision)throw error('description_changed_refresh',409);
       if(old.description?.text===args.note)return{state:'description_unchanged',description:old.description,fixed_ref:j.fixed};
       j.requests.description={...j.scope,version_id:j.fixed.version_id,sha256:j.fixed.sha256,text:args.note,expected_revision:revision,source_declaration:{author:'current_authorized_caller',purpose:'material_description'},idempotency_key:childKey('govern-note:'+key)};await store();
      }
      return j.requests.description?invoke('mem.description.save',j.requests.description):j.receipts.description;
     });
    }
    if(args.index===true){
     if(pending.includes('description')){index={state:'pending',error_code:'description_pending'};pending.push('index');}
     else if(![1,2].includes(j.judgment.importance_level))index={state:'not_indexed',reason:'importance_level_1_or_2_required'};
     else index=await attempt('index',()=>invoke('mem.semantic.index_fixed',{project_id:j.scope.project_id,fixed_ref:{material_id:j.scope.material_id,version_id:j.fixed.version_id,sha256:j.fixed.sha256},idempotency_key:childKey('govern-index:'+key)}));
    }
    if(index&&['capability_unavailable','blocked','pending','needs_condense'].includes(index.state))pending.push('index');
    if(tier){
     physical=await attempt('physical',async()=>{
      const scope={...j.scope,version_id:j.fixed.version_id};beforeStorage=await invoke('mem.object.storage_info',scope);
      if(!j.requests.physical&&!j.physical_noop){
       if(tier!=='standard'&&beforeStorage.primary_tier===tier)j.physical_noop={primary_tier:tier,operation_id:beforeStorage.operation_id??null};
       else j.requests.physical=tier==='standard'?{name:'mem.object.warm',body:{...scope,idempotency_key:j.legacy_default_physical_key?'govern-warm:'+j.scope.material_id+':'+j.fixed.version_id:key}}:{name:'mem.object.archive',body:{...scope,tier,idempotency_key:j.legacy_default_physical_key?'govern-archive:'+j.scope.material_id+':'+j.fixed.version_id+':'+tier:childKey(key+':archive')}};
       await store();
      }
      const result=j.requests.physical?await invoke(j.requests.physical.name,j.requests.physical.body):beforeStorage;
      currentStorage=await invoke('mem.object.storage_info',scope);
      return{...result,operation_receipt:{operation_id:result.operation_id,state:result.state,primary_tier:result.placement?.primary_tier??result.primary_tier},current_storage:currentStorage,primary_tier:currentStorage.primary_tier,placement:{...(result.placement||{}),primary_tier:currentStorage.primary_tier},...((j.physical_noop||['copy_created','verified'].includes(result.state)&&(result.placement?.primary_tier??result.primary_tier)===tier)&&currentStorage.primary_tier!==tier?{state:'new_intent_required',historical_state:result.state}:{}),observation_scope:'current_authorized_storage;operation_receipt_is_historical_when_replayed'};
     });
     if(!currentStorage||currentStorage.primary_tier!==tier)pending.push('physical_transition');
     if(['unknown','pending','restoring','restore_wait','restore_requested','warming','queued','prepared','dispatched','new_intent_required'].includes(physical?.state))pending.push('physical_operation');
    }
    return{state:'governed',completion_state:pending.length?'partial':'complete',idempotency_key:key,project:j.project,material_id:j.scope.material_id,fixed_ref:j.fixed,governance:j.judgment,governance_scope:'original_intent;current_storage_owned_by_Mem',metadata,description,description_receipt_scope:'original_intent;read_current_description_for_current_state',index,physical,current_storage:currentStorage,pending_steps:[...new Set(pending)],...(physical?.state==='new_intent_required'?{recovery:{tool:'hub.material.govern',arguments:{...args,idempotency_key:randomUUID()},mode:'new_intent_required',previous_intent:key,next_step:'previous_operation_completed;submit_a_new_intent_only_if_current_target_still_wanted'}}:pending.length?{recovery}:{}),target_satisfied:tier?currentStorage?.primary_tier===tier:null,physical_storage_changed:Boolean(beforeStorage&&currentStorage&&beforeStorage.primary_tier!==currentStorage.primary_tier),importance_storage_binding:'independent;14_day_idle_archive_and_3_use_standard_policy',original_identity_unchanged:true,archived_original_requires_restore:['archive','deep_archive'].includes(currentStorage?.primary_tier)};
   }catch(e){e.detail={...(e.detail||{}),idempotency_key:key,fixed_ref:j.fixed,completed_steps:completed,recovery};throw e;}
  });
 };
}
