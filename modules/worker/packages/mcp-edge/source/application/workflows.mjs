import {createMaterialGovern,governFields} from './material-govern.mjs';
import {createHash} from 'node:crypto';
/** Useful working flows over existing authoritative domains. No duplicate business database. */
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const schema=(name,description,properties,required=[])=>({name,description,inputSchema:{type:'object',properties,required}});
const projectFields={project_id:{type:'string'},project_name:{type:'string'},project:{type:'string'},create_if_missing:{type:'boolean'},visibility:{enum:['personal','team']},kind:{enum:['project','dialogue']},manager_id:{type:'string'}};
export const workflowTools=[
 schema('hub.project.open','Find an authorized 2.0 project by name or ID. Return ambiguous candidates for Agent choice. Create a personal/team project only when create_if_missing is explicitly true.',projectFields),
 schema('hub.materials.find','Find currently authorized old files and new project materials together, with explicit source labels. Optional semantic search reads Agent descriptions, never full originals. Results are candidates for Agent judgment.',{...projectFields,q:{type:'string'},scope:{enum:['all','legacy','new']},legacy_space:{type:'string'},semantic:{type:'boolean',description:'false uses lexical metadata/text index only; true enables semantic candidates; default false.'},limit:{type:'integer',minimum:1,maximum:100,description:'Final candidate limit across projects, default 5.'},cursor:{type:'string'},properties:{type:'object'},version_created_after:{type:'string'},version_created_before:{type:'string'}}),
 schema('hub.document.open','Read a complete authorized document by old file ID/address, or by new project name and logical path/material ID. IDs and byte ranges are handled internally.',{...projectFields,file_id:{type:'string'},address:{type:'string'},ver:{type:'integer'},path:{type:'string'},material_id:{type:'string'},version_id:{type:'string'},sha256:{type:'string'},encoding:{enum:['utf8','base64']}}),
 schema('hub.work.resume','Continue existing work with a compact current understanding, fixed references and material metadata. Preserves actor authorization and optional context. include_history:true expands raw history; include_material_metadata:true resolves referenced material metadata; ordinary work needs no manual context ID.',{...projectFields,task_id:{type:'string'},view:{enum:['me','control']},source:{enum:['legacy','new']},work_item_id:{type:'string'},work_no:{type:'integer'},q:{type:'string'},include_context:{type:'boolean'},include_history:{type:'boolean'},include_material_metadata:{type:'boolean'},context_id:{type:'string'},next_steps:{type:'array',items:{}}}),
 schema('hub.material.govern','Save authorized Agent importance and storage intent for a new material, by project name and path/ID. Materials classified level1 or level2 can get description vectors; only level1 is high importance. Physical archive is separately reported; metadata never pretends bytes moved.',{...projectFields,...governFields})
];

