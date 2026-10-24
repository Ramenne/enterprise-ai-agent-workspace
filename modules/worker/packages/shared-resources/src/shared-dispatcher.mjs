import {createHash} from 'node:crypto';
import {SharedDNSReader} from './shared-dns-reader.mjs';
const reject=code=>{const e=new Error(code);e.code=code;e.status=403;throw e};
const need=(value,code)=>{if(!value)reject(code)};
const canonical=v=>JSON.stringify(v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,JSON.parse(canonical(v[k]))])):Array.isArray(v)?v.map(x=>JSON.parse(canonical(x))):v);
const digest=v=>createHash('sha256').update(canonical(v)).digest('hex');
export const usageExpiryCurrent=(value,now=Date.now())=>value==='infinity'||typeof value==='string'&&Number.isFinite(Date.parse(value))&&Date.parse(value)>now;
const under=(key,prefix)=>typeof key==='string'&&typeof prefix==='string'&&prefix.length>0&&prefix.endsWith('/')&&key.startsWith(prefix)&&!key.includes('..');

/** Additional scope is checked before credentials and at each current authority
 * phase. Only installed typed adapters are used. API metadata is not execution. */
export function enforceSharedScope(r,t,scope){
 need(scope&&typeof scope==='object'&&!Array.isArray(scope),'shared_scope_required');
 if(t.kind==='cos'){
  need(Object.keys(scope).every(k=>['prefix','max_bytes'].includes(k)),'unsupported_shared_scope');
  need(under(scope.prefix,t.prefix)&&under(r.parameters.key,scope.prefix),'shared_COS_prefix_denied');
  if(r.action==='cos.object.copy')need(under(r.parameters.source_key,scope.prefix),'shared_COS_copy_source_denied');
  if(r.action==='cos.object.put')need(Number.isSafeInteger(scope.max_bytes)&&scope.max_bytes>0&&scope.max_bytes<=t.max_bytes&&Buffer.from(r.parameters.data_b64??'','base64').length<=scope.max_bytes,'shared_COS_size_denied');
 }else if(t.kind==='dnspod'){
  need(Object.keys(scope).every(k=>['record_ids','allowed_values'].includes(k))&&Array.isArray(scope.record_ids)&&scope.record_ids.length>0,'shared_DNS_record_scope_required');
  need(!['dnspod.domain.describe','cloud.session.issue','cloud.session.status','cloud.session.stop'].includes(r.action),'shared_DNS_zone_or_session_action_unsupported');
  if(r.action==='dnspod.records.describe'){
   need(scope.record_ids.length<=100&&scope.record_ids.every(id=>Number.isSafeInteger(id)&&t.records?.some(x=>x.record_id===id)),'shared_DNS_record_denied');
   need(Object.keys(r.parameters).length===0,'shared_DNS_read_parameters_invalid');return;
  }
  need(r.action==='dnspod.record.modify'&&scope.record_ids.includes(r.parameters.record_id)&&t.records?.some(x=>x.record_id===r.parameters.record_id),'shared_DNS_record_denied');
  if(Object.hasOwn(scope,'allowed_values'))need(Array.isArray(scope.allowed_values)&&scope.allowed_values.includes(r.parameters.value),'shared_DNS_value_denied');
 }else if(t.kind==='lighthouse'||t.kind==='cvm'){
  need(Object.keys(scope).every(k=>k==='instance_id')&&scope.instance_id===t.instance_id,'shared_instance_denied');
 }else{
  // Existing forced SSH/PG adapters already enforce an exact installed target;
  // do not invent arbitrary path/schema subsets they cannot enforce.
  need(Object.keys(scope).length===1&&scope.exact_target===t.id,'shared_exact_target_required');
 }
}

/** Use the *actual installed* Dispatcher class, adapters, credentials and durable
 * receipts. `loadUsage` resolves server-installed mapping, not caller metadata.
 * `checkUsage` calls authz.shared_resource_check under the real member bearer.
 */
export class SharedDispatcher{
 constructor({Dispatcher,regions,adapters,credentials,receipts,loadUsage,checkUsage}){Object.assign(this,{Dispatcher,regions,adapters,credentials,receipts,loadUsage,checkUsage})}
 async execute(bearer,raw){
  need(raw&&typeof raw==='object'&&!Array.isArray(raw)&&typeof raw.usage_id==='string','usage_required');
  const {usage_id,...r}=raw,u=await this.loadUsage(usage_id);
  need(u?.active===true&&usageExpiryCurrent(u.expires_at)&&u.project_id===r.project_id&&u.area_id===r.area_id&&u.target_id===r.target_id&&u.actions.includes(r.action),'shared_mapping_denied');
  const region=this.regions.find(x=>x.id===r.region_id),target=region?.targets.find(x=>x.id===r.target_id);
  need(region?.enabled&&target?.enabled,'target_not_installed');
  const scopeHash=digest(u.scope),installed=this.adapters[target.kind];need(installed,'adapter_not_installed');
  const adapter=target.kind==='dnspod'?new SharedDNSReader(installed,u.scope):installed;
  enforceSharedScope(r,target,u.scope);
  const view={...target,project_id:u.project_id,area_id:u.area_id};
  const authority=async(token,b)=>{
   const p=await this.checkUsage(token,{usage_id,project_id:b.project_id,area_id:b.area_id,region_id:b.region_id,target_id:b.target_id,operation:b.operation,action:b.action,request_hash:b.request_hash,phase:b.phase});
   need(p.usage_id===usage_id&&p.usage_epoch===u.epoch&&digest(p.scope)===scopeHash,'shared_usage_revoked_or_changed');
   enforceSharedScope(r,target,p.scope);return p;
  };
  const scopedReceipts={};
  if(this.receipts.get)scopedReceipts.get=key=>this.receipts.get(digest([usage_id,key]));
  for(const method of ['put','begin','retry'])if(this.receipts[method])scopedReceipts[method]=(key,row)=>this.receipts[method](digest([usage_id,key]),{...row,shared_usage_id:usage_id,shared_usage_epoch:u.epoch,shared_scope_hash:scopeHash});
  const dispatcher=new this.Dispatcher({regions:[{...region,targets:[view]}],adapters:{[target.kind]:{validate:(req)=>{enforceSharedScope(req,target,u.scope);adapter.validate(req,target)},execute:(req,_view,c)=>adapter.execute(req,target,c)}},authority,credentials:this.credentials,receipts:scopedReceipts});
  const result=await dispatcher.execute(bearer,r);
  return {...result,usage_id,usage_epoch:result.shared_usage_epoch??u.epoch,current_usage_epoch:u.epoch,management_project_id:target.project_id};
 }
}
