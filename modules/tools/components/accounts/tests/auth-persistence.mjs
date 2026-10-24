import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomBytes} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {configureSessions,signin,authenticate,logout} from '../hufu-auth.mjs';
const days=7*86400;
let status=200,actor='member-a';
function mock(){globalThis.fetch=async url=>{const sign=String(url).includes('sign-in');return new Response(JSON.stringify(sign?{}:String(url).includes('get-session')?{session:{expiresAt:new Date(Date.now()+days*1000).toISOString()}}:{identity:{actor_id:actor,principal_kind:'member'},user:{name:actor}}),{status,headers:sign?{'set-cookie':'central_session_token=private-fixture; Max-Age='+days+'; HttpOnly; Secure'}:{}})}}
const req=t=>({headers:{cookie:'xianyu_session='+t}});
if(process.env.AUTH_TEST_CHILD){mock();const db=new DatabaseSync(process.env.AUTH_TEST_DB);configureSessions(db);assert.equal((await authenticate(req(process.env.AUTH_TEST_TOKEN))).owner,'member-a');db.close();process.exit(0)}
process.env.XIANYU_KEY=randomBytes(32).toString('base64');mock();const dir=mkdtempSync(join(tmpdir(),'auth-persistence-'));let db=new DatabaseSync(join(dir,'sessions.sqlite'));configureSessions(db);
try{
const session=await signin('fixture@example.test','fixture');assert.ok(session.maxAge<=days&&session.maxAge>days-10);let row=db.prepare('SELECT * FROM hufu_sessions').get();assert.notEqual(row.token_hash,session.token);assert.ok(!row.secret.includes('private-fixture'));db.close();
const child=spawnSync(process.execPath,[fileURLToPath(import.meta.url)],{env:{...process.env,AUTH_TEST_CHILD:'1',AUTH_TEST_DB:join(dir,'sessions.sqlite'),AUTH_TEST_TOKEN:session.token},encoding:'utf8'});assert.equal(child.status,0,child.stderr);db=new DatabaseSync(join(dir,'sessions.sqlite'));configureSessions(db);
status=503;await assert.rejects(authenticate(req(session.token)));assert.equal(db.prepare('SELECT count(*) n FROM hufu_sessions').get().n,1);status=200;assert.equal((await authenticate(req(session.token))).owner,'member-a');assert.equal(await authenticate(req('forged')),null);
logout(req(session.token));assert.equal(await authenticate(req(session.token)),null);const revoked=await signin('fixture@example.test','fixture');status=401;assert.equal(await authenticate(req(revoked.token)),null);status=200;
const changed=await signin('fixture@example.test','fixture');actor='member-b';assert.equal(await authenticate(req(changed.token)),null);actor='member-a';
const expired=await signin('fixture@example.test','fixture');db.prepare('UPDATE hufu_sessions SET expires_at=0').run();assert.equal(await authenticate(req(expired.token)),null);
console.log('PASS process restart persistence, encryption, native expiry bound, temporary outage recovery, logout, revocation, identity mismatch, expiry');
}finally{try{db.close()}catch{};rmSync(dir,{recursive:true,force:true})}
