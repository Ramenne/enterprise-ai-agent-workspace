import {infrastructureFailure,infrastructureResponse} from '../../../packages/platform/src/failure-contract.mjs';
import {createHash} from 'node:crypto';
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[a-f0-9]{12}$/i;
export const memberBalanceContract={method:'POST',operation:'member_balance_read',fields:['member_id'],required:['member_id'],response:['member_id','balance_points','unit'],scope:'active EmployeeClient members in same organization; no account entries or financial writes'};
export function installEmployeeClientMemberBalance(app,pool){
 app.post('/v2/points/member-balance',{logLevel:'silent'},async(req,reply)=>{
  reply.header('cache-control','no-store');
  const token=typeof req.headers.authorization==='string'?req.headers.authorization.match(/^Bearer (.+)$/)?.[1]:null;
  if(!token||token.length>4096)return reply.code(401).send({state:'failed',error_code:'unauthenticated'});
  const b=req.body;if(!b||Array.isArray(b)||Object.keys(b).length!==1||!UUID.test(b.member_id||''))return reply.code(400).send({state:'failed',error_code:'invalid_member_balance_query'});
  try{const {rows}=await pool.query('SELECT v8.employeeclient_member_balance($1,$2::uuid) result',[createHash('sha256').update(token).digest('hex'),b.member_id]);const r=rows[0]?.result;
   if(r?.member_id!==b.member_id||typeof r.balance_points!=='number'||!Number.isFinite(r.balance_points))throw Error('invalid_balance_projection');
   return {member_id:r.member_id,balance_points:r.balance_points,unit:r.unit};
  }catch(e){const shared=infrastructureFailure(e);if(shared){const out=infrastructureResponse(shared,req.id,{legacyCode:shared.code==='forbidden'?'member_balance_forbidden':undefined});req.log?.warn({...out.diagnostic,request_id:req.id},'request failed');return reply.code(out.status).send(out.body);}return reply.code(503).send({state:'failed',error_code:'member_balance_unavailable'});}
 });
}
