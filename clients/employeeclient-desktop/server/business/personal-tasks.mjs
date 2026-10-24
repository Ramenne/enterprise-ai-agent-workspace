import {readMemberPoints} from './member-points.mjs';
const fail=(code,status=502)=>{throw Object.assign(Error(code),{code,status});};
const text=v=>typeof v==='string'?v:'';
// Read-only projection of the existing board. No EmployeeClient wallet/task ledger.
export function createPersonalTasksHandler(sessionFactory){
 const handle=async(req,res)=>{
  const url=new URL(req.url,'http://localhost'),kind=url.pathname;
  if(!['/business/v1/me/points','/business/v1/me/tasks'].includes(kind))return false;
  if(req.method!=='GET')fail('method_not_allowed',405);
  for(const key of url.searchParams.keys())if(key!=='cursor'||kind.endsWith('/points'))fail('personal_query_invalid',400);
  const cursor=url.searchParams.get('cursor');if(cursor?.length>8192)fail('personal_query_invalid',400);
  const cookie=req.headers.cookie||'',session=await sessionFactory(cookie),actor=session.context.actor_id;
  if(!actor||!session.context.can_read)fail('project_read_denied',403);
  let result;
  if(kind.endsWith('/points')){
   result=await readMemberPoints(session,actor);
  }else{
   // owner_id is derived from the authenticated member, never from UI input.
   const page=await session.rpc('board.tasks.read',{owner_id:actor,limit:50,...(cursor?{cursor}:{})});
   if(!Array.isArray(page.items))fail('tasks_response_invalid');
   const items=page.items.map(task=>{
    if(task.owner?.member_id!==actor||task.my_claim?.member_id!==actor)fail('personal_task_mismatch',403);
    return {id:text(task.id),title:text(task.title),project_name:text(task.project_name),description:text(task.description),direction:text(task.direction),
     execution_state:text(task.execution_state)||'unknown',personal_state:text(task.my_claim.declared_state||task.owner.declared_state)||'claimed',
     claimed_at:text(task.my_claim.claimed_at),terms:{base_points_cents:task.my_claim.terms?.base_points_cents??task.settled_base_points_cents??null,cash_cents:task.my_claim.terms?.cash_cents??null},work_item_id:task.work_item_id||null,project_id:task.project_id||null};
   });
   if(page.next_cursor!=null&&typeof page.next_cursor!=='string')fail('tasks_cursor_invalid');
   result={actor_id:actor,items,next_cursor:page.next_cursor||null};
  }
  // Revalidate before returning private financial data after any upstream wait.
  const current=await sessionFactory(cookie);
  if(current.context.actor_id!==actor||!current.context.can_read)fail('personal_session_changed',403);
  res.writeHead(200,{'content-type':'application/json;charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(result));return true;
 };
 return async(req,res)=>{
  try{return await handle(req,res);}catch(error){
   const retryable=(error instanceof TypeError&&error.message==='fetch failed')||error.name==='TimeoutError'||(error.code==='authority_request_rejected'&&error.status>=500);
   if(!retryable||res.headersSent||res.destroyed)throw error;
   console.warn(JSON.stringify({event:'personal_board_read_retry',path:new URL(req.url,'http://localhost').pathname,status:error.status||503,transport_code:error.cause?.code||null,error_name:error.name}));
   // Only these own-account GET reads are recoverable. Re-run full live authority
   // once; never retry writes, denied access, invalid data or disconnected clients.
   return handle(req,res);
  }
 };
}
