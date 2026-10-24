// Loopback-only verification of the production IndexedDB writer with real Vue
// proxies. Reloading the page discards all in-memory caches, not stored data.
import http from 'node:http';
import {build} from 'esbuild';
const result=await build({stdin:{resolveDir:process.cwd(),loader:'ts',contents:`
import {reactive} from 'vue';
import {createHubCache} from './src/native/hub-cache.mjs';
import {metaGet,metaSet,metaRemove,putMany,getAllByAccount} from './src/session/db';
const a='qn-cache-selftest-a',lease={account:a,epoch:1,valid:()=>true};
const show=s=>{const p=document.createElement('p');p.textContent=s;document.querySelector('main').append(p);};
const assert=(v,s)=>{if(!v)throw Error(s);show('通过：'+s);};
const cache=createHubCache({get:metaGet,put:metaSet,remove:metaRemove});
async function run(){
 if(!await metaGet(a,'ready')){
  const project=reactive({properties:{attributes:{category:'协作'}}});
  await cache.read(lease,'catalog:work:selftest',async()=>({rows:[{short_no:1000133,projectProperties:project.properties}]}));
  await metaSet(a,'view',reactive({project:'selftest',query:'#1000133',selected:{state:'active'}}));
  await putMany('notifications',a,[reactive({id:'qn-cache-selftest-notification',snapshot:{title:'缓存验证'}})]);
  await metaSet(a,'ready',true);show('首次写入完成：工作、属性、筛选和通知已提交至实际 IndexedDB。');
  const button=document.createElement('button');button.textContent='重新打开应用';button.onclick=()=>location.reload();document.querySelector('main').append(button);return;
 }
 let calls=0;
 const rows=await cache.read(lease,'catalog:work:selftest',async()=>{calls++;throw Error('cached work should not require network');});
 assert(rows.rows[0].short_no===1000133&&rows.rows[0].projectProperties.attributes.category==='协作','新页面从数据库恢复工作和真实属性');
 assert(calls===0,'页面重启后无需重新获取整份工作');
 const view=await metaGet(a,'view');assert(view.query==='#1000133'&&view.selected.state==='active','搜索词和筛选跨页面重启保留');
 const notices=await getAllByAccount('notifications',a);assert(notices[0].snapshot.title==='缓存验证','嵌套通知数据实际落盘并恢复');
 const foreign=await getAllByAccount('notifications','qn-cache-selftest-b');assert(foreign.length===0,'另一账号看不到本人的缓存');
 document.querySelector('h1').textContent='持久缓存验证通过';
}
run().catch(e=>{document.querySelector('h1').textContent='验证失败';show(e.message);});
`},bundle:true,write:false,format:'esm',define:{'process.env.NODE_ENV':'"production"'}});
const script=result.outputFiles[0].text;
http.createServer((req,res)=>{
 res.setHeader('cache-control','no-store');
 if(req.url==='/test.js'){res.setHeader('content-type','text/javascript');res.end(script);return;}
 res.setHeader('content-type','text/html; charset=utf-8');res.end('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><style>body{font:16px/1.6 system-ui;margin:24px;color:#20242b}button{font:inherit;padding:10px}p{padding:8px;background:#edf6ef;border-radius:6px}</style><main><h1>真实本地数据库验证</h1></main><script type="module" src="/test.js"></script>');
}).listen(5186,'127.0.0.1',()=>console.log('LOCAL TEST ONLY http://127.0.0.1:5186'));
