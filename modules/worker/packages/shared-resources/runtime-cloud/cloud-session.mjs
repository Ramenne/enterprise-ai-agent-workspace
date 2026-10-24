import {mkdir,open,rename,lstat,readdir,unlink} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {requireThat,Rejected} from './core.mjs';
import {privateJSON} from './bridges.mjs';
import {tencentRequest} from './tencent.mjs';

const fenceKeys=['actor_id','client_id','credential_id','security_era','principal_epoch','client_epoch','credential_epoch'];
/** Only managed references leave this process; STS secrets remain private. */
export class CloudSessions{
 constructor({root,issuerRef,client,invoke=tencentRequest}){this.root=root;this.issuerRef=issuerRef;this.client=client;this.invoke=invoke}
 async init(){await mkdir(this.root,{recursive:true,mode:0o700});const s=await lstat(this.root);requireThat(s.isDirectory()&&!s.isSymbolicLink()&&s.uid===process.geteuid()&&!(s.mode&0o077),'private_cloud_session_root_required');for(const name of await readdir(this.root)){if(!/^[0-9a-f-]{36}\.private\.json\.[0-9a-f-]{36}\.tmp$/.test(name))continue;const path=join(this.root,name),file=await lstat(path);requireThat(file.isFile()&&!file.isSymbolicLink()&&file.uid===process.geteuid()&&!(file.mode&0o077),'controlled_session_temporary_required');await unlink(path)}this.cursor=0;await this.sweep();this.timer=setInterval(()=>{if(!this.sweeping)this.sweeping=this.sweep().catch(()=>{this.cleanupPending=true}).finally(()=>{this.sweeping=null})},60000);this.timer.unref();return this}
 async close(){clearInterval(this.timer);await this.sweeping}
 /** Drop expired child material; retain only safe audit/reference metadata. */
 async sweep(){const files=(await readdir(this.root)).filter(x=>/^[0-9a-f-]{36}\.private\.json$/.test(x)).sort();if(this.cursor>=files.length)this.cursor=0;const batch=files.slice(this.cursor,this.cursor+200);for(const file of batch){const id=file.slice(0,-13),row=await privateJSON(this.path(id));if(row.secret&&Date.parse(row.deadline)<=Date.now()){row.state=row.state==='stopped'?'stopped':'expired';delete row.secret;await this.put(id,row)}}this.cursor+=batch.length;this.cleanupPending=false}
 path(id){requireThat(typeof id==='string'&&/^[0-9a-f-]{36}$/.test(id),'managed_session_id_required');return join(this.root,id+'.private.json')}
 async put(id,row){const path=this.path(id),tmp=path+'.'+randomUUID()+'.tmp';const f=await open(tmp,'wx',0o600);try{await f.writeFile(JSON.stringify(row));await f.sync()}finally{await f.close()}await rename(tmp,path);const d=await open(this.root,'r');try{await d.sync()}finally{await d.close()}}
 async row(id,t,identity){let row;try{row=await privateJSON(this.path(id))}catch(e){if(e.code==='ENOENT')throw new Rejected('managed_session_not_found',404);throw e}requireThat(row.target_id===t.id&&row.target_fingerprint===t.fingerprint,'cloud_session_target_mismatch');for(const k of fenceKeys)requireThat(row.identity[k]===identity[k],'cloud_session_identity_fence_mismatch');if(row.state==='active'&&Date.parse(row.deadline)<=Date.now()){row.state='expired';delete row.secret;await this.put(id,row)}return row}
 safe(row){return {session_id:row.id,credential_ref:'managed-cloud-session:'+row.id,state:row.state,expires_at:row.deadline,provider_expiry:row.provider_expiry,provider_request_id:row.provider_request_id,scope:row.scope,credentials_returned:false,upstream_revoke_supported:false}}
 policy(t){requireThat(t.kind==='dnspod'&&/^\d+$/.test(t.account_id)&&Number.isSafeInteger(t.domain_id),'registered_DNS_domain_required');const names=['DescribeDomain','DescribeRecordList','DescribeRecord',...(t.actions.includes('dnspod.record.modify')?['ModifyRecord']:[])];return {version:'2.0',statement:[{effect:'allow',action:names.map(a=>'name/dnspod:'+a),resource:['qcs::dnspod::uin/'+t.account_id+':domain/'+t.domain_id]}]}}
 async issue(t,c,duration=300,{persist=true}={}){
  const source=(await this.client.readKV(this.issuerRef)).data;requireThat(source.format==='cloud-owned-CAM-issuer.v2'&&source.provider_identity_verified===true&&source.enabled===true&&source.account_id===t.account_id&&source.domain_ids.includes(t.domain_id),'current_cloud_service_issuer_scope_required');
  requireThat(Number.isSafeInteger(duration)&&duration>=60&&duration<=900,'cloud_duration_scope_exceeded');
  let parent={secret_id:source.secret_id,secret_key:source.secret_key};requireThat(parent.secret_id&&parent.secret_key,'cloud_issuer_API_fields_required');
  const policy=this.policy(t);await c.check('effect');c.markEffectStarted?.();let child;
  try{child=await this.invoke('sts','GetFederationToken','ap-guangzhou',{Name:'hubcloud'+randomUUID().replaceAll('-','').slice(0,12),Policy:JSON.stringify(policy),DurationSeconds:duration},{secret_id:parent.secret_id,secret_key:parent.secret_key})}finally{parent=null;source.secret_id=undefined;source.secret_key=undefined}
  const credentials=child.Credentials;requireThat(credentials?.TmpSecretId&&credentials.TmpSecretKey&&credentials.Token&&Number.isSafeInteger(child.ExpiredTime),'provider_STS_response_invalid');
  const providerExpiry=new Date(child.ExpiredTime*1000).toISOString(),deadline=providerExpiry;
  const row={id:randomUUID(),state:'active',identity:Object.fromEntries(fenceKeys.map(k=>[k,c.identity[k]])),target_id:t.id,target_fingerprint:t.fingerprint,scope:{domain:t.domain,domain_id:t.domain_id,actions:t.actions.filter(a=>a.startsWith('dnspod.')),provider_scope:'domain; registered-record constraint enforced by managed executor'},deadline,provider_expiry:providerExpiry,provider_request_id:child.RequestId,secret:{secret_id:credentials.TmpSecretId,secret_key:credentials.TmpSecretKey,session_token:credentials.Token,account_id:t.account_id}};
  if(persist)await this.put(row.id,row);return row;
 }
 async assertActive(id,t,identity){if(!id)return;const row=await this.row(id,t,identity);requireThat(row.state==='active'&&Date.parse(row.deadline)>Date.now(),'cloud_session_stopped_or_expired')}
 async credentials(t,c){const row=c.sessionId?await this.row(c.sessionId,t,c.identity):await this.issue(t,c,120,{persist:false});requireThat(row.state==='active'&&Date.parse(row.deadline)>Date.now(),'cloud_session_stopped_or_expired');return row.secret}
 async stop(id,t,c){const row=await this.row(id,t,c.identity);row.state='stopped';delete row.secret;row.stopped_at=new Date().toISOString();await this.put(id,row);return {...this.safe(row),managed_use_stopped:true,provider_credentials_may_remain_valid_until:row.provider_expiry}}
}

export class CloudIssuerReferences{
 constructor(upstream,refs){this.upstream=upstream;this.refs=refs}
 async get(ref,ctx){if(!this.refs.has(ref))return this.upstream.get(ref,ctx);return {secret_ref:ref,target_fingerprint:ctx.target.fingerprint,current_scope_verified:true,deadline:new Date(Date.now()+30000).toISOString(),issuer_ref_only:true}}
 async release(secret){if(!secret.issuer_ref_only)await this.upstream.release(secret)}
}
