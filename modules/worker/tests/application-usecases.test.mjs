import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {createDocumentSave} from '../packages/mcp-edge/source/application/document.mjs';
import {createMaterialDetail} from '../packages/mcp-edge/source/application/material-detail.mjs';
import {createMaterialWorkspace} from '../packages/portal/source/material-workspace-api.mjs';
const pid='cfe3f0af-af84-4c63-a0d6-2d0677caaddd',mid='8662ae87-2e86-405e-aa76-c2b6e807b0b1',vid='29c081d9-ff48-41c9-adbf-31b0b19c36b4',fixed={material_id:mid,version_id:vid,sha256:'a'.repeat(64)};
const error=(m,status=400)=>Object.assign(Error(m),{status});const auth={token:'synthetic',identity:{actor_id:'synthetic-member'}};
test('saved document survives work-registration failure and process recreation',async()=>{const journalRoot=await mkdtemp(join(tmpdir(),'hub-usecase-'));let fail=true;const writes=[],registrations=[];
 const invokeNext=async(_auth,name,b)=>{if(name==='mem.write_text'){writes.push(b);return{state:'published',fixed_refs:[fixed]};}if(name==='v8.work.save'){registrations.push(b);if(fail)throw error('dependency_busy',503);return{state:'saved',work_item_id:'existing-result'};}throw Error(name);};
 const args={project_id:pid,path:'test.txt',text:'synthetic',idempotency_key:'original'};
 try{const first=await createDocumentSave({journalRoot,invokeNext,findPath:async()=>({items:[]}),error})(auth,args,{});assert.equal(first.state,'document_saved_work_pending');fail=false;
 const resumed=await createDocumentSave({journalRoot,invokeNext,findPath:async()=>({items:[]}),error})(auth,args,{});assert.equal(resumed.state,'saved');assert.deepEqual(resumed.fixed_ref,fixed);assert.deepEqual(writes[0],writes[1]);assert.deepEqual(registrations[0],registrations[1]);
 await assert.rejects(createDocumentSave({journalRoot,invokeNext,findPath:async()=>({items:[]}),error})(auth,{...args,text:'different'},{}),{message:'idempotency_conflict'});
 }finally{await rm(journalRoot,{recursive:true,force:true});}
});
test('replaying a saved document still rechecks current domain authority',async()=>{const journalRoot=await mkdtemp(join(tmpdir(),'hub-usecase-'));let revoked=false,calls=0;
 const invokeNext=async(_auth,name)=>{if(name==='mem.write_text'){calls++;if(revoked)throw error('forbidden',403);return{state:'published',fixed_refs:[fixed]};}throw Error(name);};
 const save=createDocumentSave({journalRoot,invokeNext,findPath:async()=>({items:[]}),error}),args={project_id:pid,path:'x.txt',text:'synthetic',register_work:false,idempotency_key:'original'};
 try{await save(auth,args,{});revoked=true;await assert.rejects(save(auth,args,{}),{message:'forbidden'});assert.equal(calls,2);}finally{await rm(journalRoot,{recursive:true,force:true});}
});
test('detail resolves once and preserves independent partial failures and fixed version',async()=>{const calls=[];const detail=createMaterialDetail({mem:async(a,path,b)=>{assert.equal(a,auth);calls.push({path,b});if(path.endsWith('/locate'))return{project_id:pid,material_id:mid,fixed_ref:fixed};assert.equal(b.project_id,pid);assert.equal(b.material_id,mid);if(path.includes('storage-tier'))throw error('dependency_busy',503);return{state:'read'};}});
 const result=await detail(auth,{material_id:mid,version_id:vid});assert.equal(calls.length,6);assert.equal(calls.filter(c=>c.path.endsWith('/locate')).length,1);assert.equal(result.storage.error,'dependency_busy');assert.equal(result.attributes.state,'read');assert.deepEqual(result.fixed_ref,fixed);
});
test('detail never converts a revoked mandatory read to success',async()=>{const detail=createMaterialDetail({mem:async(_a,p)=>{if(p.endsWith('/locate'))return{project_id:pid,material_id:mid,fixed_ref:fixed};throw error('forbidden',403);}});await assert.rejects(detail(auth,{material_id:mid}),{message:'forbidden'});await assert.rejects(detail(auth,{material_id:mid,actor_id:'spoofed'}),{message:'invalid_material_detail_input'});});
test('portal detail invokes the shared application HTTP route without MCP or a second lookup',async()=>{const calls=[];const workspace=createMaterialWorkspace({rpc:()=>{throw Error('MCP must not be called');},pageToken:async()=>auth.token,call:async(url,o)=>{calls.push({url,o});return{fixed_ref:fixed};}});const result=await workspace.handle({},'detail',{material_id:mid});assert.equal(calls.length,1);assert.equal(calls[0].url,'http://127.0.0.1:8939/v2/usecases/materials/detail');assert.equal(calls[0].o.headers.authorization,'Bearer synthetic');assert.deepEqual(result.fixed_ref,fixed);});
