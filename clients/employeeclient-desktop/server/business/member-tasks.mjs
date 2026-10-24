import {readMemberPoints} from './member-points.mjs';
const fail=(code,status=502)=>{throw Object.assign(Error(code),{code,status});};
// Member task summaries reuse the public board; financial account history never leaves this handler.
export function createMemberTasksHandler(sessionFactory){return async(req,res)=>{
 const url=new URL(req.url,'http://localhost'),match=/^\/business\/v1\/members\/([0-9a-f-]{36})\/(tasks|points)$/.exec(url.pathname);if(!match)return false;
 if(req.method!=='GET')fail('method_not_allowed',405);
 if([...url.searchParams.keys()].some(k=>k!=='cursor')||match[2]==='points'&&url.search)fail('member_query_invalid',400);
 const cookie=req.headers.cookie||'',session=await sessionFactory(cookie),target=match[1];
 const allowed=ctx=>ctx.can_read&&(ctx.member_roster||[]).some(m=>m.actor_id===target&&m.can_read===true);
 if(!allowed(session.context))fail('member_not_visible',404);
 let result;
 if(match[2]==='points'){
  // Existing central endpoint enforces whether this member's balance is visible.
  try{result=await readMemberPoints(session,target);}
  catch(e){if(e.status!==403)throw e;result={actor_id:target,balance_points:null,visibility:'not_authorized'};}
 }else{
  const cursor=url.searchParams.get('cursor');if(cursor?.length>8192)fail('member_query_invalid',400);
  const page=await session.rpc('board.tasks.read',{owner_id:target,limit:50,...(cursor?{cursor}:{})});if(!Array.isArray(page.items))fail('member_tasks_invalid');
  const items=page.items.map(t=>{if(t.owner?.member_id!==target)fail('member_task_identity_mismatch',403);return {id:t.id,title:t.title,execution_state:t.execution_state,description:t.description||'',claimed_at:t.owner.claimed_at,base_points_cents:Number.isSafeInteger(t.terms?.base_points_cents??t.settled_base_points_cents)&&(t.terms?.base_points_cents??t.settled_base_points_cents)>=0?(t.terms?.base_points_cents??t.settled_base_points_cents):null};});
  if(page.next_cursor!=null&&typeof page.next_cursor!=='string')fail('member_cursor_invalid');
  result={actor_id:target,items,next_cursor:page.next_cursor||null};
 }
 const fresh=await sessionFactory(cookie);if(fresh.context.actor_id!==session.context.actor_id||!allowed(fresh.context))fail('member_visibility_changed',403);
 res.writeHead(200,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(result));return true;
};}
