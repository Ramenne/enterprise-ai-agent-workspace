import{sdkValidationIssues}from'./validation-issues.mjs';
// Exact historical names only. Existence in the current catalog is still
// checked by the gateway; aliasing never supplies identity or permission.
const legacyAliases=new Map([
 ['v8_project_create','v8.project.create'],['v8_project_read','v8.project.read'],['v8_project_search','v8.project.search'],
 ['v8_work_open','v8.work.open'],['v8_work_save','v8.work.save'],['v8_work_read','v8.work.read'],['v8_work_commit','v8.work.commit'],['v8_work_search','v8.work.search'],
 ['v8_context_prepare','v8.context.prepare'],['v8_context_materialize','v8.context.materialize'],['v8_adoption_set','v8.adoption.set'],['v8_adoption_read','v8.adoption.read']
]);
export const legacyAliasNames=Object.freeze([...legacyAliases.keys()]);
export const legacyToolName=name=>legacyAliases.get(name)||name;
export const isToolFailure=data=>Boolean(data&&typeof data==='object'&&['unknown_tool','failed','rejected_or_outcome_unknown','denied'].includes(data.state));
export function unknownTool(requested,suggestions=[]){return{state:'unknown_tool',error_code:'tool_not_found',requested_tool:requested,suggestions,next_step:'hub.tools',tool_help:{tool:'hub.help',arguments:{tool:legacyToolName(requested)}}};}
// Upstream MCP validation may return only a string. Normalize its shape without
// copying submitted values, tokens, or provider response bodies into an error.
export function normalizeToolResponse(response,requested){
 if(!response?.result||!Array.isArray(response.result.content))return response;
 let data=response.result.structuredContent;
 if(data===undefined){const content=response.result.content.find(x=>x.type==='text');if(content?.text){try{data=JSON.parse(content.text);}catch{if(response.result.isError&&content.text.startsWith('Input validation error:')){
  const issues=sdkValidationIssues(content.text),fields=issues.filter(x=>x.requirement.required).map(x=>x.path);
  data={state:'failed',error_code:'invalid_input',retryable:false,retained_state:'unchanged',...(fields.length?{missing_fields:[...new Set(fields)]}:{}),...(issues.length?{validation_errors:issues}:{}),next_step:issues.length?'correct_reported_fields_and_retry_same_input_and_key':'read_tool_help_and_correct_arguments'};
 }}}}
 if(data===undefined)return response;
 requested=data.requested_tool||requested;
 if(data.state==='unknown_tool'&&data.next_step==='hub.capabilities')data={...data,next_step:'hub.tools'};
 if((data.state==='failed'&&['invalid_input','invalid_invocation'].includes(data.error_code))||data.state==='unknown_tool')data={...data,requested_tool:requested,tool_help:{tool:'hub.help',arguments:{tool:legacyToolName(requested)}},...(data.next_step==='inspect_error'?{next_step:'read_tool_help_and_correct_arguments'}:{})};
 const isError=Boolean(response.result.isError||isToolFailure(data));
 if(!isError)return response;
 return{...response,result:{...response.result,content:[{type:'text',text:JSON.stringify(data)}],structuredContent:data,isError:true}};
}
