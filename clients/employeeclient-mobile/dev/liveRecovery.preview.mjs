// Loopback SSE disconnect/reconnect probe, actual runtime/repository.
import {startQuoteReturnPreview} from './quoteReturn.preview.mjs';
const fixture=startQuoteReturnPreview(5412,()=>({}),{host:'quote-check.localhost'});
const handler=fixture.server.listeners('request')[0];fixture.server.removeAllListeners('request');
const streams=new Set(),attempts=[];let reject=false;
fixture.server.on('request',(req,res)=>{
 const url=new URL(req.url,'http://quote-check.localhost:5412');
 if(url.pathname==='/simulation/live-control'){
  if(url.searchParams.get('mode')==='disconnect'){reject=true;for(const stream of streams)stream.destroy();}
  if(url.searchParams.get('mode')==='restore')reject=false;
  res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({scope:'synthetic local SSE only',reject,active:streams.size,attempts}));return;
 }
 if(url.pathname==='/business/v1/events'){
  attempts.push({after:url.searchParams.get('after_version'),rejected:reject,at:Date.now()});
  if(reject){res.writeHead(503,{'content-type':'application/json'});res.end(JSON.stringify({error_code:'synthetic_event_unavailable'}));return;}
  streams.add(res);res.once('close',()=>streams.delete(res));
 }
 handler(req,res);
});
console.log('SYNTHETIC SSE http://quote-check.localhost:5412/simulation/sim-a');
const stop=()=>{fixture.server.closeAllConnections();fixture.server.close(()=>process.exit(0));};process.on('SIGINT',stop);process.on('SIGTERM',stop);
