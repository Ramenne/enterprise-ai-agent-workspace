// Disposable local fixture: isolated replies outside the initial history window.
import {startQuoteReturnPreview} from './quoteReturn.preview.mjs';
const port=5410;
const fixture=startQuoteReturnPreview(port,({scenario,ctx,members})=>{
 const original=scenario.repository.send(ctx,{body:'独立引用恢复原话'},'draft-recovery-original',{members}).message;
 const other=scenario.repository.send(ctx,{body:'另一条独立引用原话'},'draft-recovery-other',{members}).message;
 for(let i=0;i<80;i++)scenario.repository.send(ctx,{body:'独立引用恢复间隔 '+i},'draft-recovery-filler-'+i,{members});
 return {original,other};
},{host:'quote-check.localhost'});
const handler=fixture.server.listeners('request')[0];fixture.server.removeAllListeners('request');
let mode='normal',held=[];const requests=[];
fixture.server.on('request',(req,res)=>{
 const url=new URL(req.url,'http://quote-check.localhost:'+port);
 if(url.pathname==='/simulation/draft-reply-control'){
  const next=url.searchParams.get('mode');if(next==='release'){const pending=held;held=[];mode='normal';for(const run of pending)run();}else if(next)mode=next;
  res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({scope:'disposable local synthetic',original:fixture.original.id,other:fixture.other.id,mode,held:held.length,requests}));return;
 }
 if(req.method==='GET'&&[fixture.original.id,fixture.other.id].some(id=>url.pathname==='/business/v1/messages/'+id)){
  requests.push({path:url.pathname,mode});
  if(mode==='fail-once'){mode='normal';res.writeHead(503,{'content-type':'application/json'});res.end(JSON.stringify({error_code:'synthetic_lookup_unavailable'}));return;}
  if(mode==='hold'){held.push(()=>{if(!res.destroyed)handler(req,res);});return;}
 }
 handler(req,res);
});
console.log('SYNTHETIC ONLY http://quote-check.localhost:'+port+'/simulation/sim-a');
const stop=()=>{fixture.server.closeAllConnections();fixture.server.close(()=>process.exit(0));};process.on('SIGINT',stop);process.on('SIGTERM',stop);
