import {infrastructureFailure,infrastructureResponse,domainErrorCode} from '../../../packages/platform/src/failure-contract.mjs';
import {installEmployeeClientMemberBalance,memberBalanceContract} from './employeeclient-member-balance.mjs';
import {createHash} from 'node:crypto';
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
export function serviceProof(headers){
 const value=headers['x-hufu-service-authorization'];
 if(value===undefined)return null;
 const token=typeof value==='string'&&value.match(/^Bearer (.+)$/)?.[1];
 if(!token||token.length>4096)throw Object.assign(Error('invalid_service_authorization'),{code:'22023'});
 return createHash('sha256').update(token).digest('hex');
}
const cents=n=>Number.isSafeInteger(n)&&n>=0&&n<=10000000000;
const operations={
 '/v2/board/tasks/propose':['task_propose',['task_id','expected_revision','title','description','direction','project_id','project_name','materials','suggested_cash_cents','suggested_points_cents','note'],[]],
 '/v2/board/tasks/decide':['task_decide',['task_id','expected_revision','decision','reason','title','description','direction','materials','cash_cents','base_points_cents','confirm_suggested_terms'],['task_id','expected_revision','decision']],
 '/v2/board/proposals/query':['proposals_read',['member_id','state','cursor','limit'],[]],
 '/v2/board/proposals/history':['proposal_history_read',['task_id','after_revision','limit'],['task_id']],
 '/v2/board/tasks/lookup':['tasks_lookup',['title','task_id','project_name','cursor','limit','execution_state','owner_id'],[]],
 '/v2/board/tasks/publish':['task_publish',['task_id','expected_revision','title','project_name','project_id','work_item_id','description','direction','materials','terms','state'],[]],
 '/v2/board/claims/record':['claim',['task_id','title','project_name','member_id','claimed_at','source','note','participation_role'],[]],
 '/v2/board/receipts/save':['receipt_save',['task_id','title','project_name','claim_id','member_id','text','result_refs','declared_state','supersedes_id','source','claimed_at','note','expected_task_revision'],['text']],
 '/v2/board/receipts/query':['receipts_read',['task_id','title','project_name','member_id','since','until','cursor','limit'],[]],
 '/v2/board/settings/read':['settings_read',[],[]],
 '/v2/board/settings/save':['settings_save',['debtor_id','expected_revision','settings'],['debtor_id']],
 '/v2/points/account':['wallet_read',['member_id','cursor','limit'],[]],
 '/v2/points/awards/post':['award',['claim_id','receipt_id','base_points_cents','quality_points_cents','cash_cents','note'],['claim_id','receipt_id']],
 '/v2/points/cash/pay':['cash_pay',['claim_id','amount_cents','actual_payment_confirmed','note'],['claim_id','amount_cents','actual_payment_confirmed']],
 '/v2/points/conversions/request':['conversion_request',['claim_id','amount_cents','mode','note'],['claim_id','amount_cents','mode']],
 '/v2/points/conversions/confirm':['conversion_confirm',['conversion_id','expected_revision','cash_return_received','note'],['conversion_id','expected_revision']],
 '/v2/points/conversions/cancel':['conversion_cancel',['conversion_id','expected_revision'],['conversion_id','expected_revision']],
 '/v2/points/redemptions/request':['redemption_request',['amount_cents','note'],['amount_cents']],
 '/v2/points/redemptions/agree':['redemption_agree',['redemption_id','expected_revision'],['redemption_id','expected_revision']],
 '/v2/points/redemptions/postpone':['redemption_postpone',['redemption_id','expected_revision','proposed_due_at','note'],['redemption_id','expected_revision','proposed_due_at']],
 '/v2/points/redemptions/confirm-postpone':['redemption_confirm_postpone',['redemption_id','expected_revision','amount_cents','proposed_due_at'],['redemption_id','expected_revision','amount_cents','proposed_due_at']],
 '/v2/points/redemptions/pay':['redemption_pay',['redemption_id','expected_revision','actual_payment_confirmed','note'],['redemption_id','expected_revision','actual_payment_confirmed']],
 '/v2/points/redemptions/reject':['redemption_reject',['redemption_id','expected_revision','note'],['redemption_id','expected_revision']],
 '/v2/points/redemptions/cancel':['redemption_cancel',['redemption_id','expected_revision'],['redemption_id','expected_revision']],
 '/v2/points/entries/correct':['entry_correct',['entry_id','reason'],['entry_id','reason']],
 '/v2/board/operations/query':['operations_read',['idempotency_key'],['idempotency_key']]
};
const reads=new Set(['proposals_read','proposal_history_read','tasks_lookup','receipts_read','wallet_read','settings_read','operations_read']);
export function validateBoardBody(op,body,allowed,required){
 if(!body||typeof body!=='object'||Array.isArray(body))throw Error('invalid_input');
 const keys=new Set([...allowed,...(!reads.has(op)?['idempotency_key']:[])]);
 if(Object.keys(body).some(k=>!keys.has(k))||required.some(k=>body[k]===undefined))throw Error('invalid_input');
 if(!reads.has(op)&&!(typeof body.idempotency_key==='string'&&body.idempotency_key.length>0&&body.idempotency_key.length<=200))throw Error('idempotency_key_required');
 for(const[k,v]of Object.entries(body)){
  if(k.endsWith('_id')&&!uuid.test(v))throw Error('invalid_'+k);
  if(k==='cursor'&&!uuid.test(v)&&!(op==='tasks_lookup'&&/^v3:[a-f0-9]{32}:[a-f0-9-]{36}$/.test(v)))throw Error('invalid_cursor');
  if(k.endsWith('_cents')&&!cents(v))throw Error('invalid_amount');
  if(k==='expected_revision'&&(!Number.isSafeInteger(v)||v<0))throw Error('invalid_revision');
  if(['claimed_at','since','until','proposed_due_at'].includes(k)&&(!(typeof v==='string')||!Number.isFinite(Date.parse(v))))throw Error('invalid_date');
  if(['text','description','direction','note','reason','title','project_name'].includes(k)&&(!(typeof v==='string')||v.length>16000))throw Error('invalid_text');
  if(['actual_payment_confirmed','cash_return_received'].includes(k)&&typeof v!=='boolean')throw Error('invalid_confirmation');
 }
 if(body.limit!==undefined&&(!Number.isInteger(body.limit)||body.limit<1||body.limit>100))throw Error('invalid_limit');
 if(body.execution_state!==undefined&&!['waiting','claimed','in_progress','partial','blocked','completed','unknown','not_applicable'].includes(body.execution_state))throw Error('invalid_execution_state');
 if(body.participation_role!==undefined&&!['owner','collaborator'].includes(body.participation_role))throw Error('invalid_participation_role');
 if(body.expected_task_revision!==undefined&&(!Number.isSafeInteger(body.expected_task_revision)||body.expected_task_revision<1))throw Error('invalid_task_revision');
 if(body.mode!==undefined&&!['unpaid','returned'].includes(body.mode))throw Error('invalid_mode');
 if(body.declared_state!==undefined&&!['completed','partial','blocked','in_progress'].includes(body.declared_state))throw Error('invalid_declared_state');
 if(body.state!==undefined&&!(op==='proposals_read'?['proposed','changes_requested','rejected','published','archived']:['published','archived']).includes(body.state))throw Error('invalid_task_state');
 if(body.materials!==undefined&&(!Array.isArray(body.materials)||body.materials.length>100))throw Error('invalid_materials');
 if(body.result_refs!==undefined&&(!Array.isArray(body.result_refs)||body.result_refs.length>100))throw Error('invalid_result_refs');
 if(body.after_revision!==undefined&&(!Number.isSafeInteger(body.after_revision)||body.after_revision<0))throw Error('invalid_revision');
 if(body.confirm_suggested_terms!==undefined&&typeof body.confirm_suggested_terms!=='boolean')throw Error('invalid_confirmation');
 if(op==='task_decide'&&!['approve','request_changes','reject'].includes(body.decision))throw Error('invalid_decision');
 if(op==='task_decide'&&body.decision!=='approve'&&!body.reason?.trim())throw Error('decision_reason_required');
 if(op==='task_propose'&&body.task_id&&body.expected_revision===undefined)throw Error('expected_revision_required');
 if(['task_propose','task_decide'].includes(op)&&['title','description'].some(k=>body[k]!==undefined&&!body[k].trim()))throw Error('task_content_required');
 if(op==='task_propose'&&!body.task_id&&(!body.title?.trim()||!body.description?.trim()))throw Error('task_content_required');
 if(op==='receipt_save'&&!body.text?.trim())throw Error('receipt_text_required');
 if(op==='task_publish'&&!body.task_id&&(!body.title?.trim()||!body.description?.trim()))throw Error('task_content_required');
 if(op==='task_publish'&&body.task_id&&body.expected_revision===undefined)throw Error('expected_revision_required');
 return body;
}
export const boardContract={version:'task-points-v3',execution:{states:['waiting','claimed','in_progress','partial','blocked','completed'],policy:'one owner;explicit collaborators;terminal completion;no reopen;transactional claim uniqueness',fields:['publication_state','execution_state','owner','collaborators','participant_progress','progress_basis','can_claim','claim_block_reason','allowed_actions','task_revision','coverage','data_quality'],collaborator:'claims/record participation_role=collaborator with member_id;owner or supervisor registration;task service cannot grant roles',completion:'owner declaration only;collaborator completion is personal;expected_task_revision optional;supervisor on-behalf receipt requires note;completed owner may supplement completed only; confirmed claim reward posts atomically on owner completion; repeated completion never duplicates base award',cursor:'lookup emits v3 filter-bound cursor;legacy UUID accepted for legacy unfiltered calls',retry:'stable idempotency_key;operations/query;replay includes original result and current_task where applicable'},proposals:'member propose -> supervisor decide by expected_revision -> same task published;history retained;no auto claim; points post at completion from confirmed claim terms;not resource permission or completion review',identity:'existing Hufu member Bearer;optional X-Hufu-Service-Authorization: Bearer product-service credential;actual member actor retained;task_hall grants named-member claim/receipt/read only;no supervisor or finance delegation',tasks:'offline claim valid;title lookup;no terminal acceptance gate;receipt retention needs no approval',money:'integer cents;points 100 cents = 1 point = 1 CNY personal debt;cash separate',payment:'bookkeeping only;explicit actual_payment_confirmed;not a bank transfer',daily_budget:'parameter only;unset',rules:{quality:'explicit supervisor bonus amount;no automatic multiplier or fixed 150% limit',conversion:'member voluntary request;unpaid or actually returned cash;no quality multiplier',redemption:'agreement due in seven days;postponement needs matching member amount/date confirmation;debt survives reject/postpone',receipt:'retained immediately;no review queue'},endpoints:Object.fromEntries(Object.entries(operations).map(([path,[operation,fields,required]])=>[path,{method:'POST',operation,fields:reads.has(operation)?fields:[...fields,'idempotency_key'],required:reads.has(operation)?required:[...required,'idempotency_key']}]))};
boardContract.receipt_format={
 fields:['实际结果与可查看成果','还没完成或未确认的事（没有可省略）','这次留下的经验（无新经验可直说）'],
 example:'实际结果：完成价格对比，报告见成果附件。\n未确认：尚未实测供应商交期。\n经验：报价不含运费时要先统一到手价再比较。',
 artifacts:'report,video,screenshot,test_output_as_needed;not_all_required',
 experience:'merge useful lessons into existing domain document;no quota;no self score;knowledge write failure does not block settlement',
 submission:'existing receipts/save text and result_refs;explicit declared_state;in_progress/partial/blocked do not settle the whole task',
 settlement:'owner completed -> confirmed claim terms -> base points and cash due;no actual payment;missing price remains pending,never guessed'
};
boardContract.receipt_format.skill={name:'project-experience-distiller',version:'1.2.0',installation_required:false,
 read:{system:'hufu',method:'POST',path:'/v2/manuals/read',body:{id:'task-points'}},section:'回执整理 Skill：完整指令与模板',
 usage:'read the instructions and templates through MCP, then fill the existing receipt; no local installation or self grading required'};
