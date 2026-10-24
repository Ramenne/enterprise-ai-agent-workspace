import {infrastructureFailure,domainErrorCode} from '../../platform/src/failure-contract.mjs';
import {createHash} from 'node:crypto';
export function installProjectMembers(app,{pool}){
 app.post('/v2/projects/members',{logLevel:'silent'},async(req,reply)=>{
  reply.header('cache-control','no-store');
  try{
   const token=req.headers.authorization?.match(/^Bearer (.+)$/)?.[1],b=req.body;
   if(!token||token.length>4096)return reply.code(401).send({state:'failed',error_code:'current_caller_required'});
   if(!b||Array.isArray(b)||typeof b!=='object'||Object.keys(b).some(k=>!['project_id','limit','offset'].includes(k))||typeof b.project_id!=='string')return reply.code(400).send({state:'failed',error_code:'invalid_input'});
   return(await pool.query('SELECT authz.project_members($1,$2) result',[createHash('sha256').update(token).digest('hex'),b])).rows[0].result;
  }catch(e){const failure=infrastructureFailure(e,{permissionCode:e.message});return reply.code(failure?.status??(e.code?.startsWith('22')?400:503)).send({state:'failed',error_code:failure?.code??(e.code==='22023'?domainErrorCode(e.message,'member_directory_unavailable'):'member_directory_unavailable')});}
 });
}
