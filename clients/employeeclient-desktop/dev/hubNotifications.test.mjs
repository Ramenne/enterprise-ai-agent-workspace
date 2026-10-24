import test from 'node:test';import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';import {createChatRepository} from '../server/business/chat-repository.mjs';import {createHubNoticeStore} from '../server/business/hub-notifications.mjs';import {PROJECT} from '../server/business/native-authority.mjs';
const a={project_id:PROJECT,actor_id:'synthetic-A',can_read:true,can_write:true};
const members=[{actor_id:'synthetic-A',can_read:true},{actor_id:'synthetic-B',can_read:true},{actor_id:'revoked',can_read:false}];
const view=revision=>({project_id:PROJECT,complete_projection:true,aggregates:[{domain:'v8',aggregate_id:'work',aggregate_revision:revision,state:'in_progress'}]});
test('project change keeps a durable sync hint without anonymous push; replay and restart deduplicate',t=>{
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());const repo=createChatRepository(db);let store=createHubNoticeStore(db);const service={actor_id:'synthetic-service'};
 assert.equal(store.apply(service,view(1),members).state,'baseline');assert.equal(repo.notifications(a).notifications.length,0);
 assert.equal(store.apply(service,view(2),members).created,2);assert.equal(repo.messages(a).messages.length,0);
 const n=repo.notifications(a).notifications[0];assert.equal(n.kind,'hub_update');assert.equal(n.snapshot.silent,true);assert.equal(n.actor_username,'synthetic-service');assert.match(n.deep_link,/projects\/.*\/updates$/);
 store=createHubNoticeStore(db);assert.equal(store.apply(service,view(2),members).created,0);assert.equal(repo.notifications(a).notifications.length,1);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM notifications WHERE recipient_actor=?').get('revoked').n,0);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM delivery_outbox').get().n,0);
});
test('foreign or incomplete projections do not write source checkpoints or deliver notices',t=>{
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());createChatRepository(db);const store=createHubNoticeStore(db);
 for(const bad of [{...view(1),project_id:'foreign'},{...view(1),complete_projection:false}])assert.throws(()=>store.apply({actor_id:'synthetic-service'},bad,members),/hub_projection_invalid/);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM hub_project_projection').get().n,0);
});
