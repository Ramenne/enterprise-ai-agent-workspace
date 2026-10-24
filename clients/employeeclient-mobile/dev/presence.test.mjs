import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../src/chat/presence.ts', import.meta.url), 'utf8');
const result = await build({ stdin: { contents: source, loader: 'ts' }, write: false, format: 'esm' });
const { presenceStatus, comparePresence } = await import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64'));
const now = new Date(2026, 9, 11, 12).getTime();
test('presence distinguishes live connections and the requested activity bands', () => {
 assert.equal(presenceStatus({online:true,last_seen_at:now-60_000},now),'在线');
 for(const [ago,label] of [[20_000,'1分钟之内在线'],[60_000,'1分钟之内在线'],[120_000,'3分钟之内在线'],[180_000,'3分钟之内在线'],[240_000,'5分钟之内在线'],[300_000,'5分钟之内在线'],[900_000,'半个小时之内在线'],[1800_000,'半个小时之内在线'],[3600_000,'当天在线'],[86400_000,'昨日在线'],[3*86400_000,'7天之内在线'],[7*86400_000,'7天之内在线'],[8*86400_000,'一个月之内在线'],[60*86400_000,'一个月之内在线']]){
  assert.equal(presenceStatus({online:false,last_seen_at:now-ago},now),label);
 }
});
test('calendar yesterday is distinct from a rolling 24-hour interval',()=>{
 const morning=new Date(2026,9,11,8).getTime(),lastNight=new Date(2026,9,10,23).getTime();
 assert.equal(presenceStatus({last_seen_at:lastNight},morning),'昨日在线');
});
test('unknown and invalid records show offline; cached timestamps remain readable',()=>{
 for(const value of [undefined,null,'not-a-date',-1])assert.equal(presenceStatus({last_seen_at:value},now),'离线');
 assert.equal(presenceStatus({last_auth_sync_at:now-120_000},now),'3分钟之内在线');
 assert.equal(presenceStatus({last_seen_at:new Date(now-240_000).toISOString()},now),'5分钟之内在线');
});

test('members sort by online, newest last-seen, then name rather than old directory order',()=>{
 const list=[{username:'old',nickname:'A',last_seen_at:100},{username:'new',nickname:'B',last_seen_at:200},{username:'z',nickname:'Z',online:true},{username:'a',nickname:'A',online:true},{username:'same',nickname:'A',last_seen_at:200}];
 assert.deepEqual(list.sort(comparePresence).map(m=>m.username),['a','z','same','new','old']);
});
