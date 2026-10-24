// Local PWA old/new shell switch; original business fixture and synthetic users.
import {startMediaForwardPreview} from './mediaForward.preview.mjs';
import {resolve,extname} from 'node:path';
import {readFileSync} from 'node:fs';
const base=resolve('/Users/developer/Downloads/超强学习/research/employeeclient-chain-research-20261015');
const roots={old:resolve(base,'candidate-r9/pwa'),next:resolve(base,'candidate-r10/pwa')};let current='old',holdMedia=false,held=null;const visits=[],mediaAttempts=[];
const server=startMediaForwardPreview(Number(process.env.QN_PWA_PORT||5415),{host:'transfer-check.localhost'}),handler=server.listeners('request')[0];server.removeAllListeners('request');
server.on('request',(req,res)=>{
 const u=new URL(req.url,'http://transfer-check.localhost:5415'),path=u.pathname;
 if(path==='/simulation/pwa-control'){if(u.searchParams.get('mode')==='hold-media')holdMedia=true;if(u.searchParams.get('mode')==='release'&&held){const finish=held;held=null;finish();}if(u.searchParams.get('shell') in roots)current=u.searchParams.get('shell');res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({scope:'synthetic local PWA upgrade only',current,visits,held:!!held,mediaAttempts}));return;}
 if(path==='/simulation/pwa-diagnostics'){
  res.writeHead(200,{'content-type':'text/html','cache-control':'no-store'});res.end(`<!doctype html><meta charset="utf-8"><title>员工客户端 PWA 本机诊断</title><h1>本机 PWA 状态</h1><pre id="status">正在读取</pre><button id="check">重新读取状态</button><button id="update">检查应用壳更新</button><a href="/#/chat">返回本机员工客户端</a><script>
 async function read(){let result={serviceWorkerSupported:'serviceWorker' in navigator,secureContext:isSecureContext};try{if(result.serviceWorkerSupported){const r=await navigator.serviceWorker.getRegistration();result.registration=!!r;result.active=r?.active?.state;result.waiting=r?.waiting?.state;result.controller=navigator.serviceWorker.controller?.scriptURL;}}catch(e){result.error=e.message;}document.querySelector('#status').textContent=JSON.stringify(result,null,2);}
 document.querySelector('#check').onclick=read;document.querySelector('#update').onclick=async()=>{const r=await navigator.serviceWorker?.getRegistration();if(r)await r.update();await read();};read();</script>`);return;
 }
 if(req.method==='POST'&&path==='/business/v1/media-transfers'){
  const end=res.end.bind(res);res.end=(chunk,...args)=>{let parsed;try{parsed=JSON.parse(String(chunk));}catch{}mediaAttempts.push({status:res.statusCode,messageId:parsed?.message?.id,key:req.headers['idempotency-key']});if(holdMedia&&res.statusCode<300){holdMedia=false;held=()=>{if(!res.destroyed&&!res.writableEnded)end(chunk,...args);};return res;}return end(chunk,...args);};
 }
 if(req.method==='GET'&&(path==='/'||path==='/index.html'||path==='/sw.js'||path.startsWith('/assets/')||path.startsWith('/icons/')||path==='/manifest.webmanifest'||path==='/employeeclient.svg')){
  const name=path==='/'?'/index.html':path,file=resolve(roots[current],'.'+name);if(!file.startsWith(roots[current]+'/')){res.writeHead(403);res.end();return;}
  try{const bytes=readFileSync(file),mime={'.html':'text/html','.js':'application/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.webmanifest':'application/manifest+json'}[extname(file)]||'application/octet-stream';visits.push({shell:current,path,at:Date.now()});res.writeHead(200,{'content-type':mime,'cache-control':'no-store'});res.end(bytes);}catch{res.writeHead(404);res.end();}return;
 }
 handler(req,res);
});
console.log('LOCAL PWA http://transfer-check.localhost:'+(process.env.QN_PWA_PORT||5415)+'/simulation/sim-a');
const stop=()=>{server.closeAllConnections();server.close(()=>process.exit(0));};process.on('SIGINT',stop);process.on('SIGTERM',stop);
