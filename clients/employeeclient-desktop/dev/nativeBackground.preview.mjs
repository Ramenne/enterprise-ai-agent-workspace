// Dedicated Android native-service acceptance. Loopback only; simulated identity; actual event repository/runtime.
import {createServer} from 'node:http';import {createLocalScenario} from './reconstruction-local.mjs';import {createNotificationEvents} from '../server/business/notification-events.mjs';
const scenario=createLocalScenario(),members=['sim-a','sim-b','sim-m'].map(actor_id=>({actor_id,can_read:true,can_write:true})),ctx=actor_id=>({actor_id,display_name:actor_id,project_id:'ad44cc0e-159e-4e0f-a5ca-73d3920240d9',can_read:true,can_write:true});let sequence=0,connections=0,rejectOnce=false;const streams=new Set(),seenCursors=[];
const events=createNotificationEvents(async cookie=>{if(!cookie.includes('simulation_member=sim-a')&&!cookie.includes('qn_member_device=LocalSyntheticCredential0001'))throw Object.assign(Error('fixture_identity_required'),{status:401});return ctx('sim-a');},scenario.repository,{heartbeatMs:1000});
const json=(res,data,status=200)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(data));};
const server=createServer(async(req,res)=>{try{const url=new URL(req.url,'http://localhost');
 if(url.pathname==='/native/session')return json(res,{identity:{actor_id:'sim-a'},persistent_login:true});
 if(url.pathname==='/business/v1/events'){connections++;seenCursors.push(url.searchParams.get('after_version'));if(rejectOnce){rejectOnce=false;return json(res,{error_code:'fixture_stream_recheck'},401);}streams.add(res);res.on('close',()=>streams.delete(res));return await events.handle(req,res);}
 if(url.pathname==='/qa/emit'){const id=++sequence;const receipt=scenario.repository.send(ctx('sim-b'),{body:'仅本机后台验证 '+id,mention_usernames:[]},'native-qa-'+id,{members});events.changed({actors:['sim-a'],message_kind:'chat_message',message_participants:['sim-b','sim-a']});return json(res,{message_id:receipt.message.id,...scenario.repository.notifications(ctx('sim-a'),0,100)});}
 if(url.pathname==='/qa/disconnect'){for(const stream of streams)stream.destroy();return json(res,{closed:true});}
 if(url.pathname==='/qa/reject-once'){rejectOnce=true;for(const stream of streams)stream.destroy();return json(res,{reject_once:true});}
 if(url.pathname==='/qa/state')return json(res,{connections,active:streams.size,seenCursors,...scenario.repository.notifications(ctx('sim-a'),0,100)});
 return json(res,{error_code:'fixture_path_only'},404);
 }catch(e){if(!res.headersSent)json(res,{error_code:e.code||e.message},e.status||500);else res.destroy();}});
server.listen(5345,'127.0.0.1',()=>console.log('LOCAL ANDROID SERVICE FIXTURE 127.0.0.1:5345'));
