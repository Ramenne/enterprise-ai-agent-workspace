import type {FastifyInstance} from 'fastify';
export function registerMcpReadiness(app:FastifyInstance,urls:Record<'hufu'|'mem'|'v8',string>,semantic_url?:string,url_import_url?:string){
 app.get('/ready',async(_request,reply)=>{
  const dependencies=await Promise.all(Object.entries(urls).map(async([name,url])=>{
   try{const response=await fetch(new URL('/ready',url),{signal:AbortSignal.timeout(3000)});const result=await response.json() as {state?:string;capabilities?:Record<string,string>};return {name,ready:response.ok&&result.state==='ready',capabilities:result.capabilities??{}};}
   catch{return {name,ready:false,capabilities:{dependency:'unavailable'}};}
  }));
  const ready=dependencies.every(x=>x.ready);reply.code(ready?200:503);
  return {state:ready?'ready':'degraded',dependencies:Object.fromEntries(dependencies.map(x=>[x.name,{state:x.ready?'ready':'unavailable',capabilities:x.capabilities}])),
   optional_capabilities:{semantic:{state:semantic_url?'configured_check_on_call':'unconfigured',affects_core_ready:false},url_import:{state:url_import_url?'configured_check_on_call':'unconfigured',affects_core_ready:false}},
   coverage:'transport_and_domain_database;individual_capabilities_reported_separately'};
 });
}
