import test from 'node:test';import assert from 'node:assert/strict';import {shareMemberDirectory,loadNotificationFoundation} from '../server/business/hub-notifications.mjs';import {PROJECT} from '../server/business/native-authority.mjs';import {mkdtemp,writeFile,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {DatabaseSync} from 'node:sqlite';import {createChatRepository} from '../server/business/chat-repository.mjs';import {createDeviceRepository,createDeliveryDispatcher} from '../server/business/devices.mjs';
test('directory lease is fixed, shares concurrent work, never serves stale data after failure, then recovers',async()=>{
 let now=0,reads=0,allow=true;const read=shareMemberDirectory(async()=>{reads++;if(!allow)throw Object.assign(Error('outage'),{status:503});return [{actor_id:'a',can_read:true}];},{ttlMs:15000,now:()=>now});
 await Promise.all(Array.from({length:30},()=>read()));assert.equal(reads,1);now=14999;await read();assert.equal(reads,1);
 now=15000;allow=false;await assert.rejects(read(),e=>e.status===503);assert.equal(reads,2);await assert.rejects(read());assert.equal(reads,2);
 now=30000;allow=true;await read();assert.equal(reads,3);now=45000;allow=false;await assert.rejects(read());
});
test('production foundation adapter shares directory reads for 30 isolated push deliveries',async()=>{
 const folder=await mkdtemp(join(tmpdir(),'qn-directory-')),path=join(folder,'synthetic.private');await writeFile(path,'hub2_'+'x'.repeat(24),{mode:0o600});const db=new DatabaseSync(':memory:');let drain;
 const a={project_id:PROJECT,actor_id:'synthetic-a',display_name:'A',can_read:true,can_write:true},b={...a,actor_id:'synthetic-b'};let directoryCalls=0,delivered=0;
 try{const foundation=await loadNotificationFoundation({path,fetcher:async url=>{if(url.endsWith('/v2/me'))return Response.json({actor_id:'synthetic-service',principal_kind:'service',authorization_mode:'product_service'});assert.ok(url.endsWith('/v2/projects/members'));directoryCalls++;return Response.json({project_id:PROJECT,members:[a,b],next_offset:null});}});
 const repo=createChatRepository(db);createDeviceRepository(db);db.prepare('INSERT INTO device_bindings VALUES(?,?,?,?,?,NULL)').run('synthetic-device',b.actor_id,'ios_web_push','{}',1);for(let i=0;i<30;i++)repo.send(a,{body:'test '+i},'directory-'+i,{members:[a,b]});
 drain=createDeliveryDispatcher(db,{deliver:async()=>{delivered++;return {state:'provider_accepted'};}},{directory:foundation.directory});for(let i=0;i<20&&delivered<30;i++)await new Promise(r=>setImmediate(r));assert.equal(delivered,30);assert.equal(directoryCalls,1);
 }finally{drain?.close();db.close();await rm(folder,{recursive:true,force:true});}
});
