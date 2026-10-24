// Local UI scenario only: simulated members, in-memory business data, no OTP,
// persistent identity service, production credentials or production writes.
import {startLocal} from './reconstruction-local.mjs';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
export function startWechatChatPreview(port=5245) {
  const server=startLocal(port),handler=server.listeners('request')[0];
  server.removeAllListeners('request');
  server.on('request',(req,res)=>{
    const path=new URL(req.url,'http://127.0.0.1').pathname;
    if(path==='/native/session'){
      const actor=/simulation_member=(sim-[abmu])/.exec(req.headers.cookie||'')?.[1];
      res.writeHead(actor?200:401,{'content-type':'application/json','cache-control':'no-store'});
      res.end(JSON.stringify(actor?{identity:{actor_id:actor,member_label:'模拟成员 '+actor},user:{name:'模拟成员 '+actor},cache_partition:{actor_id:actor},persistent_login:true}:{error_code:'login_required'}));return;
    }
    if(path==='/updates/android/latest.json'){
      const release=readFileSync('src/app/release.ts','utf8');
      res.writeHead(200,{'content-type':'application/json','cache-control':'no-store'});
      res.end(JSON.stringify({versionCode:Number(/versionCode:\s*(\d+)/.exec(release)[1]),versionName:/versionName:\s*'([^']+)'/.exec(release)[1]}));return;
    }
    handler(req,res);
  });
  return server;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))startWechatChatPreview();
