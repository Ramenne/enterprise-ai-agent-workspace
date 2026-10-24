import {changeInputSchemas as changeSchemas} from '../../../packages/platform/src/change-contracts.js';
import semanticBundle from './domain-contracts/semantic-input.json' with {type:'json'};
import {urlImportSchemas,urlImportRoutes} from '../../mem/src/url-import-contracts.js';
import memBundle from './domain-contracts/mem-input.json' with {type:'json'};
import {tools as domainTools} from './tools.js';
import v8Bundle from './domain-contracts/v8-core.json' with {type:'json'};
import {projectPrivacySchemas} from '../../hufu/src/project-privacy-contracts.js';
import { z } from 'zod';
import { canonical } from '../../../packages/platform/src/canonical.js';
import { DomainError } from '../../../packages/platform/src/http.js';

const uuid=z.uuid();
const json=z.unknown();
const source=z.object({provider:z.string().min(1).max(50),conversation_kind:z.string().min(1).max(50),
 capture_method:z.string().min(1).max(50),native_thread_id:z.string().max(200).optional(),native_session_id:z.string().max(200).optional(),
 native_turn_id:z.string().max(200).optional(),native_tool_call_id:z.string().max(200).optional(),invocation_id:z.string().max(200).optional(),
 hook_session_id:z.string().max(200).optional(),task_id:z.string().max(200).optional(),workspace_id:z.string().max(500).optional()}).strict();
// Domain publications own normalization. Legacy entries preserve their existing defaults and request fingerprints.
type PublishedContract={path:string;input_schema:unknown;origin?:Record<string,unknown>};
const publications:Array<{service:string;endpointKey?:string;bundle:{origin:Record<string,unknown>;contracts:PublishedContract[]}}>=[{service:'v8',bundle:v8Bundle},{service:'mem',bundle:memBundle},{service:'mem',endpointKey:'semantic',bundle:semanticBundle}];
// Alternative domain inputs share an SDK field presentation, not an execution validator.
function presentation(schema:z.ZodType):z.ZodObject<Record<string,z.ZodType>>{
 if(schema instanceof z.ZodObject)return schema as z.ZodObject<Record<string,z.ZodType>>;
 if(!(schema instanceof z.ZodUnion))throw Error('unsupported_domain_input_presentation');
 const branches=schema.options.map(branch=>presentation(branch as z.ZodType)),shape:Record<string,z.ZodType>={};
 for(const key of new Set(branches.flatMap(branch=>Object.keys(branch.shape)))){
  const variants=branches.flatMap(branch=>branch.shape[key]?[branch.shape[key]!]:[]);
  let field:z.ZodType=variants.length===1?variants[0]!:z.union(variants as [z.ZodType,z.ZodType,...z.ZodType[]]);
  if(variants.length<branches.length)field=field.optional();
  shape[key]=field;
 }
 return z.object(shape);
}
const domainSchemas=new Map<string,z.ZodObject<Record<string,z.ZodType>>>(),domainOrigins=new Map<string,Record<string,unknown>>();
for(const{service,endpointKey,bundle}of publications){
 const byPath=new Map(bundle.contracts.map(entry=>[entry.path,entry]));
 for(const route of domainTools.filter(route=>route.service===service&&(route.endpointKey??null)===(endpointKey??null)&&byPath.has(route.path))){
  if(domainSchemas.has(route.name))throw Error('duplicate_published_domain_route');
  const entry=byPath.get(route.path)!;
  domainSchemas.set(route.name,presentation(z.fromJSONSchema(entry.input_schema as Parameters<typeof z.fromJSONSchema>[0])));
  domainOrigins.set(route.name,entry.origin??bundle.origin);
 }
}
export const domainMinimumFor=(name:string)=>{const schema=domainSchemas.get(name);return schema?Object.entries(schema.shape).filter(([,field])=>!field.isOptional()).map(([key])=>key):undefined;};
export const domainOriginFor=(name:string)=>domainOrigins.get(name);
for(const [command,schema]of Object.entries(projectPrivacySchemas)){const name='hufu.project.privacy.'+command;domainSchemas.set(name,schema);domainOrigins.set(name,{owner:'hufu',project_id:'fbe863aa-824f-4688-a24d-bc3398754704',path:'apps/hufu/src/project-privacy-contracts.ts',projection:'direct-domain-import'});}
for(const [command,name]of Object.entries({begin:'mem.url.import',resume:'mem.url.resume',status:'mem.url.status'}) as Array<[keyof typeof urlImportSchemas,string]>){const route=domainTools.find(r=>r.name===name);if(route?.endpointKey!=='url_import'||route.path!==urlImportRoutes[command])throw Error('url_contract_route_mismatch');domainSchemas.set(name,urlImportSchemas[command]);domainOrigins.set(name,{owner:'url_import',project_id:'fbe863aa-824f-4688-a24d-bc3398754704',path:'apps/mem/src/url-import-contracts.ts',endpoint_key:'url_import',projection:'direct-domain-import'});}
for(const [key,name]of Object.entries({snapshot:'hub.changes.snapshot',poll:'hub.changes'}) as Array<[keyof typeof changeSchemas,string]>){domainSchemas.set(name,changeSchemas[key]);domainOrigins.set(name,{owner:'platform',project_id:'fbe863aa-824f-4688-a24d-bc3398754704',path:'packages/platform/src/change-contracts.ts',projection:'direct-domain-import'});}
const fields:Record<string,Record<string,z.ZodType>>={

 'provider.management.plan':{project_id:uuid,area_id:uuid.optional(),registration_id:uuid.optional(),action:z.enum(['issue','rotate','revoke','renew']),requested_scope:z.record(z.string(),json).optional(),consumer_ids:z.array(z.string()).optional(),idempotency_key:z.string().max(200),judgment:z.record(z.string(),json).optional()},
 'provider.management.status':{project_id:uuid,operation_id:uuid},
 'provider.management.advance':{project_id:uuid,operation_id:uuid,expected_revision:z.number().int().positive().optional(),step:z.string().optional()},
 'provider.management.reconcile':{project_id:uuid,operation_id:uuid},
 'provider.capabilities.enumerate':{project_id:uuid,area_id:uuid.nullable().optional(),limit:z.number().int().min(1).max(100).optional(),cursor:z.string().min(1).max(200).optional()},
 'provider.capabilities.read':{project_id:uuid,provider_id:z.string().min(1).max(200),area_id:uuid.nullable().optional()},
 'provider.capabilities.store':{project_id:uuid,provider_id:z.string().min(1).max(200),area_id:uuid.nullable().optional(),expected_revision:z.number().int().nonnegative(),facts:z.record(z.string(),json)},
 'resource.execute':{region_id:uuid,target_id:z.string().min(1),action:z.string().min(1),parameters:z.record(z.string(),json),operation:z.enum(['read','write','deploy']),project_id:uuid,area_id:uuid,environment:z.string(),path:z.string(),create_parents:z.boolean(),data_b64:z.string(),sha256:z.string().regex(/^[a-f0-9]{64}$/),expected_sha256:z.union([z.literal('absent'),z.string().regex(/^[a-f0-9]{64}$/)])},
 'hufu.credential.rotate':{credential_id:uuid},
};

