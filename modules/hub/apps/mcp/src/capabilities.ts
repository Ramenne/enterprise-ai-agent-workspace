import {z} from 'zod';
import {tools} from './tools.js';
import {inputFor,domainMinimumFor,domainOriginFor} from './schemas.js';
import help from './capability-data.json' with {type:'json'};

export const capabilitySchema=z.object({domain:z.enum(['hufu','mem','v8']).optional(),intent:z.string().optional(),query:z.string().optional()}).strict();
export const helpSchema=z.object({tool:z.string().min(1)}).strict();
const intents:Record<string,string[]>=help.intents;
const minima:Record<string,string[]>=help.minimum_inputs;
export function capabilities(args:z.infer<typeof capabilitySchema>) {
 const selected=args.intent?new Set(intents[args.intent]??[]):undefined;
 const query=args.query?.toLocaleLowerCase();
 return {state:'catalog',coverage:'matching_implemented_routes',runtime_status:'domain_and_dependency_state_checked_on_call',
  authorization:'catalog_is_not_a_permission_grant',intents:Object.keys(intents),
  tools:tools.filter(t=>(!args.domain||t.service===args.domain)&&(!selected||selected.has(t.name))&&(!query||(t.name+' '+t.description).toLocaleLowerCase().includes(query)))
   .map(t=>({name:t.name,purpose:t.description,domain:t.service,minimum_inputs:domainMinimumFor(t.name)??minima[t.name]??null,details_tool:'hub.help'}))};
}
export function toolHelp(name:string) {
 const t=tools.find(tool=>tool.name===name);
 if(!t)return {state:'unknown_tool',error_code:'tool_not_found',next_step:'hub.capabilities'};
 return {state:'documented_route',name:t.name,purpose:t.description,http:{method:t.method,path:t.path,...(t.endpointKey?{endpoint_key:t.endpointKey}:{})},
  minimum_requirements:domainMinimumFor(t.name)??minima[t.name]??null,input_contract_origin:domainOriginFor(t.name),input_schema:z.toJSONSchema(inputFor(t.name)),
  schema_coverage:'MCP_transport_fields;domain_validation_on_call',
  authority:'uses_your_current_member_client_credential;never_body_actor',
  semantic_judgment:'Agent_may_record_uncertainty_and_enrich_later',
  resume:t.endpointKey==='url_import'?'query_or_resume_same_import_id_with_current_caller;retain_original_import_key':t.endpointKey==='semantic'?(t.readOnly?'retry_query_or_continue_with_mem_search':'read_or_save_Agent_description_then_retry_same_fixed_ref;description_revision_CAS;transport_key_is_metadata'):'use_original_operation_or_resume_id_after_an_ambiguous_response;retain_original_idempotency_key',
  runtime_status:'not_inferred_from_documentation'};
}
const destructive=new Set(['mem.gc.retry','mem.gc.destroy','hufu.credential.revoke','hufu.qualification.revoke','hufu.management.delegate','hufu.project.work_preset','mem.material.trash','mem.disclosure.revoke','mem.multipart.abort','v8.project.convert']);
export const destructiveHint=(name:string)=>destructive.has(name);
