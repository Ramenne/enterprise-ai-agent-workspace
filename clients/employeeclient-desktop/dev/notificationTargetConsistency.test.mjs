import test from 'node:test';import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';
import {createChatRepository} from '../server/business/chat-repository.mjs';import {createHubNoticeStore} from '../server/business/hub-notifications.mjs';import {createDeviceRepository} from '../server/business/devices.mjs';import {PROJECT} from '../server/business/native-authority.mjs';
test('anonymous project updates keep the project target in the inbox without external delivery',async()=>{
 const db=new DatabaseSync(':memory:');const member={actor_id:'synthetic-recipient',project_id:PROJECT,can_read:true};
 try{createDeviceRepository(db);const repo=createChatRepository(db),store=createHubNoticeStore(db),view=n=>({project_id:PROJECT,complete_projection:true,aggregates:[{domain:'v8',aggregate_id:'synthetic-work',aggregate_revision:n,state:'in_progress'}]});
 store.apply({actor_id:'synthetic-service'},view(1),[member]);store.apply({actor_id:'synthetic-service'},view(2),[member]);
 db.prepare('INSERT INTO device_bindings VALUES(?,?,?,?,?,NULL)').run('synthetic-device',member.actor_id,'ios_web_push','{}',1);
 const notice=repo.notifications(member).notifications[0];assert.equal(notice.kind,'hub_update');assert.equal(notice.object_id,PROJECT);assert.equal(notice.snapshot.silent,true);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM delivery_outbox').get().n,0,'anonymous project revisions are inbox synchronization hints, not system pushes');

 }finally{db.close();}
});
