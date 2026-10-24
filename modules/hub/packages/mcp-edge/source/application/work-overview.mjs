import {createHash} from 'node:crypto';

// Application projection of caller-authorized V8 declarations; never a second work state.
export function normalizeWorkNumber(value) {
 const text=String(value).trim().replace(/^(?:W-|#)/i,'');
 if(!/^\d{1,15}$/.test(text))throw Error('invalid_work_short_no');
 const n=Number(text);
 if(!Number.isSafeInteger(n)||n<1)throw Error('invalid_work_short_no');
 return n<1000000?n+1000000:n;
}
export async function recentDeclarations(invoke,auth,work,project_id,req) {
 const observed=Number(work.work_item?.revision||0),warnings=[];
 const rows=(work.updates||[]).filter(x=>Number(x.work_revision)<=observed).sort((a,b)=>Number(b.work_revision)-Number(a.work_revision)).slice(0,3);
 const declarations=await Promise.all(rows.map(async row=>{
  if(row.statement)return {...row,statement:row.statement};
  const id=row.statement_id||row.update_id;
  if(!id)return null;
  try {
   const r=await invoke(auth,'v8.statement.read_chunk',{project_id,kind:'work_update',statement_id:id,limit:16384},req);
   if(r.coverage?.complete!==true||r.next_offset!=null||typeof r.text!=='string')throw Error('declaration_window_incomplete');
   const hash=createHash('sha256').update(r.text).digest('hex');
   if((row.sha256&&row.sha256!==hash)||(r.sha256&&r.sha256!==hash))throw Error('declaration_hash_mismatch');
   return {...row,update_id:id,statement:JSON.parse(r.text)};
  }catch(e){warnings.push({update_id:id,error_code:e.message});return null;}
 }));
 return {declarations:declarations.filter(Boolean),warnings,coverage:{window:3,returned:declarations.filter(Boolean).length,full_history:false,at_work_revision:observed}};
}
export function currentOverview(work,recent,materials,history) {
 const item=work.work_item||{}, latest=recent.declarations.find(x=>(x.update_id||x.statement_id)===work.current_summary?.update_id),statement=latest?.statement;
 const context=statement?.context||{};
 const explicit=[...(context.limitations||[]),...(context.pending_operations||[]).filter(x=>!['completed','cancelled','resolved','succeeded'].includes(x.state))];
 // Quoted current declaration is evidence for Agent judgment, not an inferred issue ledger.
 const summary=work.current_summary?.text||'';
 const excerpts=summary.split(/[；;。\n]/u).filter(x=>/未解决|尚未|待解决|阻碍|阻塞|受阻|失败|不可用|无法|未通过|未验证|未完成|Connection refused/i.test(x)).slice(0,3);
 return {
  overview:{work_no:item.short_no,goal:item.goal,state:item.state,revision:item.revision,updated_at:item.updated_at,completion_semantics:'current_work_state;historical_completed_receipt_does_not_override',historical_completion_receipt_present:!!item.completed_receipt_id},
  latest_progress:{...work.current_summary,meaning:'latest_authorized_declaration;not_independent_business_verification'},
  unresolved:{state:explicit.length?'explicitly_declared':excerpts.length?'current_summary_mentions':'not_explicitly_recorded',items:explicit,current_summary_excerpts:excerpts,source_update_id:work.current_summary?.update_id||null,meaning:'declarations_and_quotes_for_Agent_judgment;empty_does_not_mean_resolved;older_issues_not_auto_closed'},
  key_outputs:materials.slice(0,5),
  coverage:{...recent.coverage,warnings:recent.warnings,key_outputs:'recent_declared_outputs_then_fixed_inputs;not_exhaustive_or_automatic_adoption'},
  history
 };
}
