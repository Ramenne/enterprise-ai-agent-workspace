import {createHash,randomUUID} from 'node:crypto';
import {readFile,open,rename} from 'node:fs/promises';
import {resolvedDocumentFields} from './document-contract.mjs';
const hash=x=>createHash('sha256').update(x).digest('hex');
const canonical=x=>x&&typeof x==='object'?(Array.isArray(x)?'['+x.map(canonical).join(',')+']':'{'+Object.keys(x).sort().map(k=>JSON.stringify(k)+':'+canonical(x[k])).join(',')+'}'):JSON.stringify(x);
/** One hosted instance owns the existing journal and in-flight map. */
export function createDocumentSave({journalRoot,invokeNext,findPath,error}){
const documentJobs=new Map();
return async function saveDocument(auth,a,req){
 const allowed=resolvedDocumentFields;
 if(Object.keys(a).some(k=>!allowed.has(k))||typeof a.project_id!=='string'||typeof a.path!=='string'||typeof a.text!=='string'||a.note!==undefined&&typeof a.note!=='string')throw error('invalid_document_input');
 const key=a.idempotency_key||randomUUID(),actor=auth.identity.actor_id;const filename=journalRoot+'/'+hash(actor+'\n'+key)+'.json';const fingerprint=hash(canonical({...a,idempotency_key:undefined}));
 const lock=hash(actor+'\n'+key);if(documentJobs.has(lock)){await documentJobs.get(lock);return saveDocument(auth,{...a,idempotency_key:key},req);}
 const task=(async()=>{
  let j;try{j=JSON.parse(await readFile(filename,'utf8'));if(j.fingerprint!==fingerprint)throw error('idempotency_conflict',409);}catch(e){if(e.code!=='ENOENT')throw e;j={fingerprint,actor,key,phase:'prepared'};}
  const store=async()=>{const temporary=filename+'.'+randomUUID()+'.tmp';const out=await open(temporary,'wx',0o600);try{await out.writeFile(JSON.stringify(j));await out.sync();}finally{await out.close();}await rename(temporary,filename);const dir=await open(journalRoot,'r');try{await dir.sync();}finally{await dir.close();}};
  const invoke=(name,args)=>invokeNext(auth,name,args,req);
  if(!j.target){let material_id=a.material_id;if(!material_id){let found;try{found=await findPath(auth,{project_id:a.project_id,paths:[a.path]},req);}catch(e){if(e.status!==403)throw e;found={items:[]};}const exact=found.items.filter(x=>x.logical_path===a.path);if(exact.length>1)throw error('ambiguous_path_choose_material',409);material_id=exact[0]?.material_id;}
   j.target={project_id:a.project_id,logical_path:a.path,idempotency_key:'document:'+key};j.important_at_save=a.properties?.governance?.important===true;j.index_eligible_at_save=[1,2].includes(a.properties?.governance?.importance_level)||j.important_at_save;if(material_id){const head=await invoke('mem.material.head',{project_id:a.project_id,material_id});j.important_at_save=a.properties?.governance?.important??head.properties?.governance?.important;j.index_eligible_at_save=[1,2].includes(a.properties?.governance?.importance_level??head.properties?.governance?.importance_level)||j.important_at_save===true;j.target={...j.target,material_id,base_version_id:a.base_version_id||head.fixed_ref?.version_id,base_revision:a.base_revision??head.content_revision};}await store();}
  // The same original intent rechecks current write authority even when replaying a receipt.
  {const published=await invoke('mem.write_text',{...j.target,text:a.text,...(a.properties?{properties:a.properties}:{}),...(a.source?{source:a.source}:{})});j.document=published;j.phase=published.state==='published'?'document_saved':'document_pending';await store();}
  const pending=()=>({state:'document_pending',idempotency_key:key,project_id:a.project_id,resume_id:j.document.resume_id,error_code:j.document.error_code,document:j.document,recovery:{query:{tool:'mem.write_text.query',arguments:{project_id:a.project_id,resume_id:j.document.resume_id}},resume:{tool:'mem.write_text.resume',arguments:{project_id:a.project_id,resume_id:j.document.resume_id}},replay:{tool:'hub.document.save',instruction:'reuse_exact_original_input_and_idempotency_key_after_fix;do_not_upload_again'}},next_step:'query_text_draft_not_upload_operation;resume_same_draft_after_dependency_or_input_fix'});
  if(j.document.state!=='published'&&j.document.resume_id&&j.document.retryable!==false){try{j.document=await invoke('mem.write_text.resume',{project_id:a.project_id,resume_id:j.document.resume_id,...(j.target.material_id?{material_id:j.target.material_id,base_version_id:j.target.base_version_id,base_revision:j.target.base_revision}:{})});await store();}catch(e){j.document.resume_error={error_code:e.message};await store();return pending();}}
  if(j.document.state!=='published')return pending();
  const fixed=j.document.fixed_refs?.[0];if(!fixed)throw error('published_reference_missing',502);
  if(a.note!==undefined&&(!j.description||j.description.state==='enrichment_pending')){try{if(j.description_revision===undefined){const {material_id,version_id,sha256}=fixed;const current=await invoke('mem.description.read',{project_id:a.project_id,material_id,version_id,sha256});j.description_revision=current.description?.revision||0;await store();}
   const {material_id,version_id,sha256}=fixed;j.description=await invoke('mem.description.save',{project_id:a.project_id,material_id,version_id,sha256,text:a.note,expected_revision:j.description_revision,source_declaration:{author:'current_Agent',purpose:'document_introduction'},idempotency_key:'document-note:'+key});await store();
  }catch(e){j.description={state:'enrichment_pending',error_code:e.message,document_saved:true};await store();}}
  if(a.register_work!==false&&!j.work){if(!j.work_body){const {material_id,version_id,sha256}=fixed;j.work_body={project_id:a.project_id,goal:a.goal||'撰写与维护 '+a.path,summary:a.summary||a.note||'文档已保存，后续按实际工作继续补充。',outputs:[{material_id,version_id,sha256,role:'document'}],related_assessment:'unassessed',completion_state:a.completion_state||'in_progress',context:{source_coverage:'partial',complete:false,...(a.context||{}),next_steps:a.next_steps||a.context?.next_steps||['读取固定原件，结合实际工作继续推进。']},idempotency_key:'document-work:'+key};if(a.work_item_id){const previous=await invoke('v8.work.read',{project_id:a.project_id,work_item_id:a.work_item_id});j.work_body.work_item_id=a.work_item_id;j.work_body.expected_revision=previous.work_item.revision;}await store();}
   try{j.work=await invoke('v8.work.save',j.work_body);await store();}catch(e){return{state:'document_saved_work_pending',idempotency_key:key,document:j.document,fixed_ref:fixed,error_code:e.message,next_step:'replay_same_hub.document.save_input_and_key;do_not_upload_again'};}}
  // Semantic enrichment follows the authorized Agent's explicit importance judgment.
  // Native indexing rechecks current importance and authority; its failure cannot undo the file.
  if((j.index_eligible_at_save===true||j.important_at_save===true)&&a.note!==undefined&&j.description?.state!=='enrichment_pending'&&(!j.index||j.index.state==='enrichment_pending')){
   try{j.index=await invoke('mem.semantic.index_fixed',{project_id:a.project_id,fixed_ref:{material_id:fixed.material_id,version_id:fixed.version_id,sha256:fixed.sha256}});}
   catch(e){j.index={state:'enrichment_pending',error_code:e.message,document_saved:true,next_step:'retry_same_save_or_index_the_fixed_description'};}await store();
  }
  j.phase='complete';await store();return{state:'saved',idempotency_key:key,fixed_ref:fixed,document:j.document,description:j.description||{state:'not_requested'},work:j.work||{state:'not_requested'},index:j.index||{state:'not_requested',reason:'level_1_or_2_Agent_description_required'},original_workflow:'same_path_write_upload_register',automatic_vector_index:j.index?.state==='description_indexed',index_policy:'importance_level_1_and_2_Agent_description_only;failure_does_not_block_file'};
 })();documentJobs.set(lock,task);try{return await task;}catch(e){e.detail={...(e.detail||{}),idempotency_key:key,next_step:'replay_same_input_and_key;original_intent_preserved'};throw e;}finally{documentJobs.delete(lock);}
}

}
