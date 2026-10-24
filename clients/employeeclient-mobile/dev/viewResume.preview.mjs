// Dedicated read-state recovery: synthetic users/data, real HTTP/query/context.
import {startQuoteReturnPreview} from './quoteReturn.preview.mjs';
const port=Number(process.env.QN_VIEW_RESUME_PORT||5418);
const fixture=startQuoteReturnPreview(port,({scenario,ctx,members})=>{
 for(let i=0;i<260;i++)scenario.repository.send(ctx,{body:'恢复查找项 '+i},'resume-query-'+i,{members});
 const quoted=scenario.repository.send(ctx,{body:'恢复引用验证',reply_to_id:scenario.db.prepare("SELECT id FROM messages WHERE body='昨天的原始内容'").get().id},'resume-quote',{members}).message;
 return {resumeQuoted:quoted};
},{host:'quote-check.localhost'});
const handler=fixture.server.listeners('request')[0];fixture.server.removeAllListeners('request');const requests=[],held=[];let mode='normal';
fixture.server.on('request',(req,res)=>{
 const u=new URL(req.url,'http://quote-check.localhost:'+port);
 if(u.pathname==='/simulation/view-control'){const next=u.searchParams.get('mode');if(next==='release'){mode='normal';for(const run of held.splice(0))run();}else if(next)mode=next;res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({scope:'synthetic view resume only',mode,held:held.length,requests,original:fixture.original.id,quoted:fixture.resumeQuoted.id}));return;}
 if(u.pathname==='/simulation/pwa-diagnostics'){res.writeHead(200,{'content-type':'text/html','cache-control':'no-store'});res.end('<meta charset="utf-8"><h1>本机阅读恢复更新</h1><pre id="s"></pre><button id="u">检查应用壳更新</button><script>async function read(){const r=await navigator.serviceWorker.getRegistration();s.textContent=JSON.stringify({active:r?.active?.state,controller:navigator.serviceWorker.controller?.scriptURL});}u.onclick=async()=>{const r=await navigator.serviceWorker.getRegistration();await r?.update();await read();};read();</script>');return;}
 if(u.pathname.startsWith('/business/v1/messages')){
  requests.push({method:req.method,path:u.pathname,query:u.search});
  if(req.method==='GET'&&u.pathname==='/business/v1/messages'&&u.searchParams.has('before')){
   if(mode==='fail-once'){mode='normal';res.writeHead(503,{'content-type':'application/json'});res.end(JSON.stringify({error_code:'synthetic_resume_unavailable'}));return;}
   if(mode==='hold'){held.push(()=>{if(!res.destroyed)handler(req,res);});return;}
  }
 }
 handler(req,res);
});
console.log('SYNTHETIC RESUME http://quote-check.localhost:'+port+'/simulation/sim-a');
const stop=()=>{fixture.server.closeAllConnections();fixture.server.close(()=>process.exit(0));};process.on('SIGINT',stop);process.on('SIGTERM',stop);
