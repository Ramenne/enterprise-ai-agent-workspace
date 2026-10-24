import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createChatRepository,CHAT_SCHEMA} from '../server/business/chat-repository.mjs';
import {installChatSearchIndex,searchIndexTerm} from '../server/business/chat-search-index.mjs';
import {PROJECT} from '../server/business/native-authority.mjs';
const context={actor_id:'a',project_id:PROJECT,can_read:true,can_write:true};
function raw(db,body,attachments=[],type='chat',recipients=null){return db.prepare(`INSERT INTO messages(id,actor_id,display_name,body,mentions,attachments_json,created_at,message_type,recipients_json) VALUES(?, 'a','A',?,'[]',?,1000,?,?)`).run(crypto.randomUUID(),body,JSON.stringify(attachments),type,recipients).lastInsertRowid;}
test('substring index preserves literal CJK, short queries, punctuation, ASCII folding and Unicode semantics',()=>{
 const db=new DatabaseSync(':memory:'),repo=createChatRepository(db);
 for(const text of ['中文测试资料','中文资料','ABC Abc abc','x%_y * OR NOT "abc"','a\nb\nc','   ','École école','😀😃😄😁','x\0abc','中文"引号','a+b (x) [y]'])raw(db,text);
 raw(db,'附件',[{name:'项目ABC资料.pdf'},{name:'中文文件.txt'}]);
 for(const q of ['中文测试','中文','中','ABC','abc','%_y','OR NOT','"abc"','a\nb','   ','Éco','éco','😀😃😄','\0ab','中文"','a+b','资料.pdf','不存在','']){
  const expected=db.prepare(`SELECT id FROM messages WHERE instr(lower(body),lower(?))>0 OR EXISTS(SELECT 1 FROM json_each(attachments_json) WHERE instr(lower(json_extract(value,'$.name')),lower(?))>0) ORDER BY seq`).all(q,q).map(x=>x.id);
  assert.deepEqual(repo.messages(context,{q,limit:100}).messages.map(x=>x.id),expected,JSON.stringify(q));
 }
 db.close();
});
test('legacy rows backfill atomically, reopen does not duplicate, and mutations maintain derived index',()=>{
 const db=new DatabaseSync(':memory:');db.exec(CHAT_SCHEMA);db.exec("ALTER TABLE messages ADD COLUMN message_type TEXT NOT NULL DEFAULT 'chat';ALTER TABLE messages ADD COLUMN recipients_json TEXT");
 const id=raw(db,'历史资料ABC');const repo=createChatRepository(db);
 assert.equal(repo.messages(context,{q:'资料ABC'}).messages.length,1);
 installChatSearchIndex(db);assert.equal(db.prepare('SELECT count(*) n FROM message_search_index').get().n,1);
 db.prepare('UPDATE messages SET body=? WHERE seq=?').run('修改后的XYZ',id);
 assert.equal(repo.messages(context,{q:'资料ABC'}).messages.length,0);assert.equal(repo.messages(context,{q:'XYZ'}).messages.length,1);
 db.prepare('DELETE FROM messages WHERE seq=?').run(id);assert.equal(repo.messages(context,{q:'XYZ'}).messages.length,0);db.close();
});
test('index cannot widen private audiences or resurrect deleted/recalled rows and supports keyset pages',()=>{
 const db=new DatabaseSync(':memory:'),repo=createChatRepository(db);
 for(let i=0;i<75;i++)raw(db,'匹配的资料ABC');
 raw(db,'匹配的资料ABC',[],'direct','["b","c"]');
 raw(db,'匹配的资料ABC',[],'direct','["a"]');
 db.exec("UPDATE messages SET recalled_at=2000 WHERE seq=1; INSERT INTO message_hides SELECT 'a',id,2000 FROM messages WHERE seq=2");
 const first=repo.messages(context,{q:'资料ABC',limit:50}),older=repo.messages(context,{q:'资料ABC',before:first.oldest_cursor,limit:50});
 assert.equal(first.messages.length,50);assert.equal(older.messages.length,23);assert.equal(older.has_more_old,false);
 assert.equal(repo.messages({...context,actor_id:'b'},{peer:'a',q:'资料ABC'}).messages.length,0);
 assert.equal(repo.messages(context,{peer:'a',q:'资料ABC'}).messages.length,1);db.close();
});
test('query planner uses inverted index for rare keyword and ordered index for conversation history',()=>{
 const db=new DatabaseSync(':memory:');createChatRepository(db);
 db.exec('BEGIN');for(let i=0;i<10000;i++)raw(db,i===100?'唯一匹配needle':'普通历史记录 '+i);db.exec('COMMIT');
 const term=searchIndexTerm(db,'needle');
 assert.equal(db.prepare('SELECT count(*) n FROM message_search_index WHERE message_search_index MATCH ?').get(term).n,1);
 const indexed=db.prepare('EXPLAIN QUERY PLAN SELECT * FROM messages WHERE message_type=? AND seq IN(SELECT rowid FROM message_search_index WHERE message_search_index MATCH ?) AND seq<? ORDER BY seq DESC LIMIT 51').all('chat',term,20000).map(x=>x.detail).join('\n');
 assert.match(indexed,/VIRTUAL TABLE INDEX/);assert.doesNotMatch(indexed,/SCAN messages\b/);
 const history=db.prepare("EXPLAIN QUERY PLAN SELECT * FROM messages WHERE message_type='chat' AND seq<20000 ORDER BY seq DESC LIMIT 51").all().map(x=>x.detail).join('\n');assert.match(history,/messages_conversation_order/);
 db.close();
});
