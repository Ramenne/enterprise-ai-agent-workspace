import {request as httpRequest} from 'node:http';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {pipeline} from 'node:stream/promises';
import {createGateway} from './gateway-factory.mjs';

// One public entry; the existing notification/chat worker keeps its connections,
// database and jobs. This process opens no business database or model executor.
export function createNativeIngress({backendOrigin='http://127.0.0.1:8936',connectTimeoutMs=10000,responseTimeoutMs=10000,asrTimeoutMs=155000,mediaTimeoutMs=130000,requestTrace=null,traceWindowMs=30000,...gatewayOptions}={}) {
 const backend=new URL(backendOrigin);
 if(backend.protocol!=='http:'||backend.hostname!=='127.0.0.1'||backend.username||backend.password||backend.pathname!=='/'||backend.search||backend.hash)throw Error('Fixed loopback business backend required');
 const windows=new Map(),active=new Map();
 const traceTimer=requestTrace?setInterval(()=>{if(!windows.size)return;requestTrace({event:'qn_request_window',window_ms:traceWindowMs,routes:[...windows].map(([route,row])=>({route,...row,active:active.get(route)||0}))});windows.clear();},traceWindowMs):null;
 traceTimer?.unref();
 const observe=(req,res)=>{if(!requestTrace)return;const path=new URL(req.url,'http://localhost').pathname;if(!/^\/(native|business\/v1)\//.test(path))return;
  const route=path.replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi,':id').replace(/\/avatar$/, '/avatar').slice(0,140),started=Date.now();
  const row=windows.get(route)||{started:0,closed:0,statuses:{},short_stream_closes:0};row.started++;windows.set(route,row);active.set(route,(active.get(route)||0)+1);
  res.once('close',()=>{active.set(route,Math.max(0,(active.get(route)||0)-1));const next=windows.get(route)||{started:0,closed:0,statuses:{},short_stream_closes:0};next.closed++;next.statuses[res.statusCode]=(next.statuses[res.statusCode]||0)+1;if(route==='/business/v1/events'&&Date.now()-started<45000)next.short_stream_closes++;windows.set(route,next);});
 };
 const bridge=(req,res)=>{
  const headers={...req.headers,host:backend.host};
  for(const name of ['connection','proxy-connection','keep-alive','upgrade','te','trailer','proxy-authorization','proxy-authenticate'])delete headers[name];
  const upstream=httpRequest({hostname:'127.0.0.1',port:backend.port||80,path:req.url,method:req.method,headers},response=>{
   if(res.destroyed){response.destroy();return;}
   const output={...response.headers};
   for(const name of ['connection','keep-alive','transfer-encoding','upgrade'])delete output[name];
   res.writeHead(response.statusCode||502,output);
   void pipeline(response,res).catch(()=>{});
  });
  let connected=false;
  const path=req.url?.split('?')[0];
  const longASR=req.method==='POST'&&path==='/business/v1/voice-asr/start';
  const mediaTransfer=req.method==='POST'&&['/business/v1/media-transfers','/business/v1/integration/files/send'].includes(path);
  const timeout=setTimeout(()=>{if(!connected)upstream.destroy(Error('business_connect_timeout'));},connectTimeoutMs);timeout.unref();
  upstream.once('socket',socket=>{const ready=()=>{connected=true;clearTimeout(timeout);};if(socket.connecting)socket.once('connect',ready);else ready();});
  // A model request may legitimately outlive the TCP connection deadline.
  // Single-submit media has a 120s backend cap (body + provider + receipt).
  // Give it that budget plus transport margin; ordinary queries stay short.
  // SSE stays unbounded after headers arrive.
  const responseTimer=setTimeout(()=>upstream.destroy(Error('business_response_timeout')),longASR?asrTimeoutMs:mediaTransfer?mediaTimeoutMs:responseTimeoutMs);responseTimer.unref();
  upstream.once('response',()=>{clearTimeout(timeout);clearTimeout(responseTimer);});
  upstream.once('close',()=>{clearTimeout(timeout);clearTimeout(responseTimer);});
  upstream.once('error',()=>{clearTimeout(timeout);clearTimeout(responseTimer);if(res.destroyed)return;if(res.headersSent){res.destroy();return;}res.writeHead(503,{'content-type':'application/json','cache-control':'no-store'});res.end('{"error_code":"business_transport_failed"}');});
  req.once('aborted',()=>upstream.destroy());res.once('close',()=>upstream.destroy());
  void pipeline(req,upstream).catch(()=>{});
 };
 const gateway=createGateway({...gatewayOptions,businessHandler:bridge});
 const handle=gateway.listeners('request')[0];gateway.removeAllListeners('request');
 gateway.on('close',()=>clearInterval(traceTimer));
 gateway.on('request',(req,res)=>{observe(req,res);if(req.url?.split('?')[0]==='/health')bridge(req,res);else void handle(req,res);});
 return gateway;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const server=createNativeIngress({requestTrace:process.env.QN_TRACE_REQUESTS==='1'?record=>console.info(JSON.stringify(record)):null,persistentLoginEnabled:process.env.QN_PERSISTENT_MEMBER_LOGIN==='1',publicOrigin:process.env.QN_PUBLIC_ORIGIN||'https://employeeclient.example.invalid/',nativeOrigins:(process.env.QN_NATIVE_ORIGINS||'https://localhost,capacitor://localhost').split(',').filter(Boolean),root:resolve('pwa')});
 server.listen(Number(process.env.QN_PORT||8937),'127.0.0.1',()=>console.log('EmployeeClient native ingress ready'));
}
