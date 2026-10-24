// Isolated real WAV acquisition/playback faults; synthetic data, no recording/ASR.
import {startQuoteReturnPreview} from './quoteReturn.preview.mjs';
const port=Number(process.env.QN_VOICE_PLAYBACK_PORT||5419),origin='http://quote-check.localhost:'+port;
const fixture=startQuoteReturnPreview(port,()=>({}),{host:'quote-check.localhost'});
const handler=fixture.server.listeners('request')[0];fixture.server.removeAllListeners('request');
let mode='normal';const requests=[],held=[];
fixture.server.on('request',(req,res)=>{
 const u=new URL(req.url,origin);
 if(u.pathname==='/simulation/voice-control'){
  const next=u.searchParams.get('mode');if(next==='release'){mode='normal';for(const f of held.splice(0))f();}else if(next)mode=next;
  res.writeHead(200,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify({scope:'local synthetic WAV playback only',mode,held:held.length,requests}));return;
 }
 if(u.pathname==='/native/file'){
  const id=u.searchParams.get('material_id');requests.push({id,mode});
  if(id==='5c7590ca-d4f2-4055-ab1d-239e6b7cfc93'){
   if(mode==='fail-once'){mode='normal';res.writeHead(503,{'content-type':'application/json'});res.end(JSON.stringify({error_code:'synthetic_voice_source_unavailable'}));return;}
   if(mode==='hold'){held.push(()=>{if(!res.destroyed)handler(req,res);});return;}
  }
 }
 handler(req,res);
});
console.log('SYNTHETIC VOICE PLAYBACK '+origin+'/simulation/sim-a');
const stop=()=>{fixture.server.closeAllConnections();fixture.server.close(()=>process.exit(0));};process.on('SIGINT',stop);process.on('SIGTERM',stop);
