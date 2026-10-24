import test from 'node:test';
import assert from 'node:assert/strict';
const {attachKnowledgeFollowup,knowledgeWorkflow}=await import(process.env.KNOWLEDGE_MODULE??'../apps/v8/src/knowledge-followup.ts');
const input={project_id:'P',properties:{}};
const saved={state:'saved',work_item_id:'W',update_id:'U',completion_applied:false,work_state:'in_progress'};
test('ordinary saves and reads do not trigger per-message reviews',()=>{
 assert.strictEqual(attachKnowledgeFollowup(saved,'work_save',input),saved);
 assert.strictEqual(attachKnowledgeFollowup({...saved,state:'read',work_state:'completed'},'work_read',input).knowledge_followup,undefined);
});
test('completion claims without applied state never masquerade as work completion',()=>{
 assert.strictEqual(attachKnowledgeFollowup(saved,'work_save',{...input,completion_state:'completed'}),saved);
});
test('actual applied completion yields current-Agent handoff only',()=>{
 const r=attachKnowledgeFollowup({...saved,completion_applied:true,work_state:'completed'},'work_save',input);
 assert.equal(r.knowledge_followup.reason,'applied_work_completion');
 assert.deepEqual(r.knowledge_followup.source,{project_id:'P',work_item_id:'W',stage_update_id:'U',phase:null});
 assert.equal(r.knowledge_followup.workflow.entrypoint.tool,'tools.library');
});
test('Agent phase boundary can review before the whole work is finished',()=>{
 const r=attachKnowledgeFollowup(saved,'work_commit',{...input,properties:{knowledge_review:{phase:'milestone',phase_complete:true,status:'ready'}}});
 assert.equal(r.knowledge_followup.source.phase,'milestone');
 assert.equal(r.knowledge_followup.reason,'agent_declared_phase_boundary');
});
test('completed review declarations avoid duplicate followups without deleting other facts',()=>{
 for(const status of ['persisted','reviewed_no_new']){
 const base={...saved,completion_applied:true,work_state:'completed'};
 assert.strictEqual(attachKnowledgeFollowup(base,'work_save',{...input,properties:{knowledge_review:{phase_complete:true,status}}}),base);
 }
});
test('conflicts, failures and malformed phase markers do not start a review',()=>{
 for(const state of ['conflict','failed']){const base={...saved,state};assert.strictEqual(attachKnowledgeFollowup(base,'work_save',{...input,properties:{knowledge_review:{phase_complete:true}}}),base);}
 for(const marker of [null,[],false,{phase_complete:'true'}])assert.strictEqual(attachKnowledgeFollowup(saved,'work_save',{...input,properties:{knowledge_review:marker}}),saved);
});
test('handoff uses saved identity and excludes original conversation text',()=>{
 const r=attachKnowledgeFollowup({...saved,completion_applied:true,work_state:'completed'},'work_save',{...input,work_item_id:'wrong',summary:'private dialogue',properties:{knowledge_review:{observations:'private feedback'}}});
 assert.equal(r.knowledge_followup.source.work_item_id,'W');
 assert.equal(JSON.stringify(r.knowledge_followup).includes('private'),false);
 assert.equal(r.summary,undefined);
});
test('workflow has one existing library entry; no independent store or polling action',()=>{
 assert.equal(knowledgeWorkflow.entrypoint.arguments.action,'help');
 assert.equal(knowledgeWorkflow.skill_discovery.arguments.operation,'skill_list');
 assert.equal(knowledgeWorkflow.skill_read.arguments.operation,'skill_read');
});
