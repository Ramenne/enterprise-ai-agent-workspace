const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const keys=new Set(['label','actions','expires_at','until_revoked','resource_selector','allowed_entries','qualification_ids','project_ids']);
const restrictionKey=key=>{const name=key.replace(/([a-z])([A-Z])/g,'$1_$2').toLowerCase();return /scope|filter|selector/.test(name)||/^(?:projects|resources|permissions|project_id|resource_id|principal_id|actor_id|owner_id|tenant_id|organization_id|organisation_id|allowed_projects|allowed_resources|denied_projects|denied_resources)$/.test(name);};
export class CredentialCreateInputError extends Error{constructor(code,issues){super(code);this.code=code;this.validation_errors=issues;}}
const fail=(code,path,requirement)=>{throw new CredentialCreateInputError(code,[{path,requirement}]);};
function projects(value,path){if(!Array.isArray(value)||value.length<1||value.length>200)fail('invalid_credential_scope',path,{type:'array',minItems:1,maxItems:200});for(let i=0;i<value.length;i++)if(typeof value[i]!=='string'||!uuid.test(value[i]))fail('invalid_credential_scope',path+'['+i+']',{format:'uuid'});return [...new Set(value.map(x=>x.toLowerCase()))].sort();}
export function normalizeCredentialCreate(body){
 if(Object.keys(body).some(k=>!keys.has(k)&&restrictionKey(k)))fail('unsupported_credential_scope','$',{supported_restriction_fields:['resource_selector','project_ids','allowed_entries'],unknown_restrictions:'must_not_be_ignored'});
 const alias=Object.hasOwn(body,'project_ids');let ids;
 if(alias)ids=projects(body.project_ids,'project_ids');
 if(Object.hasOwn(body,'resource_selector')){
  const s=body.resource_selector;
  if(!s||typeof s!=='object'||Array.isArray(s)||Object.keys(s).some(k=>!['version','kind','project_ids'].includes(k))||![1,'1'].includes(s.version)||s.kind!=='projects')fail('invalid_credential_scope','resource_selector',{type:'object',version:1,kind:'projects',allowed_fields:['version','kind','project_ids']});
  const canonical=projects(s.project_ids,'resource_selector.project_ids');
  if(alias&&JSON.stringify(ids)!==JSON.stringify(canonical))fail('conflicting_credential_scope','project_ids',{must_match:'resource_selector.project_ids',comparison:'same_UUID_set;no_implicit_union_or_override'});
  return body; // Correct canonical format and its byte/digest semantics remain unchanged.
 }
 if(!alias)return body;
 const {project_ids,...rest}=body;
 return {...rest,resource_selector:{version:1,kind:'projects',project_ids:[...project_ids]}};
}
export function requestedProjectIds(body){return Object.hasOwn(body,'project_ids')?projects(body.project_ids,'project_ids'):body.resource_selector?projects(body.resource_selector.project_ids,'resource_selector.project_ids'):null;}
export function confirmsCurrentProjectScope(result,ids){
 if(ids===null)return true;
 const clauses=result.current_effective_scope_filters;
 return Array.isArray(clauses)&&clauses.some(c=>Array.isArray(c?.project_ids)&&c.project_ids.length>0&&c.project_ids.every(x=>typeof x==='string'&&ids.includes(x.toLowerCase())));
}
