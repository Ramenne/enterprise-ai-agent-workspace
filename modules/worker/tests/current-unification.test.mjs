import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,mkdir,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {selectedManuals} from '../packages/handbook/src/selected-manuals.mjs';
import {catalogue} from '../packages/mcp-edge/source/disclosure.mjs';
import {serviceRegistry} from '../packages/mcp-edge/source/service-registry.mjs';
import {withServiceProviderBoundary} from '../packages/mcp-edge/source/service-boundary.mjs';
import {currentContextRules} from '../packages/mcp-edge/source/current-read758/current-context-rules.mjs';
test('one publication pointer reads current and explicit historical versions',async()=>{
 const root=await mkdtemp(tmpdir()+'/hub-manual-');try{
 const text='current',old='historical',hash=s=>createHash('sha256').update(s).digest('hex');
 for(const [v,s]of [['2.7.0',text],['2.6.2',old]]){await mkdir(root+'/releases/'+v,{recursive:true});await writeFile(root+'/releases/'+v+'/handbook.md',s);}
 const m={release_directory:'releases/2.7.0'};await writeFile(root+'/manifest.json',JSON.stringify(m));
 const r=selectedManuals(root+'/');assert.deepEqual(await r.manifest(),m);
 assert.equal(await r.read(m,{filename:'handbook.md',fixed_ref:{sha256:hash(text)}}),text);
 assert.equal(await r.read({release_directory:'releases/2.6.2'},{filename:'handbook.md',fixed_ref:{sha256:hash(old)}}),old);
 await assert.rejects(r.read(m,{filename:'handbook.md',fixed_ref:{sha256:hash(old)}}),/refresh_required/);
 await assert.rejects(r.read({release_directory:'../escape'},{filename:'handbook.md'}),/invalid_release/);
 }finally{await rm(root,{recursive:true});}
});
test('retired vectors are discoverable in compatibility, not current search',()=>{
 const full=['mem.vector.index','mem.vector.search','mem.semantic.query'].map(name=>({name,description:name}));
 assert.deepEqual(catalogue(full,{group:'search'}).items.map(x=>x.name),['mem.semantic.query']);
 assert.equal(catalogue(full,{group:'compatibility'}).items.length,2);
 assert.equal(catalogue(full,{tool:'mem.vector.index'}).state,'contract');
});
test('current context has one policy reference and does not inherit old prose',()=>{
 const result=withServiceProviderBoundary(currentContextRules({identity:{actor:'fixture'},rules:{obsolete:'主控绝对不得'}}));
 assert.equal(result.identity.actor,'fixture');assert.equal(result.rules.obsolete,undefined);
 assert.equal(result.role_policy.manual.body.id,'service-boundary');assert.equal(result.role_policy.rule_text,undefined);
});
test('service overview uses current origin even when historical URL differs; expanded view retains it',async()=>{
 const id='ad44cc0e-159e-4e0f-a5ca-73d3920240d9',project={project_id:id,title:'fixture',responsibility:{authorized_takeovers:[]}};
 const v8=async path=>path.endsWith('/search')?{items:[project]}:{project,recent_work:[]};
 const hufu=async path=>path.endsWith('/observations')?{schema:'workspace.project-observation.v1',service_state:'active',public_entry:{url:'https://current.example.test'}}:path.endsWith('/execute')?{service_state:'active',public_entry:{url:null}}:{projects:[]};
 const previous=globalThis.fetch;const seen=[];globalThis.fetch=async url=>{seen.push(url);return{ok:true,status:200,body:{cancel:async()=>{}}};};
 try{for(const expand of [false,true]){const r=await serviceRegistry({project_id:id,expand},v8,hufu);assert.equal(r.items[0].public_entry.url,'https://current.example.test');assert.deepEqual(r.items[0].legacy_assets,[]);}
 const historic=await serviceRegistry({project_id:id,include_history:true},v8,hufu);assert.ok(historic.items[0].legacy_assets.length>0);assert.ok(seen.every(x=>x==='https://current.example.test'));
 }finally{globalThis.fetch=previous;}
});
