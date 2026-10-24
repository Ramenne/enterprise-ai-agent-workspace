/** Domain bodies remain unchanged; HTTP and in-process callers share one outcome. */
export async function operationOutcome(run){
 let status=200;
 const body=await run((code,value)=>{status=code;return value;});
 return {status,body};
}
export function createStorageCommands({tiers,warm,retirement,errorResponse,log}){
 return async(name,authority,input)=>{
  try{
   if(['archive','restore','status'].includes(name))return await tiers(name,authority,input);
   if(name==='warm')return {status:200,body:await warm(authority,input)};
   if(['info','switch','retirement-status','resume-retirement'].includes(name))return {status:200,body:await retirement(name,authority,input)};
   throw Object.assign(Error('unknown_storage_command'),{code:'invalid_input',status:400});
  }catch(error){const result=errorResponse(error,authority.request_id);log?.warn({...result.diagnostic,request_id:result.body.request_id},'storage command failed');return result;}
 };
}
