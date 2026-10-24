const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function observationBody(value){if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>k!=='project_id')||!uuid.test(value.project_id??''))throw Object.assign(Error('invalid_observation_input'),{status:400});return value;}
export const observationContract={method:'POST',path:'/v2/engineering/observations',fields:['project_id'],authority:'current_project_read;engineering_grant_not_required;explicit_credential_restrictions_apply',output:'registered_service_and_publication_observation_only;no_workspace_git_logs_commands_or_secrets'};
export function installEngineeringObservations(app,{sql,proof,safe,key,relay=fetch}){
 app.post(observationContract.path,{logLevel:'silent'},safe(async(req,reply)=>{
  const b=observationBody(req.body),caller=proof(req),identity=await sql('project_observation_permit',[caller,b.project_id]);
  const response=await relay('http://127.0.0.1:4619/execute',{method:'POST',headers:{'content-type':'application/json','x-hub-resource-key':key},body:JSON.stringify({request:{project_id:b.project_id,action:'observe',parameters:{}},identity}),signal:AbortSignal.timeout(12000)});
  const out=await response.json();
  // No stale authority or cached state can bypass a revocation during observation.
  await sql('project_observation_permit',[caller,b.project_id]);
  reply.code(response.status);return out;
 }));
}
