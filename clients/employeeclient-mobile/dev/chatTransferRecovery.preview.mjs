// Synthetic loopback only. Commit real upload/message effects, then lose a response.
import {startMediaForwardPreview} from './mediaForward.preview.mjs';
import {createHash} from 'node:crypto';
const port=Number(process.env.QN_TRANSFER_PORT||5402),origin='http://transfer-check.localhost:'+port;
const server=startMediaForwardPreview(port,{host:'transfer-check.localhost'});
const handler=server.listeners('request')[0];server.removeAllListeners('request');
let dropUpload=false,dropMedia=false,skipMedia=0;const attempts=[];
server.on('request',(req,res)=>{
 const url=new URL(req.url,origin);
 if(url.pathname==='/simulation/transfer-control'){
  if(url.searchParams.get('mode')==='drop-upload')dropUpload=true;
  if(url.searchParams.get('mode')==='drop-media'){dropMedia=true;skipMedia=Math.max(0,Math.min(20,Number(url.searchParams.get('skip'))||0));}
  res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({scope:'synthetic loopback only',attempts}));return;
 }
 if(url.pathname==='/native/upload'||url.pathname==='/business/v1/media-transfers'||url.pathname==='/business/v1/messages'&&req.method==='POST'){
  let concealed=false,effectStatus;
  const writeHead=res.writeHead.bind(res);res.writeHead=(status,...args)=>{
   const upload=url.pathname==='/native/upload';effectStatus=status;
   const media=url.pathname==='/business/v1/media-transfers';
   if(status<300&&media&&dropMedia&&skipMedia>0)skipMedia--;
   else if(status<300&&(upload?dropUpload:media&&dropMedia)){concealed=true;if(upload)dropUpload=false;else dropMedia=false;status=503;}
   return writeHead(status,...args);
  };
  const end=res.end.bind(res);res.end=(chunk,...args)=>{
   let parsed;try{parsed=JSON.parse(String(chunk));}catch{}
   attempts.push({path:url.pathname,fileName:parsed?.message?.attachments?.[0]?.name||'',operation:url.searchParams.get('operation_id'),effectStatus,status:res.statusCode,concealed,messageId:parsed?.message?.id,error:parsed?.error_code,keyFingerprint:createHash('sha256').update(String(req.headers['idempotency-key']||'')).digest('hex')});
   if(concealed)return end(JSON.stringify({error_code:'confirmation_unavailable'}));return end(chunk,...args);
  };
 }
 handler(req,res);
});
console.log('SYNTHETIC ONLY '+origin+'/simulation/sim-a');
const stop=()=>{server.closeAllConnections();server.close(()=>process.exit(0));};
process.on('SIGINT',stop);process.on('SIGTERM',stop);
