import https from 'node:https';
import webpush from './web-push.bundle.cjs';
// Own the HTTP lifecycle. A socket inactivity timeout cannot bound a trickling
// response, and ending the caller's wait must also close the old request.
export function sendBoundedWebPush(subscription,payload,options){
 const details=webpush.generateRequestDetails(subscription,payload,options);
 return new Promise((resolve,reject)=>{
  let request,response,finished=false;
  const ownAgent=details.proxy?new webpush.WebPushProxyAgent(details.proxy):null;
  const finish=(error,value)=>{if(finished)return;finished=true;clearTimeout(timer);if(error){response?.destroy();request?.destroy();}ownAgent?.destroy();error?reject(error):resolve(value);};
  const timer=setTimeout(()=>finish(Object.assign(Error('push_total_deadline'),{code:'ETIMEDOUT'})),options.timeout||15000);
  try{
   const url=new URL(details.endpoint);
   request=https.request({hostname:url.hostname,port:url.port||443,path:url.pathname+url.search,headers:details.headers,method:details.method,agent:ownAgent||details.agent,timeout:options.timeout||15000},incoming=>{
    response=incoming;let bytes=0;
    incoming.on('error',error=>finish(error));incoming.on('aborted',()=>finish(Object.assign(Error('push_response_aborted'),{code:'ECONNRESET'})));
    incoming.on('data',chunk=>{bytes+=chunk.length;if(bytes>16384)finish(Object.assign(Error('push_response_limit'),{code:'ECONNRESET'}));});
    incoming.on('end',()=>{const status=incoming.statusCode||0;if(status<200||status>299)finish(Object.assign(Error('push_provider_rejected'),{statusCode:status}));else finish(null,{statusCode:status});});
   });
   request.on('error',error=>finish(error));request.on('timeout',()=>finish(Object.assign(Error('push_socket_timeout'),{code:'ETIMEDOUT'})));
   if(details.body)request.write(details.body);request.end();
  }catch(error){finish(error);}
 });
}