// Remaining adapter descriptions retain their current behavior until their domain owners publish contracts.
const sha=z.string().regex(/^[a-f0-9]{64}$/);
const ref=z.object({material_id:uuid,version_id:uuid,sha256:sha}).strict();
Object.assign(fields,{
 'hufu.project.work_preset':{project_id:z.string(),actions:z.array(z.string()),resource_selector:json},
 'hufu.credential.create':{label:z.string(),actions:z.array(z.string()),expires_at:z.string().nullable(),until_revoked:z.union([z.boolean(),z.string()]),resource_selector:json,project_ids:z.array(z.string()),allowed_entries:z.array(z.string())},
 'hufu.credential.revoke':{credential_id:z.string()},
 'hufu.qualification.grant':{project_id:z.string(),principal_id:z.string(),actions:z.array(z.string()),parent_id:z.string(),resource_selector:json,expires_at:z.string().nullable(),until_revoked:z.union([z.boolean(),z.string()])},
 'hufu.management.delegate':{project_id:z.string(),principal_id:z.string(),actions:z.array(z.string()),parent_id:z.string(),resource_selector:json,expires_at:z.string().nullable(),until_revoked:z.union([z.boolean(),z.string()])},
 'hufu.qualification.revoke':{project_id:z.string(),qualification_id:z.string(),parent_id:z.string()},
});

/** Direct Agent fields are exposed. The old payload envelope remains compatible. */
export function inputFor(name:string){
 const direct:Record<string,z.ZodType>={},businessFields=domainSchemas.get(name)?.shape??fields[name]??{};
 for(const [key,type]of Object.entries(businessFields))direct[key]=type.optional();
 const semantic=name.startsWith('mem.legacy.')||name==='mem.semantic.query'||name==='mem.semantic.index_fixed'||name.startsWith('mem.url.')||name.startsWith('mem.description.');
 // Keep one SDK-inferable schema shape while rejecting unknown semantic keys
 // and validating the compatible payload envelope with the same business fields.
 const payload:z.ZodType<Record<string,unknown>>=semantic?z.object({...businessFields,idempotency_key:z.string().min(1).max(200).optional()}).strict():z.record(z.string(),json);
 return z.object({...direct,payload:payload.optional(),source_context:source.optional(),idempotency_key:z.string().min(1).max(200).optional()}).catchall(semantic?z.never():z.unknown());
}

export function businessInput(args:Record<string,unknown>):Record<string,unknown>{
 const copy={...args};delete copy['payload'];delete copy['source_context'];
 if(args['payload']&&typeof args['payload']==='object'&&!Array.isArray(args['payload'])){
  const wrapped=args['payload'] as Record<string,unknown>;
  for(const [key,value]of Object.entries(copy))if(key in wrapped&&canonical(wrapped[key])!==canonical(value))throw new DomainError('mixed_input_conflict',400);
  return {...wrapped,...copy};
 }
 return copy;
}
