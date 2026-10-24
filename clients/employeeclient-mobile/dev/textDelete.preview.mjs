// Disposable loopback-only sample for exact text copy and personal-hide recovery.
import {startQuoteReturnPreview} from './quoteReturn.preview.mjs';
const longText='C09 原文开始 🐦\n第一段：保留中文、emoji 👩‍💻 和两个空格  。\n\n链接 https://example.com/path?q=employeeclient&n=1\n'+Array.from({length:24},(_,i)=>`第${String(i+1).padStart(2,'0')}行：全文阅读需要保留换行与顺序。`).join('\n')+'\nC09 原文结束';
const f=startQuoteReturnPreview(5408,({scenario,ctx,members})=>{
 const send=(body,key)=>scenario.repository.send(ctx,{body},key,{members}).message;
 const first=send(longText,'text-delete-long'),second=send('C09 第二条\n\n多选拼接保留段落','text-delete-second'),third=send('C10 第三条：部分删除失败恢复','text-delete-third');
 return {sample:[first,second,third]};
},{host:'quote-check.localhost'});
const metrics=[];let hides=0,failOnce=true;
const handler=f.server.listeners('request')[0];f.server.removeAllListeners('request');
f.server.on('request',(req,res)=>{
 if(req.url==='/simulation/text-delete'){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({scope:'disposable synthetic loopback',sample:f.sample,metrics}));return;}
 if(req.method==='POST'&&/^\/business\/v1\/messages\/[^/]+\/hide$/.test(req.url)){
  hides++;const shouldFail=failOnce&&hides===2,end=res.end.bind(res);
  res.end=(chunk,...args)=>{let value;try{value=JSON.parse(String(chunk));}catch{}metrics.push({url:req.url,status:res.statusCode,id:value?.message?.id,hidden:value?.message?.hidden,key:req.headers['idempotency-key']});if(shouldFail&&res.statusCode===200){failOnce=false;res.statusCode=503;chunk=JSON.stringify({error_code:'synthetic_receipt_unavailable'});}return end(chunk,...args);};
 }
 handler(req,res);
});
console.log('Disposable C09/C10 http://quote-check.localhost:5408/simulation/sim-a');
const stop=()=>{f.server.closeAllConnections();f.server.close(()=>process.exit(0));};process.on('SIGINT',stop);process.on('SIGTERM',stop);