boardContract.receipt_format.submit={system:'v8',method:'POST',path:'/v2/board/receipts/save',fields:'task_id or claim_id,text,result_refs as needed,explicit declared_state,stable idempotency_key'};
boardContract.rules.quality='supervisor may post quality_points_cents alone after base settlement through existing awards/post;omit base_points_cents/cash_cents;stable key prevents retry duplication;explicit additional amount,no automatic multiplier';
boardContract.endpoints['/v2/board/receipts/query'].response_additions={settlement:'current claim ledger totals;not a payment made for each receipt;integer cents;base/quality are awarded totals,debt/cash are current totals'};
export function installTaskPoints(app,pool){
 boardContract.endpoints['/v2/points/member-balance']=memberBalanceContract;
 installEmployeeClientMemberBalance(app,pool);
 app.get('/v2/board/help',async()=>boardContract);
 for(const[path,[op,fields,required]]of Object.entries(operations))app.post(path,{logLevel:'silent'},async(req,reply)=>{
  reply.header('cache-control','no-store');
  try{
   const token=req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];if(!token||token.length>4096)return reply.code(401).send({state:'failed',error_code:'unauthenticated'});
   const body=validateBoardBody(op,req.body??{},fields,required),proof=createHash('sha256').update(token).digest('hex');
   const delegated=serviceProof(req.headers);
   const board=async(operation,payload)=>{const args=[proof,operation,JSON.stringify(payload),...(delegated?[delegated]:[])];const {rows}=await pool.query(delegated?'SELECT v8.board_call($1,$2,$3::jsonb,$4) result':'SELECT v8.board_call($1,$2,$3::jsonb) result',args);return rows[0].result;};
   let b={...body};
   if(['claim','receipt_save'].includes(op)&&!b.task_id&&!b.claim_id&&b.title){
    const candidates=(await board('tasks_lookup',{title:b.title,...(b.project_name?{project_name:b.project_name}:{})})).items;
    if(candidates.length!==1)return reply.code(candidates.length?409:404).send({state:candidates.length?'ambiguous':'not_found',candidates,next_step:'select_actual_task_id;not_an_approval_gate'});b.task_id=candidates[0].id;
   }
   const result=await board(op,b);
   return op==='receipt_save'?{...result,receipt_guidance:boardContract.receipt_format}:result;
  }catch(e){const shared=infrastructureFailure(e);if(shared){const out=infrastructureResponse(shared,req.id);req.log?.warn({...out.diagnostic,request_id:req.id},'request failed');return reply.code(out.status).send(out.body);}const code=e.code==='23505'?'idempotency_conflict':e.code==='40001'?domainErrorCode(e.message,'revision_conflict'):e.code==='23514'?'balance_constraint':e.code==='22023'?domainErrorCode(e.message,'invalid_input'):e.message?.startsWith('invalid_')||e.message?.endsWith('_required')?domainErrorCode(e.message,'invalid_input'):'task_points_unavailable';const status=['23505','40001','23514'].includes(e.code)?409:e.code==='22023'||code!=='task_points_unavailable'?400:503;return reply.code(status).send({state:'failed',error_code:code,...(op==='receipt_save'&&status===400?{receipt_guidance:boardContract.receipt_format}:{})});}
 });
}

