import {EventEmitter} from 'node:events';
import {createHash} from 'node:crypto';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
// One DB connection per service process. Signals contain no material/body data;
// each subscriber obtains its own newly authorized projection after the signal.
export function projectSignals(pool){
 const events=new EventEmitter();events.setMaxListeners(0);
 let connection=null,opening=null,closed=false;
 const fail=()=>{if(connection){const c=connection;connection=null;c.release(true);}events.emit('unavailable');};
 const connect=()=>closed?Promise.reject(Error('event_source_closed')):connection?Promise.resolve():opening||(opening=(async()=>{
  if(closed)throw Error('event_source_closed');
  const c=await pool.connect();
  try{await c.query('LISTEN hub2_project_commits');if(closed)throw Error('event_source_closed');
   connection=c;c.on('error',()=>{if(connection===c)fail();});c.on('end',()=>{if(connection===c)fail();});
   c.on('notification',n=>{if(n.channel!=='hub2_project_commits')return;let x;try{x=JSON.parse(n.payload);}catch{return;}if(uuid.test(x?.project_id||''))events.emit(x.project_id);});
  }catch(e){if(connection!==c)c.release(true);throw e;}
 })().finally(()=>{opening=null;}));
 return {
  async subscribe(project,onChange,onUnavailable){await connect();if(!connection)throw Error('event_source_unavailable');events.on(project,onChange);events.on('unavailable',onUnavailable);return()=>{events.off(project,onChange);events.off('unavailable',onUnavailable);};},
  close(){closed=true;fail();events.removeAllListeners();}
 };
}
export function installProjectEventStream(app,pool,{snapshot,authorize,heartbeatMs=30000}){
 const signals=projectSignals(pool),active=new Map();
 app.addHook('onClose',async()=>signals.close());
 app.get('/v2/changes/events',{logLevel:'silent'},async(req,reply)=>{
  const project=req.query?.project_id;
  if(!uuid.test(project||'')||Object.keys(req.query||{}).some(k=>k!=='project_id'))return reply.code(400).send({state:'failed',error_code:'invalid_input'});
  const authorization=req.headers.authorization;
  const key=hash([authorization,project]);if((active.get(key)||0)>=2)return reply.code(429).send({state:'failed',error_code:'event_connection_limit'});
  active.set(key,(active.get(key)||0)+1);
  let off,timer,closed=false,busy=false,pending=false,last=null,started=false;
  const res=reply.raw;
  const projectionHash=view=>hash([...(view.aggregates||[])].sort((a,b)=>(a.domain+':'+a.aggregate_id).localeCompare(b.domain+':'+b.aggregate_id)));
  const close=()=>{if(closed)return;closed=true;off?.();clearInterval(timer);const n=(active.get(key)||1)-1;if(n)active.set(key,n);else active.delete(key);if(started&&!res.writableEnded)res.end();};
  const write=async(type,data)=>{
   if(closed||res.destroyed)return;
   const frame='event: '+type+'\ndata: '+JSON.stringify(data)+'\n\n';
   if(Buffer.byteLength(frame)>2*1024*1024)throw Error('event_projection_too_large');
   if(!res.write(frame))await new Promise(resolve=>{const done=()=>{res.off('drain',done);res.off('close',done);resolve();};res.once('drain',done);res.once('close',done);});
  };
  const stop=async e=>{try{if(started)await write([401,403].includes(e.status??e.statusCode)?'auth':'error',{status:e.status??e.statusCode??503,error_code:'event_subscription_unavailable'});}finally{close();}};
  const sync=async()=>{
   if(closed)return;if(!started||busy){pending=true;return;}busy=true;
   try{do{pending=false;const view=await snapshot(req,project);if(closed)return;const digest=projectionHash(view);
    if(last!==digest){await write('snapshot',{...view,project_id:project,projection_digest:digest,complete_projection:true});last=digest;}
   }while(pending&&!closed);}catch(e){await stop(e);}finally{busy=false;}
  };
  try{
   // Subscribe first, then validate/read: a transaction committing while the
   // initial read runs will schedule a second read rather than disappear.
   off=await signals.subscribe(project,()=>void sync(),()=>void stop(Error('event_source_unavailable')));
   const initial=await snapshot(req,project);if(closed)return;
   reply.hijack();started=true;res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-store','x-accel-buffering':'no'});res.once('close',close);
   await write('ready',{project_id:project,transport:'transaction_commit_signal;authorized_snapshot'});
   await write('snapshot',{...initial,project_id:project,projection_digest:projectionHash(initial),complete_projection:true});last=projectionHash(initial);
   if(pending)void sync();
   timer=setInterval(()=>{if(!busy)void authorize(req,project).then(()=>write('ping',{})).catch(stop);},heartbeatMs);timer.unref?.();
  }catch(e){if(started)await stop(e);else{close();return reply.code(e.status??e.statusCode??503).send({state:'failed',error_code:'event_subscription_unavailable'});}}
 });
}
