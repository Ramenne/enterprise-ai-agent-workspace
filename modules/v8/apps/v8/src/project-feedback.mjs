import {infrastructureFailure,infrastructureResponse,domainErrorCode} from '../../../packages/platform/src/failure-contract.mjs';
import{createHash}from'node:crypto';
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const states=['submitted','in_progress','needs_information','resolved','not_planned'];
const routes={submit:['project_id','title','text','kind','visibility','evidence_links','source_channel','native_thread_id','idempotency_key'],query:['project_id','handling_state','kind','reporter_id','cursor','limit'],read:['project_id','feedback_id','after_seq','limit'],append:['project_id','feedback_id','text','handling_state','expected_revision','evidence_links','idempotency_key'],operation:['project_id','idempotency_key']};
export function validateFeedback(op,b){
 if(!b||typeof b!=='object'||Array.isArray(b)||!routes[op]||Object.keys(b).some(k=>!routes[op].includes(k)))throw Error('invalid_input');
 if(!uuid.test(b.project_id))throw Error('invalid_project_id');
 for(const k of ['feedback_id','reporter_id','cursor'])if(b[k]!==undefined&&!uuid.test(b[k]))throw Error('invalid_'+k);
 if(['read','append'].includes(op)&&!b.feedback_id)throw Error('feedback_id_required');
 if(['submit','append'].includes(op)&&(!(typeof b.text==='string')||!b.text.trim()||b.text.length>16000))throw Error('feedback_text_required');
 if(['submit','append','operation'].includes(op)&&(!(typeof b.idempotency_key==='string')||!b.idempotency_key||b.idempotency_key.length>200))throw Error('idempotency_key_required');
 if(b.title!==undefined&&(typeof b.title!=='string'||b.title.length>500))throw Error('invalid_title');
 if(b.kind!==undefined&&!['problem','suggestion'].includes(b.kind))throw Error('invalid_kind');
 if(b.visibility!==undefined&&!['project','reporter_and_handlers'].includes(b.visibility))throw Error('invalid_visibility');
 if(b.handling_state!==undefined&&!states.includes(b.handling_state))throw Error('invalid_handling_state');
 if(op==='append'&&b.handling_state!==undefined&&(!Number.isSafeInteger(b.expected_revision)||b.expected_revision<1))throw Error('expected_revision_required');
 if(b.expected_revision!==undefined&&(!Number.isSafeInteger(b.expected_revision)||b.expected_revision<1))throw Error('invalid_revision');
 if(b.after_seq!==undefined&&(!Number.isSafeInteger(b.after_seq)||b.after_seq<0))throw Error('invalid_after_seq');
 if(b.limit!==undefined&&(!Number.isInteger(b.limit)||b.limit<1||b.limit>100))throw Error('invalid_limit');
 if(b.evidence_links!==undefined&&(!Array.isArray(b.evidence_links)||b.evidence_links.length>100||JSON.stringify(b.evidence_links).length>32000))throw Error('invalid_evidence_links');
 if(b.source_channel!==undefined&&!['codex','product','api'].includes(b.source_channel))throw Error('invalid_source_channel');
 if(b.native_thread_id!==undefined&&(typeof b.native_thread_id!=='string'||b.native_thread_id.length>200))throw Error('invalid_native_thread_id');
 return b;
}
export const feedbackContract={version:'project-feedback-v1',identity:'current Hufu member credential;current project read plus member client write capability permits reporting;current project work commit permits handling;no new resource grants',minimum_submit:['project_id','text','idempotency_key'],project_discovery:'v8.project.search;reuse actual project_id',paths:Object.fromEntries(Object.entries(routes).map(([op,fields])=>[op,{method:'POST',path:op==='operation'?'/v2/project-feedback/operations/query':'/v2/project-feedback/'+op,fields}])),states,visibility:{project:'current authorized project readers',reporter_and_handlers:'reporter and current project handlers;project access still required'},workflow:'submit stores original directly;query lists metadata;read returns original and paged updates;append adds information or handler declared state;no mandatory work/task/acceptance template',history:'original text preserved;append correction rather than overwrite;effect retries preserve idempotency key',effects:'retention is not notification,acceptance,fix verification or automatic task creation',product_reference:'products may reference or optionally integrate this API;own in-app feedback and product code belong to product team;external anonymous intake not implemented'};
export function installProjectFeedback(app,pool){
 app.get('/v2/project-feedback/help',async()=>feedbackContract);
 for(const op of Object.keys(routes))app.post(op==='operation'?'/v2/project-feedback/operations/query':'/v2/project-feedback/'+op,{logLevel:'silent'},async(req,reply)=>{
  reply.header('cache-control','no-store');
  try{
   const token=req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];if(!token||token.length>4096)return reply.code(401).send({state:'failed',error_code:'unauthenticated'});
   const b=validateFeedback(op,req.body??{});const{rows}=await pool.query('SELECT v8.project_feedback_call($1,$2,$3::jsonb) result',[createHash('sha256').update(token).digest('hex'),op,JSON.stringify(b)]);return rows[0].result;
  }catch(e){const shared=infrastructureFailure(e);if(shared){const out=infrastructureResponse(shared,req.id);req.log?.warn({...out.diagnostic,request_id:req.id},'request failed');return reply.code(out.status).send(out.body);}const code=e.code==='40001'?'revision_conflict':e.code==='23505'?'idempotency_conflict':e.code==='23514'?'invalid_input':e.code==='22023'||e.message?.startsWith('invalid_')||e.message?.endsWith('_required')?domainErrorCode(e.message,'invalid_input'):'project_feedback_unavailable';const status=['40001','23505'].includes(e.code)?409:e.code==='23514'||e.code==='22023'||code!=='project_feedback_unavailable'?400:503;return reply.code(status).send({state:'failed',error_code:code});}
 });
}
