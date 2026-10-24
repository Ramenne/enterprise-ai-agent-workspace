// Synthetic loopback fixture for real HTTP/SQLite and UI recovery checks.
// The drop mode commits through the real business handler, then loses only its response.
import {startQuoteReturnPreview} from './quoteReturn.preview.mjs';
import {createHash} from 'node:crypto';
const port=Number(process.env.QN_RELIABILITY_PORT||5392);
const fixture=startQuoteReturnPreview(port);
const handler=fixture.server.listeners('request')[0];fixture.server.removeAllListeners('request');
const sends=[],held=[];let dropNext=false,holdChanges=false;
fixture.server.on('request',(req,res)=>{
 const url=new URL(req.url,'http://127.0.0.1:'+port);
 if(url.pathname==='/simulation/reliability-control'){
  const mode=url.searchParams.get('mode');
  if(mode==='drop-send-receipt')dropNext=true;
  if(mode==='hold-changes')holdChanges=true;
  if(mode==='release'){holdChanges=false;for(const run of held.splice(0))run();}
  if(mode==='clear')sends.splice(0);
  res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({scope:'synthetic loopback fixture only',dropNext,held:held.length,sends,original:fixture.original.id}));return;
 }
 if(req.method==='POST'&&url.pathname==='/business/v1/messages'){
  const end=res.end.bind(res);res.end=(chunk,...args)=>{
   let value;try{value=JSON.parse(String(chunk));}catch{}
   if(value?.message){
    const dropped=dropNext&&res.statusCode<300;if(dropped)dropNext=false;
    sends.push({actor:/simulation_member=(sim-[abm])/.exec(req.headers.cookie||'')?.[1],key_fingerprint:createHash('sha256').update(String(req.headers['idempotency-key']||'')).digest('hex'),status:res.statusCode,messageId:value.message.id,body:value.message.body,peer:value.message.conversation_peer||'',dropped});
    if(dropped){res.destroy();return res;}
   }
   return end(chunk,...args);
  };
 }
 if(holdChanges&&url.pathname==='/business/v1/messages/changes'){held.push(()=>{if(!res.destroyed)handler(req,res);});return;}
 handler(req,res);
});
console.log(JSON.stringify({state:'listening',origin:'http://127.0.0.1:'+port,scope:'synthetic loopback fixture only'}));
const stop=()=>{for(const run of held.splice(0))run();fixture.server.closeAllConnections();fixture.server.close(()=>process.exit(0));};
process.on('SIGINT',stop);process.on('SIGTERM',stop);
