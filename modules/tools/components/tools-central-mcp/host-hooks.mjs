import {createToolsAdapter} from './adapter.mjs';

// The central host supplies its existing authenticated request extractor.
// These callbacks are integration points, not a self-registering MCP server.
export function createToolsHooks({getCaller,adapter=createToolsAdapter()}={}){
 if(typeof getCaller!=='function')throw Error('host_authenticated_caller_extractor_required');
 return{
  prefix:adapter.prefix,
  async listTools(request){const caller=await getCaller(request);return(await adapter.catalog(caller)).tools;},
  async callTool(request,name,args={}){
   const caller=await getCaller(request),result=await adapter.invoke(caller,name,args);
   return{content:[{type:'text',text:JSON.stringify(result.value)}],structuredContent:result.value,isError:result.isError};
  }
 };
}
