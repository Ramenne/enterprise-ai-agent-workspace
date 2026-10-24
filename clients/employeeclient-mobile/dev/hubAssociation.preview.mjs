// Loopback-only current native source with controlled directory/catalogue errors.
import {createLocalScenario} from './reconstruction-local.mjs';
import {createGateway} from '../server/gateway.mjs';
import {resolve} from 'node:path';
const port=Number(process.env.QN_HUB_PORT||5397),origin='http://hub-check.localhost:'+port;
const scenario=createLocalScenario(),calls=[];
let failDirectory=true,failCatalog=false;
const fetcher=async(url,options)=>{
 const path=new URL(url).pathname;
 if(path.endsWith('/projects/search')||path.endsWith('/work-items/search')){
  const directory=path.endsWith('/projects/search'),failed=directory?failDirectory:failCatalog;
  calls.push({path,failed});
  if(failed){if(directory)failDirectory=false;else failCatalog=false;return new Response(JSON.stringify({error_code:'unavailable'}),{status:503,headers:{'content-type':'application/json'}});}
 }
 return scenario.fetcher(url,options);
};
const server=createGateway({root:resolve('dist'),publicOrigin:origin,fetcher,businessHandler:scenario.businessHandler});
const handler=server.listeners('request')[0];server.removeAllListeners('request');
server.on('request',(req,res)=>{
 const url=new URL(req.url,origin);
 if(url.pathname==='/simulation/hub-control'){
  if(url.searchParams.get('mode')==='fail-directory')failDirectory=true;
  if(url.searchParams.get('mode')==='fail-catalog')failCatalog=true;
  res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({scope:'synthetic loopback only',calls}));return;
 }
 if(url.pathname==='/native/session'){
  res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({identity:{actor_id:'sim-a',member_label:'模拟成员 A'},cache_partition:{actor_id:'sim-a'},persistent_login:true}));return;
 }
 if(url.pathname==='/simulation/sim-a'){
  res.writeHead(302,{'set-cookie':'simulation_member=sim-a; HttpOnly; SameSite=Lax; Path=/',location:'/#/chat'});res.end();return;
 }
 handler(req,res);
});
server.listen(port,'127.0.0.1',()=>console.log('SYNTHETIC ONLY '+origin+'/simulation/sim-a'));
server.on('close',()=>scenario.close());
const stop=()=>{server.closeAllConnections();server.close(()=>process.exit(0));};
process.on('SIGTERM',stop);process.on('SIGINT',stop);
