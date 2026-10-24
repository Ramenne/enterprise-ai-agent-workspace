const requireThat=(value,code)=>{if(!value){const e=new Error(code);e.code=code;e.status=403;throw e}};
/** Registered record IDs stay authoritative. Uses the original installed
 * sessions and signed Tencent adapter; no parent credential leaves the holder. */
export class SharedDNSReader{
 constructor(installedAdapter,scope){this.installed=installedAdapter;this.scope=scope}
 validate(r,t){
  if(r.action==='dnspod.record.modify'&&t.records?.some(x=>x.record_id===r.parameters.record_id&&x.type==='MX')){
   requireThat(r.operation==='write'&&Object.keys(r.parameters).every(k=>['record_id','value','expected_value','session_id'].includes(k)),'shared_DNS_MX_parameters_invalid');
   requireThat(typeof r.parameters.value==='string'&&r.parameters.value.length>0&&r.parameters.value.length<=4096&&typeof r.parameters.expected_value==='string','registered_record_and_observation_required');
   const record=t.records.find(x=>x.record_id===r.parameters.record_id);if(record.allowed_values)requireThat(record.allowed_values.includes(r.parameters.value),'registered_record_value_scope_denied');return;
  }
  if(r.action!=='dnspod.records.describe')return this.installed.validate(r,t);
  requireThat(r.operation==='read'&&Object.keys(r.parameters).length===0,'shared_DNS_read_parameters_invalid');
  requireThat(Array.isArray(this.scope.record_ids)&&this.scope.record_ids.length>0&&this.scope.record_ids.length<=100,'shared_DNS_record_scope_required');
  for(const id of this.scope.record_ids)requireThat(Number.isSafeInteger(id)&&t.records?.some(x=>x.record_id===id),'shared_DNS_record_not_registered');
 }
 async execute(r,t,c){
  const mx=r.action==='dnspod.record.modify'&&t.records?.find(x=>x.record_id===r.parameters.record_id&&x.type==='MX');
  if(mx)return this.modifyMX(r,t,c,mx);
  if(r.action!=='dnspod.records.describe')return this.installed.execute(r,t,c);
  this.validate(r,t);const credentials=await this.installed.sessions.credentials(t,{...c,sessionId:undefined});
  const records=[];const requestIds=[];
  for(const id of [...new Set(this.scope.record_ids)]){
   await c.check('effect');const registered=t.records.find(x=>x.record_id===id);
   c.markEffectStarted?.();const observed=await this.installed.invoke('dnspod','DescribeRecord',null,{Domain:t.domain,DomainId:t.domain_id,RecordId:id},credentials);
   const live=observed.RecordInfo;requireThat(live&&(live.Id??live.RecordId)===id&&live.SubDomain===registered.name&&live.RecordType===registered.type,'shared_DNS_registered_host_changed');
   records.push({record_id:id,name:live.SubDomain,type:live.RecordType,value:live.Value,ttl:live.TTL,status:live.Enabled===1?'ENABLE':'DISABLE',line:live.RecordLine,...(live.RecordType==='MX'?{mx_priority:live.MX}:{})});
   if(typeof observed.RequestId==='string')requestIds.push(observed.RequestId);
  }
  await c.check('final');return {state:'read',result:{records,returned_count:records.length,coverage:'registered_records_only',provider_request_ids:requestIds,credentials_returned:false}};
 }
 async modifyMX(r,t,c,registered){
  this.validate(r,t);const credentials=await this.installed.sessions.credentials(t,{...c,sessionId:r.parameters.session_id});const check=async()=>{await c.check('effect');await this.installed.sessions.assertActive(r.parameters.session_id,t,c.identity)};
  await check();const observed=await this.installed.invoke('dnspod','DescribeRecord',null,{Domain:t.domain,DomainId:t.domain_id,RecordId:registered.record_id},credentials);const live=observed.RecordInfo;
  requireThat(live&&(live.Id??live.RecordId)===registered.record_id&&live.SubDomain===registered.name&&live.RecordType==='MX'&&live.Value===r.parameters.expected_value,'DNS_registered_record_or_observed_value_changed');
  requireThat(Number.isSafeInteger(live.MX)&&live.MX>=0&&live.MX<=65535,'observed_MX_priority_required');
  await check();c.markEffectStarted?.();const result=await this.installed.invoke('dnspod','ModifyRecord',null,{Domain:t.domain,DomainId:t.domain_id,RecordId:registered.record_id,SubDomain:registered.name,RecordType:'MX',RecordLine:live.RecordLine,RecordLineId:live.RecordLineId,Value:r.parameters.value,MX:live.MX,TTL:live.TTL,Status:live.Enabled===1?'ENABLE':'DISABLE'},credentials);
  await c.check('final');return {state:'provider_accepted',effect_id:result.RequestId,result:{provider_request_id:result.RequestId,record_id:registered.record_id,value:r.parameters.value,mx_priority:live.MX,completion:'requires_followup_read',atomic_compare_and_swap_supported:false,credentials_returned:false}};
 }
}
