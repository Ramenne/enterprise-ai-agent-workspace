import {infrastructureFailure} from '../../platform/src/failure-contract.mjs';
import{readFile,writeFile,mkdir,rename,rm,chmod}from'node:fs/promises';
import{createHash}from'node:crypto';
const semver=/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const hash=text=>createHash('sha256').update(text).digest('hex');
const fail=(message,status=400)=>{throw Object.assign(Error(message),{status});};
export const compareVersions=(a,b)=>{const x=a.split('.').map(Number),y=b.split('.').map(Number);for(let n=0;n<3;n++)if(x[n]!==y[n])return x[n]>y[n]?1:-1;return 0;};
export function installSystemReleases(app,pool,root='/srv/workspace'){
 const load=async()=>JSON.parse(await readFile(root+'manifest.json','utf8'));
 const identity=async req=>{const token=req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];if(!token||token.length>4096)fail('unauthenticated',401);const proof=hash(token);const i=(await pool.query('SELECT authz.authenticate($1) identity',[proof])).rows[0].identity;return{i,proof};};
 const route=fn=>async(req,reply)=>{reply.header('cache-control','no-store');try{return await fn(req,await identity(req));}catch(e){const failure=infrastructureFailure(e);reply.code(e.status??failure?.status??503);return{state:'failed',error_code:e.status?e.message:failure?.code??'release_dependency_unavailable'};}};
 app.get('/v2/releases/help',route(async()=>({state:'documented',version:'/v2/releases/current',history:'/v2/releases',updates:'/v2/releases/updates',manual:{method:'POST',path:'/v2/manuals/read',body:{id:'handbook'}},publish:{method:'POST',path:'/v2/releases/publish',fields:['version','expected_current_version','summary','changes','documentation','idempotency_key'],authority:'organization_admin_with_management_credential;global_scope',documentation:'all_published_manual_fixed_versions_and_text;release-notes_required_each_release;unchanged_manuals_may_reuse'},runtime_gate:false})));
 app.get('/v2/releases/current',route(async()=>{const m=await load();return{state:m.system_release?'published':'unversioned',system_release:m.system_release??null,documentation_edition:m.version,manual_count:m.documents.length};}));
 app.get('/v2/releases',route(async()=>{const m=await load();return{state:'read',current_version:m.system_release?.version??null,items:m.release_history??[],historical_manuals:'/v2/manuals/read with id and version'};}));
 app.get('/v2/releases/updates',route(async(_req,{proof})=>{const m=await load();let deliveries=[],delivery_state='read';try{const r=(await pool.query('SELECT vault2.delivery_list($1) result',[proof])).rows[0].result;deliveries=(r.items??[]).map(x=>({event_id:'private-delivery:'+x.id,title:x.title,item_id:x.id,expires_at:x.expires_at,kind:'personal_resource_delivery',claim:{system:'hufu',method:'POST',path:'/v2/vault/deliveries/list'},download_state:'not_queried'}));}catch(e){if(infrastructureFailure(e)?.code!=='forbidden')throw e;delivery_state='outside_current_client_scope';}return{state:'read',system_release:m.system_release??null,personal_deliveries:deliveries,personal_delivery_state:delivery_state,visibility:'current_authenticated_member_only',notification_semantics:'available_in_context_or_page;not_proof_of_download_or_understanding',runtime_gate:false};}));
 app.get('/v2/releases/:version',route(async req=>{const v=req.params.version;if(!semver.test(v))fail('invalid_version');const m=await load();if(!(m.release_history??[]).some(x=>x.version===v))fail('release_not_found',404);const snapshot=JSON.parse(await readFile(root+'releases/'+v+'/manifest.json','utf8'));return{state:'read',system_release:snapshot.system_release,documentation:snapshot.documents.map(({id,title,fixed_ref})=>({id,title,fixed_ref})),historical_manual:{method:'POST',path:'/v2/manuals/read',body:{id:'handbook',version:v}}};}));
 let tail=Promise.resolve();
 app.post('/v2/releases/publish',route(async(req,{i})=>{
  if(i.organization_id!=='fa1d73b2-bf87-45c1-abef-b7739503819a'||i.member_role!=='organization_admin'||!(i.is_primary||i.client_actions?.includes('hufu.credential.manage'))||i.scope_filters?.length)fail('forbidden',403);
  const b=req.body;if(!b||Object.keys(b).some(k=>!['version','expected_current_version','summary','changes','documentation','idempotency_key','source_commit'].includes(k))||!semver.test(b.version??'')||typeof b.summary!=='string'||!b.summary.trim()||b.summary.length>2000||!Array.isArray(b.changes)||b.changes.length>100||b.changes.some(x=>typeof x!=='string'||x.length>2000)||typeof b.idempotency_key!=='string'||!b.idempotency_key||b.idempotency_key.length>160||!Array.isArray(b.documentation?.documents)||b.source_commit!==undefined&&!/^[a-f0-9]{40}$/.test(b.source_commit))fail('invalid_input');
  const operation=async()=>{
   const current=await load(),fingerprint=hash(JSON.stringify(b));
   if((current.release_history??[]).some(x=>x.version===b.version)){const published=JSON.parse(await readFile(root+'releases/'+b.version+'/manifest.json','utf8')).system_release;if(published.publisher_id===i.actor_id&&published.publication_key===b.idempotency_key&&published.publication_fingerprint===fingerprint)return{state:'already_published',system_release:published,current_version:current.system_release.version};fail('published_version_immutable',409);}
   if((current.system_release?.version??null)!==b.expected_current_version)fail('current_version_conflict',409);
   if(current.system_release&&compareVersions(b.version,current.system_release.version)<=0)fail('version_must_increase',409);
   const docs=b.documentation.documents;if(!docs.length||docs.length>100||new Set(docs.map(x=>x.id)).size!==docs.length||!docs.some(x=>x.id==='handbook')||!docs.some(x=>x.id==='release-policy')||!docs.some(x=>x.id==='release-notes'&&typeof x.text==='string'&&x.text.trim()&&(x.edition===b.version||x.text.includes('系统版本：'+b.version))))fail('matching_release_notes_required');
   for(const d of docs)if(!/^[a-z0-9-]+$/.test(d.id)||d.filename!==d.id+'.md'||typeof d.title!=='string'||typeof d.text!=='string'||Buffer.byteLength(d.text)>1024*1024||d.fixed_ref?.sha256!==hash(d.text)||!d.fixed_ref.material_id||!d.fixed_ref.version_id)fail('fixed_manual_snapshot_required');
   const lock=root+'.system-release-publish-lock';try{await mkdir(lock);}catch(e){if(e.code==='EEXIST')fail('publication_in_progress',409);throw e;}
   const versionRoot=root+'releases/'+b.version;let wrote=false;
   try{
    await mkdir(root+'releases',{recursive:true});await chmod(root+'releases',0o755);try{await mkdir(versionRoot);await chmod(versionRoot,0o755);}catch(e){if(e.code==='EEXIST')fail('release_snapshot_already_exists_resume_required',409);throw e;}
    const published_at=new Date().toISOString();const release={version:b.version,state:'published',published_at,summary:b.summary,changes:b.changes,publisher_id:i.actor_id,publisher:i.member_label,publication_key:b.idempotency_key,publication_fingerprint:fingerprint,documentation_edition:b.version,source_commit:b.source_commit??null,release_notes:{id:'release-notes',fixed_ref:docs.find(x=>x.id==='release-notes').fixed_ref},runtime_gate:false};
    const manifest={coverage:current.coverage??'current_published_system_manuals',...(current.reference_image?{reference_image:current.reference_image}:{}),role_policy:{manual_id:'service-boundary',fixed_ref:docs.find(d=>d.id==='service-boundary')?.fixed_ref},version:b.version,updated_at:published_at.slice(0,10),system_version:b.version,system_release:release,release_directory:'releases/'+b.version,release_history:[...(current.release_history??[]),{version:b.version,published_at,summary:b.summary}],documents:docs.map(({text,...d})=>({...d,applies_to_system_version:b.version,publication_state:'published_with_system_release'}))};
    for(const d of docs){await writeFile(versionRoot+'/'+d.filename,d.text,{flag:'wx',mode:0o644});await chmod(versionRoot+'/'+d.filename,0o644);}
    await writeFile(versionRoot+'/manifest.json',JSON.stringify(manifest,null,2)+'\n',{flag:'wx',mode:0o644});
    await chmod(versionRoot+'/manifest.json',0o644);
    await writeFile(root+'manifest.system-release.next.json',JSON.stringify(manifest,null,2)+'\n',{mode:0o644});
    await chmod(root+'manifest.system-release.next.json',0o644);
    await rename(root+'manifest.system-release.next.json',root+'manifest.json');wrote=true;
    return{state:'published',system_release:release,manual_count:docs.length,manual_snapshot_saved:true,history_immutable:true};
   }finally{await rm(lock,{recursive:true,force:true});if(!wrote){/* Preserve a failed snapshot for explicit same-operation recovery; never overwrite published history. */}}
  };
  const job=tail.then(operation);tail=job.catch(()=>{});return job;
 }));
}
