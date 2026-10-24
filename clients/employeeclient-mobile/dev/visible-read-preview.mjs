// Loopback-only UI acceptance using the real notification repository/actions.
import {resolve} from 'node:path';
import {createGateway} from '../server/gateway.mjs';
import {PROJECT} from '../server/business/native-authority.mjs';
import {createLocalScenario} from './reconstruction-local.mjs';
const scenario=createLocalScenario(),port=5187,origin='http://127.0.0.1:'+port;
const ctx={actor_id:'sim-m',project_id:PROJECT,display_name:'模拟主管 M',can_read:true,can_write:true,can_publish_announcement:true};
const directory=['sim-a','sim-b','sim-m'].map(actor_id=>({actor_id,can_read:true}));
for(let i=0;i<10;i++)scenario.repository.publishAnnouncement(ctx,{title:'可见已读验证 '+(i+1),body:'本地通知。看到后消除未读；屏幕外保持未读，历史与独立确认保留。',recipient_usernames:['sim-a'],priority:'normal'},'visible-read-'+i,directory);
const gateway=createGateway({root:resolve('dist'),publicOrigin:origin,fetcher:scenario.fetcher,businessHandler:scenario.businessHandler});
const handler=gateway.listeners('request')[0];gateway.removeAllListeners('request');gateway.on('request',(req,res)=>{
 if(req.url==='/simulation/read-state'){
  const notices=[...new Map(scenario.repository.notifications({...ctx,actor_id:'sim-a'}).notifications.filter(n=>n.kind!=='chat_message').map(n=>[n.id,n])).values()];
  res.writeHead(200,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify({total:notices.length,read:notices.filter(n=>n.read_at).length,unread:notices.filter(n=>!n.read_at).length}));return;
 }
 const match=/^\/simulation\/(sim-[abmu])$/.exec(req.url||'');if(match){res.writeHead(302,{'set-cookie':`simulation_member=${match[1]}; HttpOnly; SameSite=Lax; Path=/`,location:'/#/work'});res.end();return;}
 handler(req,res);
});gateway.on('close',()=>scenario.close());gateway.listen(port,'127.0.0.1',()=>console.log('LOCAL VISIBLE READ CHECK '+origin));