export function workingFlows({invokeNext,invokeOld,readFull,error,searchMetadata,governState,findPath}){
 async function resolveProject(auth,args,req,{optional=false}={}){
  const selector=args.project_id||args.project_name||args.project;
  if(!selector){if(optional)return null;throw Object.assign(error('project_name_or_id_required'),{detail:{next_step:'provide_project_name;no_manual_ID_required'}});}
  if(uuid.test(selector)){const r=await invokeNext(auth,'v8.project.read',{project_id:selector},req);return r.project||{project_id:selector,id:selector};}
  const r=await invokeNext(auth,'v8.project.search',{query:selector,limit:100},req);
  const exact=r.items.filter(x=>x.title===selector);
  if(exact.length===1)return{...exact[0],id:exact[0].project_id};
  if(exact.length>1)throw Object.assign(error('project_name_ambiguous',409),{detail:{candidates:exact,next_step:'Agent_selects_project_id_from_candidates'}});
  if(args.create_if_missing===true){const r=await invokeNext(auth,'v8.project.create',{title:selector,visibility:args.visibility||'personal',kind:args.kind||'project',...(args.manager_id?{manager_id:args.manager_id}:{})},req);return r.project;}
  if(optional)return null;
  throw Object.assign(error('project_not_found',404),{detail:{candidates:r.items,next_step:'choose_existing_project_or_explicitly_create;old_projects_remain_in_old_V8'}});
 }

 async function find(auth,args,req,legacyAvailable){
  const q=args.q||'',limit=Math.max(1,Math.min(100,args.limit??5)),scope=args.scope||'all',semantic=args.semantic===true;
  const fingerprint=createHash('sha256').update(JSON.stringify({q,scope,semantic,project_id:args.project_id,project_name:args.project_name||args.project,properties:args.properties,after:args.version_created_after,before:args.version_created_before,legacy_space:args.legacy_space})).digest('hex');
  let position={v:1,fingerprint,pc:null,pi:0,offset:0,legacy_done:false};
  if(args.cursor){try{const value=JSON.parse(Buffer.from(args.cursor,'base64url').toString('utf8'));if(value.v!==1||value.fingerprint!==fingerprint||!Number.isSafeInteger(value.pi)||value.pi<0||value.pi>=20||!Number.isSafeInteger(value.offset)||value.offset<0||value.offset>100||!(value.pc===null||uuid.test(value.pc))||typeof value.legacy_done!=='boolean')throw Error();position=value;}catch{throw error('invalid_search_cursor;keep_query_and_scope_unchanged');}}
  const output={state:'found_candidates',items:[],coverage:{legacy:'not_requested',new:'not_requested',complete:false,body_read:false,semantics:'bounded_candidates;not_full_enumeration'},warnings:[],ranking:'Agent_judgment',automatic_adoption:false,query_mode:semantic?'semantic':'lexical',limit};
  let next=null;
  const encode=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
  const summary=(f,source,project)=>{
   const ref=source==='2.0'?{project_id:project.id||project.project_id,...(f.fixed_ref||{material_id:f.material_id,version_id:f.version_id,sha256:f.sha256})}:{file_id:f.id||f.file_id,address:f.address};
   const path=f.logical_path||f.name||f.title||f.filename||null;
   const description=typeof f.description==='string'?f.description:f.description?.text;
   const exact=q&&[path,String(path||'').split('/').at(-1)].some(x=>String(x).normalize('NFKC').toLowerCase()===q.normalize('NFKC').toLowerCase());
   const mode=source==='1.0'?'legacy_search':exact?'exact':f.match?.mode||(semantic?'semantic':'lexical');
   return{source,logical_path:path,title:f.title||String(path||'').split('/').at(-1)||null,...(project?{project:{id:project.id||project.project_id,title:project.title},project_id:project.id||project.project_id}:{}),...(source==='2.0'?{material_id:ref.material_id,version_id:ref.version_id,sha256:ref.sha256,fixed_ref:ref}: {file_id:ref.file_id}),reference:ref,description:description?{text:description.slice(0,700),coverage:description.length>700?'preview_truncated':'recorded_description'}:null,version_created_at:f.version_created_at||null,source_person:f.properties?.source_claim?.author_id||f.properties?.author_id||null,source_person_semantics:'recorded_hint_only;unknown_not_inferred',match:{mode,basis:f.match?.basis||(exact?'literal_name':'authorized_search_candidates')},ranking:f.ranking?{lexical_rank:f.ranking.lexical_rank??null,semantic_rank:semantic?(f.ranking.semantic_rank??null):null,score:f.ranking.score??null}:null};
  };
  if(scope!=='new'&&!position.legacy_done){
   if(!legacyAvailable)output.warnings.push({source:'1.0',error_code:'original_member_credential_required'});
   else try{const r=await invokeOld('mengchu_search',{q,limit:100,...(args.legacy_space?{space:args.legacy_space}:{})},req);const old=r.files||[];const start=position.offset;for(const f of old.slice(start,start+limit))output.items.push(summary(f,'1.0'));output.coverage.legacy='authorized_bounded_legacy_matches';if(start+limit<old.length)next={...position,offset:start+limit};else if(old.length>=100)output.warnings.push({source:'1.0',error_code:'legacy_candidate_window_full',next_step:'refine_legacy_query_or_use_native_search_paging'});}catch(e){output.warnings.push({source:'1.0',error_code:e.message});}
   if(!next)position={...position,offset:0,legacy_done:true};
  }
  if(scope!=='legacy'&&!next){
   let projects=[],page=null;const scoped=Boolean(args.project_id||args.project_name||args.project);
   try{
    if(scoped){const p=await resolveProject(auth,args,req,{optional:true});if(p)projects=[p];else output.warnings.push({source:'2.0',error_code:'project_not_found'});}
    else{page=await invokeNext(auth,'v8.project.search',{limit:20,...(position.pc?{cursor:position.pc}:{})},req);projects=(page.items||[]).map(x=>({...x,id:x.project_id}));}
    const scanned=[];let i=position.pi;
    while(i<projects.length){
     if(output.items.length>=limit){next={...position,pi:i,offset:i===position.pi?position.offset:0,legacy_done:true};break;}
     const chunk=projects.slice(i,i+4);
     const rows=await Promise.all(chunk.map(async p=>{const project_id=p.id||p.project_id;try{
      const input={project_id,query:q,limit:100,candidate_limit:100,semantic,...(args.properties?{properties:args.properties}:{}),...(args.version_created_after?{version_created_after:args.version_created_after}:{}),...(args.version_created_before?{version_created_before:args.version_created_before}:{})};
      let result;
      if(searchMetadata&&q)result=await searchMetadata(auth,input,req);
      else if(semantic&&q){const found=await invokeNext(auth,'mem.semantic.query',{project_id,text:q,top_k:100},req);result=found.receipt||found;}
      else result=await invokeNext(auth,'mem.search',{project_id,query:q,limit:100,...(args.properties?{properties:args.properties}:{})},req);
      return{project:p,result};
     }catch(e){return{project:p,error:e.message};}}));
     for(let j=0;j<rows.length;j++){
      const index=i+j,{project:p,result,error:failure}=rows[j];scanned.push({project_id:p.id||p.project_id,title:p.title,state:failure?'failed':'searched',candidate_window_complete:result?.coverage?.complete===true});
      if(failure){output.warnings.push({source:'2.0',project_id:p.id||p.project_id,error_code:failure});continue;}
      const items=result.items||result.candidates||[];const start=index===position.pi?position.offset:0;
      const available=limit-output.items.length;const chosen=items.slice(start,start+available);
      for(const f of chosen)output.items.push(summary(f,'2.0',p));
      if(start+chosen.length<items.length){next={...position,pi:index,offset:start+chosen.length,legacy_done:true};break;}
      if(items.length>=100)output.warnings.push({source:'2.0',project_id:p.id||p.project_id,error_code:'project_candidate_window_full',next_step:'refine_query_or_explicit_properties_before_claiming_complete_discovery'});
      if(output.items.length>=limit){if(index+1<projects.length)next={...position,pi:index+1,offset:0,legacy_done:true};else if(page?.next_cursor)next={...position,pc:page.next_cursor,pi:0,offset:0,legacy_done:true};break;}
     }
     i+=rows.length;if(next||output.items.length>=limit)break;
    }
    if(!next&&page?.next_cursor)next={...position,pc:page.next_cursor,pi:0,offset:0,legacy_done:true};
    output.coverage.projects={scanned,scanned_count:scanned.length,complete:!next&&!output.warnings.some(x=>x.source==='2.0'),project_directory_next_cursor:page?.next_cursor||null,snapshot:false};
    output.coverage.new=semantic?'authorized_description_and_metadata_candidates':'authorized_lexical_metadata_or_text_index_matches';
   }catch(e){output.warnings.push({source:'2.0',error_code:e.message});}
  }
  const unique=new Map();for(const item of output.items){const key=item.source+':'+(item.material_id||item.file_id)+':'+(item.version_id||'');if(!unique.has(key))unique.set(key,item);}output.items=[...unique.values()].slice(0,limit);
  output.returned_count=output.items.length;
  output.next_cursor=next?encode(next):null;
  output.next_step=next?{tool:'hub.materials.find',arguments:{...args,cursor:output.next_cursor},meaning:'continue_same_query;permissions_checked_again;not_a_snapshot'}:{action:semantic?'refine_query_or_select_and_read_original':'refine_query_or_explicitly_enable_semantic',meaning:'bounded_authorized_search_does_not_prove_global_absence'};
  if(!output.items.length)output.state=output.warnings.length||next?'discovery_partial':'no_matches';
  return output;
 }

 async function openDocument(auth,args,req,legacyAvailable){
  if(args.file_id||args.address){
   if(!legacyAvailable)throw error('original_member_credential_required',403);
   const address=args.file_id||args.address;
   if(args.address){const u=new URL(args.address);if(u.protocol!=='https:'||u.hostname!=='service.example.invalid'||!u.pathname.startsWith('/f/')||u.username||u.password)throw error('known_document_reference_required');}
   const r=await invokeOld('mengchu_get',{file_id:address,...(args.ver?{ver:args.ver}:{})},req);return{...r,source:'1.0',reference:{file_id:r.file_id||args.file_id,address:r.address},coverage:r.text!==undefined||r.content_base64!==undefined||r.base64!==undefined?'whole_original':'metadata_and_address'};
  }
  const project=await resolveProject(auth,args,req);const project_id=project.id||project.project_id;let material_id=args.material_id;
  if(!material_id){if(!args.path)throw error('path_or_material_required');const r=await findPath(auth,{project_id,paths:[args.path]},req);const exact=r.items.filter(x=>x.logical_path===args.path);if(exact.length!==1)throw Object.assign(error(exact.length?'document_path_ambiguous':'document_not_found',exact.length?409:404),{detail:{candidates:exact,next_step:'Agent_selects_actual_material_or_adjusts_path'}});material_id=exact[0].material_id;}
  const r=await readFull(auth,{project_id,material_id,...(args.version_id?{version_id:args.version_id}:{}),...(args.sha256?{sha256:args.sha256}:{}),...(args.encoding?{encoding:args.encoding}:{})},req);
  return{...r,source:'2.0',project:{id:project_id,title:project.title},reference:{project_id,...r.fixed_ref}};
 }

 async function resume(auth,args,req,legacyAvailable){
  if(args.task_id){if(!legacyAvailable)throw error('original_member_credential_required',403);if(!/^[A-Za-z0-9_-]{1,120}$/.test(args.task_id))throw error('actual_task_id_required');const task=await invokeOld('hub_api',{system:'v8',method:'GET',path:'/api/v2/'+(args.view==='control'?'control':'me')+'/tasks/'+args.task_id},req);return{state:'ready_to_continue',source:'1.0',task:task.body||task,next_step:'Agent_uses_current_TaskContext_and_allowed_actions;no_automatic_state_change'};}
  const project=args.work_item_id&&uuid.test(args.project_id||'')?{id:args.project_id}:await resolveProject(auth,args,req);const project_id=project.id||project.project_id;let work_item_id=args.work_item_id;
  if(!work_item_id){let cursor,items=[];do{const r=await invokeNext(auth,'v8.work.search',{project_id,query:args.work_no?'':args.q||'',limit:100,...(cursor?{cursor}:{})},req);items.push(...r.items);cursor=r.next_cursor;
   if(args.work_no){const found=items.find(x=>Number(x.short_no)===Number(args.work_no));if(found){work_item_id=found.work_item_id;break;}}
   else break;
  }while(cursor);
   if(!work_item_id){if(!args.work_no&&items.length===1&&args.q)work_item_id=items[0].work_item_id;else return{state:'choose_work',project:{id:project_id,title:project.title},candidates:items,next_cursor:cursor||null,next_step:'Agent_selects_work_item;no_automatic_latest_selection'};}}
  const work=await invokeNext(auth,'v8.work.read',{project_id,work_item_id},req);let view=null,context_warning=null;
  // Reuse the latest readable stage understanding, not an empty context.
  // work.read already applied the caller's current authorization.
  const stage=(work.updates||[]).filter(x=>x.statement?.context&&typeof x.statement.context==='object'&&!Array.isArray(x.statement.context)).sort((a,b)=>Number(b.work_revision||b.statement?.previous_revision||0)-Number(a.work_revision||a.statement?.previous_revision||0))[0];
  const inherited={};
  for(const name of ['effective_decisions','dissenting_views','rejected_explanations','fixed_refs','limitations','pending_operations','next_steps','source_coverage','complete','estimated_tokens','token_budget','ttl_seconds','judgments','properties']){
   if(stage?.statement.context[name]!==undefined)inherited[name]=stage.statement.context[name];
  }
  if(args.context_id||args.include_context===true){try{let context_id=args.context_id;if(!context_id){const c=await invokeNext(auth,'v8.context.prepare',{project_id,work_item_id,source_coverage:'partial',complete:false,...inherited,...(work.work_item?.revision?{expected_work_revision:work.work_item.revision}:{}),...(args.next_steps?{next_steps:args.next_steps}:{})},req);context_id=c.context_id;}
   view=await invokeNext(auth,'v8.context.materialize',{project_id,context_id,mode:'clipped'},req);
  }catch(e){context_warning={state:'readable_work_preserved',error_code:e.message};}}
  // A bounded context view is navigation, not an empty stage understanding.
  // The stage metadata here came from the caller-authorized work.read above.
  const returned=view?.returned_view||{};
  const basis=args.context_id?returned:{...stage?.statement.context,...returned};
  const declaredRefs=!args.context_id?stage?.statement.context.fixed_refs:null;
  const allowedRefs=returned.fixed_refs;
  const refs=declaredRefs&&Array.isArray(allowedRefs)?declaredRefs.filter(ref=>allowedRefs.some(x=>x.material_id===ref.material_id&&x.version_id===ref.version_id&&x.sha256===ref.sha256)):(declaredRefs||allowedRefs||work.fixed_refs||[]);
  const materials=args.include_material_metadata===true?await Promise.all(refs.slice(0,12).map(async ref=>{
   try{const location=await invokeNext(auth,'mem.material.locate',{material_id:ref.material_id,version_id:ref.version_id},req);
    const source_project_id=location.project_id;let h,metadata_warning;
    try{h=await invokeNext(auth,'mem.material.head',{project_id:source_project_id,material_id:ref.material_id},req);}catch(e){metadata_warning=e.message;}
    return{fixed_ref:ref,source_project_id,current_metadata:h?{properties:h.properties,placements:h.placements,content_revision:h.content_revision,metadata_revision:h.metadata_revision}:null,metadata_warning,latest_ref:h?.fixed_ref,source_stale:h? h.fixed_ref?.version_id!==ref.version_id:'unknown',read:{tool:'hub.document.open',arguments:{project_id:source_project_id,material_id:ref.material_id,version_id:ref.version_id,sha256:ref.sha256}}};
   }catch(e){return{fixed_ref:ref,metadata_state:'not_available_to_current_caller',metadata_warning:e.message,next_step:'do_not_infer_new_access_from_reference;continue_with_available_work'};}
  })):refs.map(ref=>({fixed_ref:ref,metadata_state:'not_requested',read:{tool:'mem.material.locate',arguments:{material_id:ref.material_id,version_id:ref.version_id}}}));
  const compactWork={state:work.state,work_item:work.work_item,current_summary:work.current_summary,coverage:work.coverage,read_receipt_id:work.read_receipt_id,work_judgment:work.work_judgment};
  const compactContext=view?{state:view.state,context_id:view.context_id,view_id:view.view_id,coverage:view.coverage,warnings:view.warnings,expansion:view.expansion,returned_view:{goal:basis.goal,summary:basis.summary,effective_decisions:basis.effective_decisions,rejected_explanations:basis.rejected_explanations,dissenting_views:basis.dissenting_views,limitations:basis.limitations,pending_operations:basis.pending_operations,next_steps:basis.next_steps,fixed_refs:refs,source_coverage:basis.source_coverage,current_work:basis.current_work,delta:{work_changed:view.delta?.work_changed,project_changed:view.delta?.project_changed,context_expired:view.delta?.context_expired,fixed_inputs_preserved:view.delta?.fixed_inputs_preserved,new_version_candidates:view.delta?.new_version_candidates}}}:null;
  return{state:'ready_to_continue',project:{id:project_id,title:project.title},work_item_id,work:args.include_history===true?work:compactWork,context:args.include_history===true?view:compactContext,context_warning,continuation:{goal:work.work_item?.goal,summary:work.current_summary?.text,effective_decisions:basis.effective_decisions||[],rejected_explanations:basis.rejected_explanations||[],limitations:basis.limitations||[],next_steps:args.next_steps||basis.next_steps||[],materials,metadata_coverage:{state:args.include_material_metadata===true?'resolved':'not_requested',returned:args.include_material_metadata===true?materials.length:0,total_references:refs.length,complete:args.include_material_metadata===true&&refs.length<=12},history:{tool:'v8.work.read',arguments:{project_id,work_item_id},omitted:args.include_history!==true},meaning:'current_authorized_Agent_declared_progress;not_automatic_full_transcript_or_new_permission'},stage_context_origin:stage?{update_id:stage.update_id,work_revision:stage.work_revision??null,meaning:'latest_currently_readable_explicit_stage_context;not_automatic_full_conversation_capture'}:null,next_step:'Agent_reads_needed_fixed_materials_and_continues_current_work;no_automatic_completion'};
 }
 const govern=createMaterialGovern({state:governState,invokeNext,resolveProject,findPath,error});
 return{resolveProject,find,openDocument,resume,govern};
}
