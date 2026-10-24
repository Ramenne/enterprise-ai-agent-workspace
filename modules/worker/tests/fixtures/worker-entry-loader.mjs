// Isolated adapters for the actual worker process entrypoint. No real credentials or DB connections.
import {registerHooks,stripTypeScriptTypes} from 'node:module';
import {readFileSync,existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
const serverURL=new URL('../../apps/worker/src/server.ts',import.meta.url).href;
const mockPg=String.raw`
let next=0;
class Pool {
 constructor(options){this.options=options;this.id=++next;this.ended=false;}
 on(){return this;}
 async query(sql,args){
  if(this.ended)throw Error('query_after_pool_end');
  const capability=/^SELECT ([a-z_]+\.[a-z_]+)\(/.exec(sql)?.[1]??'other';
  process.send?.({kind:'query',pool:this.id,max:this.options.max,capability});
  if(process.env.WORKER_TEST_MODE==='dispatch-fails'&&this.options.max===1)throw Error('synthetic dispatch failure');
  if(this.options.max===2&&capability==='evidence.dispatch_batch')throw Error('duplicate_dispatch_lane');
  return{rows:[{result:capability==='evidence.ready_tasks'?[]:{state:'ok',delivered:0}}]};
 }
 async end(){if(!this.ended){this.ended=true;process.send?.({kind:'pool_end',pool:this.id,max:this.options.max});}}
}
export {Pool};export default{Pool};
`;
const mockBoss=String.raw`
export class PgBoss {
 on(){return this;}
 async start(){process.send?.({kind:'queue_start'});if(process.env.WORKER_TEST_MODE==='queue-fails')throw Error('synthetic queue failure');return this;}
 async stop(){process.send?.({kind:'queue_stop'});}
 async supervise(){}
 async fetch(){return[];}
}
`;
registerHooks({
 resolve(specifier,context,next){
  if(specifier==='pg')return{url:'worker-test:pg',shortCircuit:true};
  if(specifier==='pg-boss')return{url:'worker-test:boss',shortCircuit:true};
  if(specifier==='./server.js'&&context.parentURL?.endsWith('/apps/worker/src/start.ts'))return{url:'worker-test:server',shortCircuit:true};
  try{return next(specifier,context);}catch(error){
   if(error.code!=='ERR_MODULE_NOT_FOUND'||!specifier.startsWith('.')||!specifier.endsWith('.js'))throw error;
   const url=new URL(specifier.slice(0,-3)+'.ts',context.parentURL);if(!existsSync(url))throw error;
   return{url:url.href,shortCircuit:true};
  }
 },
 load(url,context,next){
  if(url==='worker-test:pg')return{format:'module',shortCircuit:true,source:mockPg};
  if(url==='worker-test:boss')return{format:'module',shortCircuit:true,source:mockBoss};
  if(url==='worker-test:server')return{format:'module',shortCircuit:true,source:
   "import {createServer as original} from "+JSON.stringify(serverURL)+";export function createServer(){const app=original();app.addHook('onListen',async()=>{process.send?.({kind:'listening',port:app.server.address().port});});return app;}"};
  if(!url.endsWith('.ts'))return next(url,context);
  return{format:'module',shortCircuit:true,source:stripTypeScriptTypes(readFileSync(fileURLToPath(url),'utf8'),{mode:'transform',sourceUrl:url})};
 }
});
