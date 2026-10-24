import test from 'node:test';import assert from 'node:assert/strict';
import {PROJECT,qualificationContext,assertBusinessWrite} from '../server/business/native-authority.mjs';
const member={identity:{actor_id:'A'},user:{name:'Member'}};
const project={id:PROJECT,manager_id:'M'};
const bindings={project_id:PROJECT,members:[{actor_id:'A',legacy_username:'legacy-A',active:true}]};
const permissions=()=>({actor_id:'A',project_id:PROJECT,qualifications:[{project_id:PROJECT,principal_id:'A',active:true,effective_now:true,actions:['v8.project.read','mem.read','mem.write','v8.work.commit']}]});
test('actual native qualification permits mapped member but does not promote manager',()=>{const c=qualificationContext(member,permissions(),project,bindings);assert.equal(c.username,'A');assert.equal(c.can_write,true);assert.equal(c.can_publish_announcement,true);assert.equal(c.is_manager,false);assertBusinessWrite(c,{body:'message'});});
test('read-only project caller cannot write',()=>{const p=permissions();p.qualifications[0].actions=['v8.project.read','mem.read'];const c=qualificationContext(member,p,project,bindings);assert.throws(()=>assertBusinessWrite(c,{body:'message'}),/project_write_denied/);});
test('cross-account and stale grants fail closed',()=>{const p=permissions();p.actor_id='B';assert.throws(()=>qualificationContext(member,p,project,bindings),/identity_scope_mismatch/);const q=permissions();q.qualifications[0].expires_at='2000-01-01T00:00:00Z';assert.throws(()=>qualificationContext(member,q,project,bindings),/project_read_denied/);});
test('current runtime never depends on old account names',()=>{
 const c=qualificationContext(member,permissions(),project,null);assert.equal(c.username,'A');assert.deepEqual(c.legacy_refs,[]);
 const unknown=qualificationContext(member,permissions(),project,{project_id:PROJECT,members:[]});assert.equal(unknown.can_write,true);
 const ambiguous=qualificationContext(member,permissions(),project,{project_id:PROJECT,members:[...bindings.members,...bindings.members]});assert.deepEqual(ambiguous.legacy_refs,[]);assert.equal(ambiguous.username,'A');
 assert.throws(()=>qualificationContext(member,permissions(),project,{project_id:'other',members:[]}),/legacy_mapping_scope_mismatch/);
});
test('sender and manager role cannot be selected by message payload',()=>{const c=qualificationContext(member,permissions(),project,bindings);for(const field of ['actor_id','username','author_username','role','is_main_control'])assert.throws(()=>assertBusinessWrite(c,{[field]:'M'}),/identity_claim_not_allowed/);});

test('native session uses the current project member decision without legacy inventory dependency',async()=>{
 const {nativeBusinessSession,PROJECT}=await import('../server/business/native-authority.mjs');
 const actor='native-fixture-actor',calls=[];
 const fetcher=async(url,opts)=>{
  calls.push(url);let value;
  if(url.endsWith('/get-session'))value={session:{token:'fixture-only-not-a-credential',expiresAt:new Date(Date.now()+60000).toISOString()}};
  else if(url.endsWith('/v2/me'))value={actor_id:actor,member_label:'Fixture'};
  else if(url.endsWith('/v2/projects/read'))value={project:{id:PROJECT,title:'Actual title from V8',manager_id:'manager'}};
  else if(url.endsWith('/v2/authorization/permissions')){assert.deepEqual(JSON.parse(opts.body),{project:'Actual title from V8'});value={actor_id:actor,project_id:PROJECT,qualifications:[{project_id:PROJECT,principal_id:actor,active:true,effective_now:true,actions:['mem.read','v8.project.read']}]};}
  else if(url.endsWith('/v2/projects/members'))value={project_id:PROJECT,members:[{actor_id:actor,can_read:true,can_write:false,is_manager:false}],next_offset:null};
  else throw Error('unexpected native request');
  return new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});
 };
 const session=await nativeBusinessSession('fixture-cookie',undefined,{fetcher});assert.equal(session.context.actor_id,actor);assert.equal(session.context.can_write,false);
 assert.equal(calls.length,3);assert.ok(!calls.some(x=>x.endsWith('/v2/authorization/permissions')));
});

