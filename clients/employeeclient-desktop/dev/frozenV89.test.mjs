import test from 'node:test';import assert from 'node:assert/strict';
import {readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {pathToFileURL} from 'node:url';
import {DatabaseSync} from 'node:sqlite';import {createServer} from 'node:http';
const folder=await mkdtemp(join(tmpdir(),'qn-v89-frozen-'));
const bundle=await readFile(new URL('../../个人页反馈与引用优化发布-v89-20261011/server/gateway.runtime.mjs',import.meta.url),'utf8');
const file=join(folder,'candidate.mjs');await writeFile(file,bundle+'\ninit_runtime(); export {createRuntimeHandler,createChatRepository,PROJECT};\n');
let modules;try{modules=await import(pathToFileURL(file).href);}finally{await rm(folder,{recursive:true,force:true});}
const {createRuntimeHandler,createChatRepository,PROJECT}=modules;
const actor=id=>({actor_id:id,display_name:id,project_id:PROJECT,can_read:true,can_write:true});
test('frozen v89 serves stored feedback and uses two fresh authority checks for text and referenced sends',async t=>{
 const db=new DatabaseSync(':memory:');let auths=0,dirs=0,denied=false;const rpc=[];
 const handler=createRuntimeHandler(db,{sessionFactory:async cookie=>{
  auths++;if(cookie==='outsider'||denied)throw Object.assign(Error('denied'),{status:403});
  return {context:{...actor(cookie),member_roster:[actor('a'),actor('b')]},directory:async()=>{dirs++;return [actor('a'),actor('b')];},rpc:async(name,args)=>{rpc.push(name);if(name==='v8.project.read')return {project:{id:PROJECT,title:'员工客户端',visibility:'team'}};if(name==='v8.work.read')return {work_item:{id:args.work_item_id,project_id:PROJECT,goal:'引用事项',short_no:1000172}};throw Error('unexpected RPC');}};
 }});
 const server=createServer(handler);await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(async()=>{handler.close();server.closeAllConnections();await new Promise(r=>server.close(r));db.close();});
 const call=async(path,body,key,cookie='a')=>{const r=await fetch('http://127.0.0.1:'+server.address().port+'/business/v1/'+path,{method:body?'POST':'GET',headers:{cookie,...(body?{'content-type':'application/json','idempotency-key':key}:{})},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,body:await r.json()};};
 const first=await call('messages',{body:'普通消息',attachment_ids:[]},'text');assert.equal(first.status,201);assert.equal(auths,2);assert.equal(dirs,0);assert.deepEqual(rpc,[]);
 const ref=await call('messages',{body:'关联',attachment_ids:[],project_id:PROJECT,work_item_id:'work'},'ref');assert.equal(ref.status,201);assert.equal(ref.body.message.context.short_no,1000172);assert.equal(auths,4);assert.deepEqual(rpc,['v8.project.read','v8.work.read']);
 const jpeg=Buffer.from([255,216,255,192,0,17,8,0,1,0,1,3,1,17,0,2,17,0,3,17,0,255,217]);
 const body={description:'冻结候选图文反馈',images:[{mime:'image/jpeg',bytes_base64:jpeg.toString('base64')}],app_version:'0.49.43'};
 const saved=await call('feedback',body,'feedback');assert.equal(saved.status,201);assert.equal(saved.body.state,'stored');assert.deepEqual((await call('feedback',body,'feedback')).body,saved.body);
 const read=await call('feedback/'+saved.body.feedback_id,null,null,'b');assert.equal(read.status,200);assert.equal(read.body.feedback.actor_id,'a');assert.equal(read.body.feedback.images[0].data_url,'data:image/jpeg;base64,'+jpeg.toString('base64'));
 assert.equal(db.prepare('SELECT COUNT(*) n FROM messages').get().n,2,'feedback does not create chat');
 assert.equal((await call('feedback',null,null,'outsider')).status,403);
 denied=true;assert.equal((await call('messages',{body:'撤权',attachment_ids:[]},'denied')).status,403);assert.equal(db.prepare('SELECT COUNT(*) n FROM messages').get().n,2);
});
test('frozen v89 file pages are newest-first while ordinary chat retains its order',t=>{
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());let ts=1;const repo=createChatRepository(db,{now:()=>ts});
 for(const [id,time] of [['old',200],['new',1000],['import',100],['tie',1000],['middle',500]]){ts=time;const att={id,name:id+'.txt',purpose:'file',mime:'text/plain',fixed_ref:{project_id:PROJECT,material_id:id,version_id:'v1'}};repo.send(actor('a'),{body:id,attachment_ids:[id]},id,{members:[actor('a')],attachments:[att]});}
 let before,rows=[];do{const page=repo.files(actor('a'),{before,limit:2});rows.push(...page.files);before=page.next_cursor;}while(before);
 assert.deepEqual(rows.map(f=>f.id),['tie','new','middle','old','import']);assert.deepEqual(repo.messages(actor('a')).messages.map(m=>m.body),['old','new','import','tie','middle']);
 assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name='messages_date_order'").get());
});
