import {sha256,NativeError} from './client.mjs';

// A member-selected visible message fragment, not a complete conversation export.
export function messageFragment(message) {
  if(!message?.id||message.hidden||message.recalled)throw new NativeError('message_not_available');
  return {coverage:'member_selected_visible_message',message:{id:message.id,body:message.body,
    author_username:message.author_username,author_name:message.author_name,created_at:message.created_at,
    context:message.context??null,attachments:(message.attachments||[]).map(a=>({id:a.id,name:a.name,
      file_id:a.file_id,ver:a.ver,sha256:a.sha256,size:a.size}))}};
}

/** @param {{load?:()=>any,save?:(state:any)=>void,valid?:()=>boolean}} options */
export async function saveDiscussionRecord(client,input,key,{load=()=>null,save=(_value)=>{},valid=()=>Boolean(true)}={}) {
  const active=()=>{if(!valid())throw new NativeError('session_changed',401);};
  if(!input.project_id||!input.work_item_id||!input.summary?.trim())throw new NativeError('work_record_target_required');
  const fragment=JSON.stringify(messageFragment(input.message),null,2);
  const fingerprint=await sha256(new TextEncoder().encode(JSON.stringify({project_id:input.project_id,
    work_item_id:input.work_item_id,summary:input.summary,fragment})));
  active();
  let state=load();
  if(state&&state.fingerprint!==fingerprint)throw new NativeError('work_record_resume_mismatch');
  if(!state){state={fingerprint};save(state);}
  if(!state.upload){
    const work=await client.work(input.project_id,input.work_item_id);active();
    const w=work.work_item;
    if(w?.id!==input.work_item_id||w.project_id!==input.project_id)throw new NativeError('work_scope_mismatch');
    // Preserve the read revision and goal before any write or possible lost reply.
    state.work={id:w.id,revision:w.revision,short_no:w.short_no,goal:w.goal,state:w.state};save(state);
    const original=new File([fragment],'群讨论-'+input.message.id+'.json',{type:'application/json'});
    state.upload=await client.prepareUpload(input.project_id,original,key+'-source');active();save(state);
  }
  if(!state.fixed){
    const original=new File([fragment],state.upload.name,{type:'application/json'});
    const published=await client.finishUpload(state.upload,original);active();
    state.fixed=published.fixed_refs[0];save(state);
  }
  if(!state.commit){
    const fixed=state.fixed;
    state.commit={project_id:input.project_id,work_item_id:input.work_item_id,
      expected_revision:state.work.revision,summary:input.summary.trim(),...(state.work.state?{completion_state:state.work.state}:{}),
      outputs:[{material_id:fixed.material_id,version_id:fixed.version_id,sha256:fixed.sha256,role:'result'}],
      explanation:{source_coverage:'member_selected_visible_message;not_full_conversation_export',
        message_id:input.message.id,judgment:'成员明确选择将本条讨论结论追加到已读取的工作；不自动建立跨工作关联。'},
      properties:{work_judgment:{decision:'continuation',reason:'成员明确选择将本条讨论结论追加到此工作，已读取该工作目标：'+state.work.goal,
        compared_work_ids:[input.work_item_id]},employeeclient_message_reference:{message_id:input.message.id,coverage:'member_selected_visible_message'}},
      related_assessment:'unassessed',context:true,idempotency_key:key};save(state);
  }
  active();
  const result=await client.rpc('v8.work.save',state.commit,key);active();
  if(result.state!=='saved')throw new NativeError('work_record_not_confirmed');
  return {...result,source_fixed_ref:state.fixed};
}
