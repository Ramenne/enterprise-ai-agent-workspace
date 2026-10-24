import test from 'node:test';import assert from 'node:assert/strict';
import {isRetryableFailure,userError} from '../src/domain/userError.mjs';
import {createPinia,setActivePinia} from 'pinia';import {useUiStore} from '../src/store/ui.ts';
test('recovery and cancellation are silent; a module failure describes its own action',()=>{
 assert.equal(userError({code:'session_recovering'}),'');assert.equal(userError({name:'AbortError'}),'');
 assert.equal(userError({status:503,code:'dependency_busy'},'工作暂未更新'),'工作暂未更新');
 assert.equal(userError({code:'network'},'原消息暂未加载'),'原消息暂未加载');
 assert.doesNotMatch(userError({status:500}),/连接|网络/);
});
test('permission, missing content and programming failures do not start network retries',()=>{
 for(const status of [401,403,404])assert.equal(isRetryableFailure({status,code:'authority_request_rejected'}),false);
 assert.equal(isRetryableFailure(new TypeError('invalid internal value')),false);assert.equal(isRetryableFailure(new TypeError('Failed to fetch')),true);assert.equal(isRetryableFailure({status:503}),true);
});
test('empty recovery feedback never creates a toast and real action errors leave after 2.4 seconds',t=>{
 t.mock.timers.enable({apis:['setTimeout']});setActivePinia(createPinia());const ui=useUiStore();ui.toast('',true);assert.equal(ui.toasts.length,0);ui.toast('原消息暂未加载',true);assert.equal(ui.toasts.length,1);t.mock.timers.tick(2400);assert.equal(ui.toasts.length,0);t.mock.timers.reset();
});


test('recovery clears only transient error toasts; leaving a page clears errors without hiding success',t=>{
 t.mock.timers.enable({apis:['setTimeout']});setActivePinia(createPinia());const ui=useUiStore();ui.reportError({status:503},'工作暂未更新');ui.reportError({status:403});ui.toast('已复制');assert.equal(ui.toasts.length,2);ui.clearErrors(true);assert.equal(ui.toasts.filter(t=>t.error).length,1);ui.reportError({code:'network'},'原消息暂未加载');assert.equal(ui.toasts.some(t=>t.recoverable),true);ui.clearErrors(true);assert.equal(ui.toasts.some(t=>t.recoverable),false);ui.clearErrors();assert.equal(ui.toasts.filter(t=>t.error).length,0);t.mock.timers.reset();
});

test('late feedback cannot reappear after its page or account scope ends',t=>{t.mock.timers.enable({apis:['setTimeout']});setActivePinia(createPinia());const ui=useUiStore(),old=ui.captureFeedback();ui.clearErrors();old.reportError({status:503},'旧页面错误');old.toast('迟到提示');assert.equal(ui.toasts.length,0);const live=ui.captureFeedback();live.reportError({status:403});assert.equal(ui.toasts.length,1);t.mock.timers.reset();});
