import {test} from 'node:test';import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';
import {createChatRepository} from '../server/business/chat-repository.mjs';import {PROJECT} from '../server/business/native-authority.mjs';
import {messageTextParts,hasMessageLink,attachmentSearchKind} from '../shared/chat-search.mjs';
const ctx=a=>({actor_id:a,display_name:a,project_id:PROJECT,can_read:true,can_write:true});
const members=['a','b','c'].map(actor_id=>({actor_id,can_read:true}));
const attachment=(name,mime,purpose)=>({id:'4bbf924c-a36c-4a86-ac04-7effd6c51110:b2d1d4d7-e22d-43b7-a647-27b7f4f3cb88',name,mime,purpose,owner_username:'b',size:20,sha256:'a'.repeat(64),fixed_ref:{project_id:PROJECT,material_id:'4bbf924c-a36c-4a86-ac04-7effd6c51110',version_id:'b2d1d4d7-e22d-43b7-a647-27b7f4f3cb88'}});
test('rich text preserves exact bytes, literal highlights and safe supported links',()=>{
 const text='<img onerror=x>\nHTTPS://example.com/path?q=1。 www.example.org/test, javascript:alert(1) a+b A+B';
 const parts=messageTextParts(text,'a+b');assert.equal(parts.map(p=>p.text).join(''),text);assert.equal(parts.flatMap(p=>p.parts).map(p=>p.text).join(''),text);
 assert.equal(parts.filter(p=>p.href).length,2);assert.equal(parts.flatMap(p=>p.parts).filter(p=>p.match).length,2);
 assert.equal(hasMessageLink('javascript:alert(1) https://name:password@example.com mailto:a@b.com'),false);
 assert.equal(hasMessageLink('文字 https://example.com/a'),true);
});
test('media type respects explicit MIME and voice purpose; ordinary audio is a file',()=>{
 assert.equal(attachmentSearchKind(attachment('x.jpg','application/octet-stream')),'media');assert.equal(attachmentSearchKind(attachment('x.jpg','text/plain')),'files');
 assert.equal(attachmentSearchKind(attachment('x.mp4','video/mp4')),'media');assert.equal(attachmentSearchKind(attachment('x.wav','audio/wav','voice')),'voice');assert.equal(attachmentSearchKind(attachment('x.wav','audio/wav','file')),'files');
});
test('kind query spans older pages, composes filters and removes hidden/recalled rows',()=>{
 const db=new DatabaseSync(':memory:');let clock=1000;const repo=createChatRepository(db,{now:()=>clock++});let key=0;
 const send=(body,files=[])=>repo.send(ctx('b'),body,'k'+key++,{members,attachments:files}).message;
 const rows=Array.from({length:65},(_,i)=>send({body:'图片资料 '+i},[attachment('x.png','image/png','file')]));
 for(let i=0;i<75;i++)send({body:'后来的文字 '+i});
 repo.change(ctx('a'),rows[0].id,'hide','hide');repo.change(ctx('b'),rows[1].id,'recall','recall');
 const page=repo.messages(ctx('a'),{kind:'media',q:'图片资料',author:'b',created_from:rows[0].created_at,created_until:rows.at(-1).created_at+1,limit:50});assert.equal(page.messages.length,50);assert.equal(page.has_more_old,true);
 const old=repo.messages(ctx('a'),{kind:'media',before:page.oldest_cursor,limit:50});assert.equal(old.messages.length,13);assert.equal(old.has_more_old,false);assert.ok([...page.messages,...old.messages].every(m=>m.attachments.length&&!m.hidden&&!m.recalled));
 assert.throws(()=>repo.messages(ctx('a'),{kind:'unsupported'}),/invalid_message_kind/);db.close();
});
test('private and helper kinds keep conversation audiences and do not leak other peers',()=>{
 const db=new DatabaseSync(':memory:'),repo=createChatRepository(db);const a=ctx('a');let key=0;
 const send=peer=>repo.send(a,{body:'私聊文件',recipient_username:peer},'p'+key++,{members,attachments:[{...attachment('report.pdf','application/pdf','file'),id:'private:'+peer,owner_username:'a',private_peer:peer}]}).message;
 const b=send('b'),c=send('c'),self=send('a');
 assert.deepEqual(repo.messages(a,{peer:'b',kind:'files'}).messages.map(m=>m.id),[b.id]);assert.deepEqual(repo.messages(a,{peer:'a',kind:'files'}).messages.map(m=>m.id),[self.id]);
 assert.equal(repo.messages(ctx('c'),{peer:'b',kind:'files'}).messages.length,0);assert.deepEqual(repo.messages(ctx('c'),{peer:'a',kind:'files'}).messages.map(m=>m.id),[c.id]);db.close();
});
test('link and voice search separate textual links from files and normal audio',()=>{
 const db=new DatabaseSync(':memory:'),repo=createChatRepository(db);let key=0;
 const send=(body,files=[])=>repo.send(ctx('b'),{body},'l'+key++,{members,attachments:files}).message;
 const link=send('参看 https://example.com/path?q=1。');send('javascript:alert(1)');send('附件',[attachment('https-example.txt','text/plain','file')]);
 const voice=send('',[attachment('voice.wav','audio/wav','voice')]),music=send('',[attachment('music.wav','audio/wav','file')]);
 assert.deepEqual(repo.messages(ctx('a'),{kind:'links'}).messages.map(m=>m.id),[link.id]);assert.deepEqual(repo.messages(ctx('a'),{kind:'voice'}).messages.map(m=>m.id),[voice.id]);assert.ok(repo.messages(ctx('a'),{kind:'files'}).messages.some(m=>m.id===music.id));db.close();
});
