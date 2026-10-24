import test from 'node:test';
import assert from 'node:assert/strict';
import {saveDiscussionRecord,messageFragment} from '../src/native/work-record.mjs';
const input={project_id:'project',work_item_id:'work',summary:'采用本条讨论继续接口适配',message:{id:'message',body:'当前可见正文',author_username:'actor',created_at:1,attachments:[]}};
test('discussion preserves source bytes then appends existing native work; no old Task APIs',async()=>{
 const calls=[];let saved;
 const client={
  work:async()=>({work_item:{id:'work',project_id:'project',revision:9,short_no:1000133,goal:'接口适配'}}),
  prepareUpload:async(p,file,key)=>{calls.push(['upload',p,key,JSON.parse(await file.text())]);return {name:file.name};},
  finishUpload:async()=>({fixed_refs:[{material_id:'source',version_id:'version',sha256:'hash'}]}),
  rpc:async(name,body,key)=>{calls.push([name,body,key]);return {state:'saved'}},
 };
 const result=await saveDiscussionRecord(client,input,'stable',{save:s=>{saved=structuredClone(s)}});
 assert.equal(calls[0][3].message.body,'当前可见正文');
 assert.equal(calls[1][0],'v8.work.save');assert.equal(calls[1][1].expected_revision,9);
 assert.equal(calls[1][1].work_item_id,'work');assert.equal(calls[1][1].task_id,undefined);
 assert.equal(calls[1][1].outputs[0].material_id,'source');
 assert.equal(result.source_fixed_ref.version_id,'version');assert.equal(saved.commit.properties.work_judgment.decision,'continuation');
});
test('a lost commit response reuses fixed source, original read revision and same submission',async()=>{
 let state,reads=0,uploads=0,attempts=[];
 const client={work:async()=>{reads++;return {work_item:{id:'work',project_id:'project',revision:9,goal:'适配'}}},
  prepareUpload:async(p,file)=>{uploads++;return {name:file.name}},finishUpload:async()=>({fixed_refs:[{material_id:'m',version_id:'v',sha256:'h'}]}),
  rpc:async(n,b,k)=>{attempts.push(structuredClone({n,b,k}));if(attempts.length===1)throw Error('network lost after commit');return {state:'saved'}}};
 const options={load:()=>state,save:s=>{state=structuredClone(s)}};
 await assert.rejects(saveDiscussionRecord(client,input,'stable',options));
 await saveDiscussionRecord(client,input,'stable',options);
 assert.equal(reads,1);assert.equal(uploads,1);assert.deepEqual(attempts[0],attempts[1]);
 await assert.rejects(saveDiscussionRecord(client,{...input,summary:'different'},'stable',options),e=>e.code==='work_record_resume_mismatch');
});
test('removed source and account switches cannot append a visible original',async()=>{
 assert.throws(()=>messageFragment({...input.message,recalled:true}),e=>e.code==='message_not_available');
 let writes=0;
 await assert.rejects(saveDiscussionRecord({rpc:()=>{writes++}},input,'stable',{valid:()=>false}),e=>e.code==='session_changed');
 assert.equal(writes,0);
 assert.equal(messageFragment({...input.message,token:'not-source'}).message.token,undefined);
});