test('official current member facts cover manager access without inventing a grant',()=>{
 const m={identity:{actor_id:'M'},user:{name:'Supervisor'}};
 const p={actor_id:'M',project_id:PROJECT,qualifications:[]};
 const directory={project_id:PROJECT,members:[{actor_id:'M',can_read:true,can_write:true,is_manager:true}]};
 const c=qualificationContext(m,p,project,null,Date.now(),directory);
 assert.equal(c.can_write,true);assert.equal(c.can_publish_announcement,true);
 const impostor={...directory,members:[{actor_id:'M',can_read:true,can_write:true,is_manager:false}]};
 assert.equal(qualificationContext(m,p,project,null,Date.now(),impostor).can_publish_announcement,true);assert.equal(qualificationContext(m,p,project,null,Date.now(),impostor).is_manager,false);
});
test('member projection is exact scope and current actor, not a blanket role override',()=>{
 const p=permissions();
 for(const d of [{project_id:'other',members:[]},{project_id:PROJECT,members:[]},{project_id:PROJECT,members:[{actor_id:'B',can_read:true,can_write:true}]},{project_id:PROJECT,members:[{actor_id:'A',can_read:false,can_write:true}]}])assert.throws(()=>qualificationContext(member,p,project,null,Date.now(),d));
 const d={project_id:PROJECT,members:[{actor_id:'A',can_read:true,can_write:false,is_manager:true}]};
 const c=qualificationContext(member,p,project,null,Date.now(),d);assert.equal(c.can_write,false);assert.equal(c.can_publish_announcement,false);
 assert.throws(()=>qualificationContext(member,p,project,null,Date.now(),{...d,members:[...d.members,...d.members]}),/project_read_denied/);
});

test('overlapping verification is shared; next request sees revocation; accounts never mix',async()=>{
 const {coalesceNativeSessions}=await import('../server/business/native-authority.mjs');
 let release,allowed=true,calls=0;
 const gate=new Promise(r=>release=r);
 const resolver=coalesceNativeSessions(async cookie=>{calls++;await gate;if(!allowed)throw Object.assign(Error('revoked'),{status:403});return {context:{actor_id:cookie}};});
 const a=Array.from({length:12},()=>resolver('synthetic-a')),b=resolver('synthetic-b');
 await new Promise(r=>setImmediate(r));assert.equal(calls,2);release();
 assert.ok((await Promise.all(a)).every(x=>x.context.actor_id==='synthetic-a'));
 assert.equal((await b).context.actor_id,'synthetic-b');allowed=false;
 await assert.rejects(resolver('synthetic-a'),/revoked/);assert.equal(calls,3);
});

test('verified device lease reuses sequential messages and heartbeats; fixed expiry observes revocation',async()=>{
 const {coalesceNativeSessions}=await import('../server/business/native-authority.mjs');let now=1000,calls=0,allowed=true;
 const resolver=coalesceNativeSessions(async cookie=>{calls++;if(!allowed)throw Object.assign(Error('revoked'),{status:401});return {context:{actor_id:cookie}};},{ttlMs:60000,now:()=>now});
 for(let n=0;n<100;n++){assert.equal((await resolver('device-a')).context.actor_id,'device-a');now+=100;}
 assert.equal(calls,1);assert.equal((await resolver('device-b')).context.actor_id,'device-b');assert.equal(calls,2);
 allowed=false;now=61000;await assert.rejects(resolver('device-a'),/revoked/);assert.equal(calls,3);
});
test('rate limited authority uses one cooldown rather than repeating identity calls in a burst',async()=>{
 const {coalesceNativeSessions}=await import('../server/business/native-authority.mjs');let now=0,calls=0;
 const resolver=coalesceNativeSessions(async()=>{calls++;if(calls===1)throw Object.assign(Error('limited'),{status:429});return {context:{actor_id:'a'}};},{ttlMs:60000,now:()=>now});
 for(let n=0;n<11;n++)await assert.rejects(resolver('device-a'),e=>e.status===429);
 assert.equal(calls,1);now=60001;assert.equal((await resolver('device-a')).context.actor_id,'a');assert.equal(calls,2);
});
test('logout invalidation prevents a late identity result from restoring a cached authority',async()=>{
 const {coalesceNativeSessions}=await import('../server/business/native-authority.mjs');let release,calls=0;
 const resolver=coalesceNativeSessions(async()=>{calls++;if(calls===1)await new Promise(r=>release=r);return {context:{actor_id:'a'}};},{ttlMs:60000});
 const pending=resolver('device-a');await new Promise(r=>setImmediate(r));resolver.invalidate('device-a');release();await assert.rejects(pending,e=>e.code==='session_changed');await resolver('device-a');assert.equal(calls,2);
});
test('short browser-session expiry caps the authority lease and saturation cannot bypass verification',async()=>{
 const {coalesceNativeSessions}=await import('../server/business/native-authority.mjs');let now=0,calls=0;
 const resolver=coalesceNativeSessions(async()=>({context:{actor_id:'a'},authorityExpiresAt:++calls===1?500:5000}),{ttlMs:60000,now:()=>now});
 await resolver('device-a');now=501;await resolver('device-a');assert.equal(calls,2);
 let release;const busy=coalesceNativeSessions(async()=>{await new Promise(r=>release=r);return {};},{maxPending:1});
 const one=busy('a');await new Promise(r=>setImmediate(r));await assert.rejects(busy('b'),e=>e.status===503);release();await one;
});
