import {infrastructureFailure} from '../../../packages/platform/src/failure-contract.mjs';
import {createHash} from 'node:crypto';
export function installBaizeDirectory(app,{pool,bearer,sqlFunction,DomainError}){
 app.post('/v2/applications/baize/members',{logLevel:'silent'},async request=>{
  if(!request.body||typeof request.body!=='object'||Array.isArray(request.body)||Object.keys(request.body).length)throw new DomainError('invalid_input');
  const proof=createHash('sha256').update(bearer(request)).digest('hex');
  try{return await sqlFunction(pool,'authz.baize_visible_members',[proof]);}
  catch(error){
   const failure=infrastructureFailure(error);if(failure)throw error;
   if(error.code==='28000')throw new DomainError('unauthenticated',401);
   if(error.code?.startsWith('08')||['57P01','53300'].includes(error.code))throw new DomainError('current_member_directory_unavailable',503,true);
   throw error;
  }
 });
}
