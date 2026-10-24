// Loopback fixture only. Seed real chat repository with simulated members.
import {createLocalScenario} from './reconstruction-local.mjs';
import {createGateway} from '../server/gateway.mjs';
import {PROJECT} from '../server/business/native-authority.mjs';
import {resolve} from 'node:path';
import {readFileSync} from 'node:fs';
export function startQuoteReturnPreview(port=5261,seed=()=>({}),{host='127.0.0.1',scenarioOptions={}}={}){
 const scenario=createLocalScenario(scenarioOptions),{repository,db}=scenario;
 const ctx={actor_id:'sim-b',display_name:'模拟成员 B',project_id:PROJECT,can_read:true,can_write:true};
 const members=['sim-a','sim-b','sim-m'].map(actor_id=>({actor_id,can_read:true}));
 const send=(body,key)=>repository.send(ctx,body,'quote-fixture-'+key,{members}).message;
 const original=send({body:'昨天的原始内容'},'original');
 db.prepare('UPDATE messages SET created_at=? WHERE id=?').run(Date.now()-86400000,original.id);
 for(let i=0;i<155;i++)send({body:'历史消息 '+i},'history-'+i);
 const quoted=send({body:'引用返回验证',reply_to_id:original.id},'quoted');
 send({body:'嵌套引用验证',reply_to_id:quoted.id},'nested');
 const recalled=send({body:'稍后撤回的原内容'},'recalled');
 send({body:'撤回引用验证',reply_to_id:recalled.id},'recalled-reply');
 db.prepare('UPDATE messages SET recalled_at=? WHERE id=?').run(Date.now(),recalled.id);
 const hidden=send({body:'不可见的原内容'},'hidden');
 send({body:'不可见引用验证',reply_to_id:hidden.id},'hidden-reply');
 db.prepare('INSERT INTO message_hides(actor_id,message_id,hidden_at) VALUES(?,?,?)').run('sim-a',hidden.id,Date.now());
 const extra=seed({scenario,ctx,members});
 const origin='http://'+host+':'+port;
 const server=createGateway({root:resolve('dist'),publicOrigin:origin,fetcher:scenario.fetcher,businessHandler:scenario.businessHandler});
 const handler=server.listeners('request')[0];server.removeAllListeners('request');
 server.on('request',(req,res)=>{
  const path=new URL(req.url,origin).pathname;
  if(path==='/native/session'){
   const actor=/simulation_member=(sim-[abm])/.exec(req.headers.cookie||'')?.[1];res.writeHead(actor?200:401,{'content-type':'application/json'});
   res.end(JSON.stringify(actor?{identity:{actor_id:actor,member_label:actor},user:{name:actor},cache_partition:{actor_id:actor},persistent_login:true}:{error_code:'login_required'}));return;
  }
  if(path==='/updates/android/latest.json'){
   const release=readFileSync('src/app/release.ts','utf8');res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({versionCode:Number(/versionCode:\s*(\d+)/.exec(release)[1]),versionName:/versionName:\s*'([^']+)'/.exec(release)[1]}));return;
  }
  const match=/^\/simulation\/(sim-[abm])$/.exec(path);if(match){res.writeHead(302,{'set-cookie':`simulation_member=${match[1]}; HttpOnly; SameSite=Lax; Path=/`,location:'/#/chat'});res.end();return;}
  handler(req,res);
 });
 server.on('close',()=>scenario.close());server.listen(port,'127.0.0.1');return {server,original,quoted,...extra};
}
