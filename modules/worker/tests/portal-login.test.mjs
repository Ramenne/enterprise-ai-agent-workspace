import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
const app=await readFile(new URL('../packages/portal/source/public/app.js',import.meta.url),'utf8');
const source=app.slice(app.indexOf('async function authResponse('),app.indexOf("$('send').onclick="));
const email='member@example.invalid';
function fixture(responses){const calls=[];const ctx=vm.createContext({base:'/hub2-preview/hufu/portal',fetch:async(...args)=>{calls.push(args);const r=responses.shift();if(r instanceof Error)throw r;assert.ok(r,'unexpected request');return r;}});vm.runInContext(source,ctx);return {ctx,calls};}
const session=(mail=email)=>new Response(JSON.stringify({identity:{actor_id:'synthetic-member'},user:{email:mail}}));
for(const [name,body]of[['empty',''],['truncated','{"token":'],['normal','{"user":{}}']])test(name+' success requires authenticated matching session',async()=>{const {ctx,calls}=fixture([new Response(body),session()]);await ctx.submitLogin(email,'synthetic');assert.equal(calls.length,2);assert.equal(calls[1][0],'/hub2-preview/hufu/portal/api/me');for(const[,opts]of calls){assert.equal(opts.credentials,'same-origin');assert.equal(opts.cache,'no-store');}});
for(const [name,response]of[['unauthenticated',new Response('{"error":"login_required"}',{status:401})],['wrong account',session('other@example.invalid')],['broken session response',new Response('')],['network failure',new Error('secret-network-detail')]])test(name+' must not complete login',async()=>{const{ctx}=fixture([new Response(''),response]);await assert.rejects(()=>ctx.submitLogin(email,'synthetic'),/尚未建立登录会话/);});
test('invalid OTP is actionable and never followed by session verification',async()=>{const{ctx,calls}=fixture([new Response('{"code":"INVALID_OTP","message":"secret"}',{status:400})]);await assert.rejects(()=>ctx.submitLogin(email,'synthetic'),/通行证编号不正确/);assert.equal(calls.length,1);});
test('empty upstream failure reports HTTP status without parse exception',async()=>{const{ctx}=fixture([new Response('',{status:502})]);await assert.rejects(()=>ctx.submitLogin(email,'synthetic'),/HTTP 502/);});
test('rate limit does not leak response body',async()=>{const{ctx}=fixture([new Response('secret',{status:429})]);await assert.rejects(()=>ctx.submitLogin(email,'synthetic'),/请求过于频繁/);});
test('session email comparison normalizes trim and case',async()=>{const{ctx}=fixture([new Response('{}'),session(' MEMBER@EXAMPLE.INVALID ')]);await ctx.submitLogin(email,'synthetic');});
test('network exception becomes safe guidance',async()=>{const{ctx}=fixture([new Error('secret')]);await assert.rejects(()=>ctx.submitLogin(email,'synthetic'),/登录服务暂时无法连接/);});
