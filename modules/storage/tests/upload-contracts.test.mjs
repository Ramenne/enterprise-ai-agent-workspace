import test from 'node:test';
import assert from 'node:assert/strict';
import {registerUploads} from '../source/apps/mem/src/upload-http.js';
import {registerArchiveUpload} from '../source/apps/mem/src/archive-upload.js';
import {uploadControlSchemas,archivePublishSchema} from '../source/apps/mem/src/upload-contracts.mjs';
const project_id='16f05f01-4a43-4e96-a16b-d8ed69eff77d',operation_id='cbd510d3-162f-4a62-a3e3-9648cd067297';
const request=(body,id=operation_id)=>({body,params:{id},headers:{authorization:'Bearer synthetic-upload-contract'}});
function controls(adapter,call){const routes=new Map();registerUploads({post:(path,fn)=>routes.set(path,fn)},adapter,call);return (suffix,body,id)=>routes.get('/v2/uploads/:id/'+suffix)(request(body,id));}
test('body/path separation retains malformed-input rejection before SQL',async()=>{
 let calls=0;const run=controls({},async()=>{calls++;return {state:'completed'};});
 await assert.rejects(run('multipart/complete',{project_id,operation_id}),e=>e.code==='invalid_input');
 await assert.rejects(run('multipart/complete',{project_id},'bad'),e=>e.code==='invalid_input');
 assert.equal(calls,0);
 await assert.rejects(controls(undefined,async()=>{calls++;})('multipart/complete',{}),e=>e.code==='object_store_unconfigured');
 assert.equal(calls,0);
});
test('part limits and strict archive publication inputs remain domain rules',()=>{
 const begin=uploadControlSchemas['multipart/begin'],part=uploadControlSchemas['multipart/part-ticket'];
 for(const n of [5242880,5368709120])assert.equal(begin.safeParse({project_id,part_size:n}).success,true);
 for(const n of [5242879,5368709121,5242880.5])assert.equal(begin.safeParse({project_id,part_size:n}).success,false);
 assert.equal(part.safeParse({project_id,part_number:10000,size:1}).success,true);
 for(const b of [{part_number:10001,size:1},{part_number:1,size:0}])assert.equal(part.safeParse({project_id,...b}).success,false);
 assert.equal(archivePublishSchema.safeParse({project_id,expected_owner_id:project_id,expected_project_revision:0}).success,false);
});
test('completed multipart replay never calls the provider',async()=>{
 const commands=[],provider=new Proxy({}, {get:()=>()=>{throw Error('unexpected_provider_effect');}});
 const run=controls(provider,async(_t,_s,name,action,b)=>{commands.push({name,action,body:b});return{state:'completed',receipt:{fixed:true}};});
 for(const suffix of ['multipart/resume','multipart/complete','multipart/abort']){const r=await run(suffix,{project_id});assert.equal(r.operation_id,operation_id);assert.equal(r.state,'completed');assert.equal(r.publication_state,'not_published');}
 assert.deepEqual(commands.map(x=>x.body.command),['resume','complete','abort']);
 assert.ok(commands.every(x=>x.body.operation_id===operation_id&&x.action==='mem.upload'));
});
test('provider completion with an expired SQL lease stays pending on the original operation',async()=>{
 const commands=[];const adapter={parts:async()=>{throw{$metadata:{httpStatusCode:404}};},completed:async()=>({fixed:true})};
 const run=controls(adapter,async(_t,_s,_n,_a,b)=>{commands.push(b.command);return{state:'completing',mode:'multipart',lease_until:'2000-01-01T00:00:00.000Z',staging_key:'synthetic',upload_id:'synthetic',size:1};});
 const r=await run('multipart/resume',{project_id});assert.equal(r.state,'provider_completed_sql_pending');assert.equal(r.operation_id,operation_id);assert.deepEqual(commands,['resume']);assert.equal(r.next_step,'complete_to_record_provider_receipt');
});
test('old archive attempt and fence resumes SQL publication without a provider',async()=>{
 const routes=new Map(),calls=[];registerArchiveUpload({post:(p,fn)=>routes.set(p,fn)},undefined,undefined,async(_t,_s,n,a,b)=>{calls.push({n,a,b});return{state:'published',operation_id:b.operation_id};});
 const body={project_id,expected_project_revision:1,expected_owner_id:project_id,attempt:2,fencing_token:operation_id};
 const r=await routes.get('/v2/uploads/:id/publish-archive')(request(body));assert.equal(r.state,'published');assert.deepEqual(calls,[{n:'publish_archive_upload',a:'mem.upload',b:{...body,operation_id}}]);
 await assert.rejects(routes.get('/v2/uploads/:id/publish-archive')(request({...body,fencing_token:undefined})),e=>e.code==='object_store_unconfigured');assert.equal(calls.length,1);
});
