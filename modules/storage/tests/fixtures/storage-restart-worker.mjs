// Synthetic filesystem-backed SQL/COS peers. Production provider, journal and use case run unchanged.
// No network, real database, or real cloud credential is used by this worker.
import{readFile,open,rename}from'node:fs/promises';import{join}from'node:path';import{createHash}from'node:crypto';import{z}from'zod';
import{CosTierProvider}from'../../source/packages/storage-tiers/src/cos-tier-provider.mjs';import{createPrivateJournal}from'../../source/packages/storage-tiers/src/private-journal.mjs';import{createStorageTierOperations}from'../../source/packages/storage-tiers/src/storage-tier-flow.mjs';import{DomainError}from'../../source/packages/platform/src/http.js';
const[dir,mode]=process.argv.slice(2),file=join(dir,'fixture.json');let state=JSON.parse(await readFile(file,'utf8'));
async function persist(){const tmp=file+'.next',f=await open(tmp,'w',0o600);try{await f.writeFile(JSON.stringify(state));await f.sync();}finally{await f.close();}await rename(tmp,file);const d=await open(dir,'r');try{await d.sync();}finally{await d.close();}}
function object(key,version){const versions=state.objects[key]??[];return version?versions.find(x=>x.version===version):versions.at(-1);}
class SyntheticCOS{
 constructor(){/* synthetic bag is never stored */}
 headObject(p,cb){void(async()=>{state.counts.head++;await persist();const o=object(p.Key,p.VersionId);if(!o)throw Object.assign(Error('synthetic missing object'),{statusCode:404});return{VersionId:o.version,headers:{'content-length':String(Buffer.from(o.bytes,'base64').length),'x-cos-storage-class':o.storage,...(o.restore==='restoring'?{'x-cos-restore':'ongoing-request="true"'}:o.restore==='restored'?{'x-cos-restore':'ongoing-request="false", expiry-date="'+new Date(Date.now()+600000).toUTCString()+'"'}:{})}};})().then(x=>cb(null,x),cb);}
 putObjectCopy(p,cb){void(async()=>{state.counts.copy++;const u=new URL('https://'+p.CopySource),o=object(decodeURIComponent(u.pathname.slice(1)),u.searchParams.get('versionId'));if(!o)throw Error('synthetic source identity missing');if(state.config.copyTimeout!=='before_effect'){const target={version:'synthetic-copy-v'+state.counts.copy,bytes:o.bytes,storage:p.StorageClass};state.objects[p.Key]=[...(state.objects[p.Key]??[]),target];}await persist();if(state.config.copyTimeout)throw Object.assign(Error('synthetic timeout'),{code:'ETIMEDOUT'});return{VersionId:object(p.Key).version,headers:{'x-cos-request-id':'synthetic-copy-request'}};})().then(x=>cb(null,x),cb);}
 restoreObject(p,cb){void(async()=>{state.counts.restore++;const o=object(p.Key,p.VersionId);if(!o)throw Error('synthetic restore source missing');o.restore='restoring';await persist();return{headers:{'x-cos-request-id':'synthetic-restore-request'}};})().then(x=>cb(null,x),cb);}
 getObject(p,cb){void(async()=>{state.counts.read++;const o=object(p.Key,p.VersionId);if(!o)throw Error('synthetic read source missing');await persist();p.Output.end(Buffer.from(o.bytes,'base64'));return{VersionId:o.version,headers:{'x-cos-request-id':'synthetic-read-request'}};})().then(x=>cb(null,x),cb);}
}
const realJournal=await createPrivateJournal(join(dir,'journal'),process.getuid());
const journal=async(id,event)=>{await realJournal(id,event);if(mode==='crash_after_copy_response'&&event.phase==='copy_response')process.kill(process.pid,'SIGKILL');};
const provider=new CosTierProvider({COS:SyntheticCOS,journal,scopeProvider:async()=>({scope_verified:true,provider:'cos',bucket:'synthetic-bucket',region:'synthetic-region',archive_prefix:state.config.archivePrefix??'archive/',source_prefixes:['final/'],valid_until:new Date(Date.now()+3600000).toISOString(),actions:['head','copy','restore','read'],access_key_id:'SYNTHETIC_UNUSED_ID',secret_access_key:'SYNTHETIC_UNUSED_SECRET',session_token:'SYNTHETIC_UNUSED_TOKEN'})});
const digest=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const call=async(token,source,name,action,b)=>{
 if(state.config.revoked)throw new DomainError('unauthenticated',401);
 if(name==='storage_tier_info')return{state:'storage_info',primary_tier:state.kind==='restore'?'archive':'standard',hot_deleted:false};
 if(name==='read_version')return{read_receipt_id:state.ids.receipt};
 if(name==='gc_read_lease'){state.counts[b.command==='renew'?'leaseRenew':'leaseRelease']++;await persist();return{state:'ok'};}
 if(name!=='storage_tier_command')throw Error('unexpected synthetic SQL function:'+name);
 if(b.phase==='prepare'){
  const keys=['project_id','material_id','version_id','idempotency_key','tier','days','retrieval'];const intent=Object.fromEntries(keys.filter(k=>b[k]!==undefined).map(k=>[k,b[k]]));
  if(state.intent&&digest(state.intent)!==digest(intent))throw new DomainError('idempotency_conflict',409);
  if(!state.intent){state.intent=intent;state.ticket={...state.ticket,original_request_hash:digest(intent)};await persist();}
 }
 if(b.phase==='dispatch'){state.ticket.state='dispatched';state.ticket.target_key=b.target_key;state.counts.dispatch++;await persist();}
 if(b.phase==='report'){
  if(state.config.failReports){state.counts.reportFailures++;await persist();throw new DomainError('dependency_busy',503,true);}
  state.ticket.state=b.outcome;state.ticket.receipt=b.receipt;state.counts.reportSuccess++;await persist();
 }
 return structuredClone(state.ticket);
};
const run=createStorageTierOperations({z,call,digest,DomainError,provider}),authority={token:'SYNTHETIC_MEMBER',source:{provider:'synthetic-restart-test'}};
let route=state.kind==='restore'?'restore':'archive',input={...state.ref,idempotency_key:'synthetic-original-key',...(state.kind==='restore'?{days:1,retrieval:'Standard'}:{tier:'archive'})};
if(mode==='status'){route='status';input={...state.ref,operation_id:state.ids.operation,command:state.kind==='restore'?'restore':'archive_copy'};}
if(mode==='conflicting_intent')input.tier='deep_archive';
try{const result=await run(route,authority,input);process.stdout.write(JSON.stringify(result));}catch(e){process.stdout.write(JSON.stringify({error_code:e.code??'unclassified',status:e.status??500}));process.exitCode=2;}
