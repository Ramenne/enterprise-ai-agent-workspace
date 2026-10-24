import test from'node:test';import assert from'node:assert/strict';import{mkdtemp,copyFile,writeFile,rm}from'node:fs/promises';import{tmpdir}from'node:os';import{join}from'node:path';import{pathToFileURL}from'node:url';
test('current project view preserves permission failures and granted takeover separately from readonly',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'workspace-status-'));try{
 await copyFile(new URL('./service-registry.mjs',import.meta.url),join(dir,'service-registry.mjs'));await writeFile(join(dir,'legacy-service-registry.json'),JSON.stringify({mode:'old',updated_at:'old',services:[{project_id:'a',service_id:'synthetic',title:'old',state:'paused',domains:[]}]}));
 const {serviceRegistry}=await import(pathToFileURL(join(dir,'service-registry.mjs')));const memberV8=async(path,b)=>path.endsWith('/search')?{items:[{project_id:'a',title:'project'}],next_cursor:null}:{project:{id:'a',title:'project'},recent_work:[{actor_id:'worker'}],activity_coverage:'actual_mock'};
 const memberHufu=async path=>path.includes('overview')?{projects:[{members:[{actor_id:'worker',member:'worker',qualifications:[{kind:'work',effective_now:true,actions:['resource.deploy']}]},{actor_id:'reader',member:'reader',qualifications:[{kind:'work',effective_now:true,actions:['mem.read']}]}],member_count:2}]}:{service_state:'active',deployed_release:{release_id:'op'},running_service:{state:'active'}};
 const r=await serviceRegistry({},memberV8,memberHufu);assert.equal(r.items[0].state,'active');assert.equal(r.items[0].legacy_assets[0].declared_state,'paused');assert.equal(r.items[0].responsibility.authorized_takeover.length,1);
 const unknown=await serviceRegistry({},memberV8,async()=>{throw Error('permission_unavailable')});assert.equal(unknown.items[0].running_service.state,'unknown');assert.equal(unknown.items[0].responsibility.coverage,'unavailable;do_not_infer_no_owner');
 }finally{await rm(dir,{recursive:true,force:true});}
});