// Read facade owns no business facts. Existing write routes stay authoritative.
export const memberWorkContract={version:'member-work-v2',methods:'POST',endpoints:['list','detail','activity','understanding'].map(x=>'/v2/member-work/'+x),ref:'board: claim id; v8: work id + project_id; IDs are existing source IDs',owners:{identity:'hufu',task:'board_tasks',claim:'board_claims',declaration:'board_receipts',engineering:'v8.work',files:'mem',understanding:'xingxiu',money:'points_entries'},list:'include_history defaults false and hides explicit test/migrated_history/archived projects and archived task cards; member_id defaults to self; supervisor may select member; linked authored work appears under its claimed task rather than twice; role is explicit',state:'board declared_state is personal;task_execution is shared board projection;V8 engineering_state remains independent;no_receipt is unknown actual progress',understanding:'source-authorized cached AI judgment; absence/pending is not no work; 900-second discovery, model completion is asynchronous',coverage:'registered claims and authored engineering work;not desktop/runtime monitoring',cursor:'opaque stable source key; reuse same filters; concurrent changes are a current view, not a frozen snapshot',writes:'use original board/work/points interfaces; this facade cannot mutate facts'};
export function installMemberWork(app,pool,call){
 app.get('/v2/member-work/help',async()=>memberWorkContract);
 for(const op of ['list','detail','activity','understanding'])app.post('/v2/member-work/'+op,{logLevel:'silent'},async(req,reply)=>{
  reply.header('cache-control','no-store');
  try{
   const token=req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];if(!token||token.length>4096)return reply.code(401).send({state:'failed',error_code:'unauthenticated'});
   const b=req.body??{},allowed=op==='list'?['member_id','project_id','state','cursor','limit','include_history','task_execution_state']:op==='understanding'?['member_id','project_id','ref','limit']:['member_id','ref','cursor','limit'];
   if(!b||typeof b!=='object'||Array.isArray(b)||Object.keys(b).some(k=>!allowed.includes(k)))throw Error('invalid_input');
   for(const k of ['member_id','project_id'])if(b[k]!==undefined&&!uuid.test(b[k]))throw Error('invalid_'+k);
   if(b.limit!==undefined&&(!Number.isInteger(b.limit)||b.limit<1||b.limit>100))throw Error('invalid_limit');
   if(b.cursor!==undefined&&(typeof b.cursor!=='string'||b.cursor.length>200))throw Error('invalid_cursor');
   if(b.include_history!==undefined&&typeof b.include_history!=='boolean')throw Error('invalid_include_history');
   if(b.task_execution_state!==undefined&&!['waiting','claimed','in_progress','partial','blocked','completed','unknown','not_applicable'].includes(b.task_execution_state))throw Error('invalid_task_execution_state');
   if(b.state!==undefined&&!['completed','partial','blocked','no_receipt','open','in_progress','cancelled'].includes(b.state))throw Error('invalid_state');
   const ref=b.ref;if(ref!==undefined&&(!ref||Array.isArray(ref)||!['board','v8'].includes(ref.source)||!uuid.test(ref.id)||Object.keys(ref).some(k=>!['source','id','project_id','task_id'].includes(k))||ref.project_id!==undefined&&!uuid.test(ref.project_id)))throw Error('invalid_ref');
   if(['detail','activity'].includes(op)&&!ref)throw Error('invalid_ref');
   const delegated=serviceProof(req.headers);
   const readBoard=async(operation,body)=>{const{rows}=await pool.query(delegated?'SELECT v8.member_work_read($1,$2,$3::jsonb,$4) result':'SELECT v8.member_work_read($1,$2,$3::jsonb) result',[createHash('sha256').update(token).digest('hex'),operation,JSON.stringify(body),...(delegated?[delegated]:[])]);return rows[0].result;};
   if(delegated&&op==='understanding')throw Object.assign(Error('task_service_operation_forbidden'),{code:'42501'});
   if(delegated&&ref?.source==='v8')await readBoard('list',{limit:1,...(b.member_id?{member_id:b.member_id}:{})});
   if(op==='list')return await readBoard('list',b);
   if(op==='understanding'){
    let member=b.member_id;if(ref?.source==='board'){const current=await readBoard('detail',b);member=current.claim.member_id;}
    if(ref?.source==='v8'){if(!ref.project_id)throw Error('invalid_ref');await call(req,'work_read','v8.work.read',{project_id:ref.project_id,work_item_id:ref.id});}
    const payload={view:'progress',limit:Math.min(b.limit??30,50),...(member?{member_id:member}:{}),...(b.project_id?{project_id:b.project_id}:{}),...(ref?{work_id:ref.source==='board'?'board:'+ref.id:ref.id}:{} )};
    try{const r=await fetch('http://127.0.0.1:8943/query',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify(payload),signal:AbortSignal.timeout(20000)});const result=await r.json();if(!r.ok)return reply.code(r.status).send(result);return {...result,understanding_state:result.items?.length?'available':'pending_or_not_enrolled',authority:'xingxiu;derived_not_task_state'};}catch{return reply.code(503).send({state:'partial',error_code:'understanding_unavailable',facts_available:true,next_step:'use_list_or_detail;AI_is_not_a_fact_query_gate'});}
   }
   if(ref.source==='board')return await readBoard(op,b);
   if(!ref.project_id)throw Error('invalid_ref');
   if(op==='detail'){const result=await call(req,'work_read','v8.work.read',{project_id:ref.project_id,work_item_id:ref.id});return {state:'read',ref,engineering:result,authority:'v8.work;not_member_claim',observed_at:new Date().toISOString()};}
   if(b.cursor!==undefined&&!uuid.test(b.cursor))throw Error('invalid_cursor');
   const result=await call(req,'work_history_page','v8.work.read',{project_id:ref.project_id,work_item_id:ref.id,kind:'updates',limit:b.limit??30,...(b.cursor?{cursor:b.cursor}:{})});
   return {...result,ref,authority:'v8.work_updates;original_stage_records',observed_at:new Date().toISOString()};
  }catch(e){const shared=infrastructureFailure(e);if(shared){const out=infrastructureResponse(shared,req.id);req.log?.warn({...out.diagnostic,request_id:req.id},'request failed');return reply.code(out.status).send(out.body);}const status=e.code==='22023'||e.message?.startsWith('invalid_')?400:e.status??503;return reply.code(status).send({state:'failed',error_code:status===403?'forbidden':status===400?domainErrorCode(e.message,'invalid_input'):'member_work_unavailable'});}
 });
}

