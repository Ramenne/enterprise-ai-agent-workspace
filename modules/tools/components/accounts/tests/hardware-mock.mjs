import './mock-central.mjs';
const previous=globalThis.fetch;
globalThis.fetch=async(url,opts={})=>{if(String(url)==='https://hufu.example.invalid/mcp'){const b=JSON.parse(opts.body);if(b.params?.name==='v8.project.search')return Response.json({jsonrpc:'2.0',id:b.id,result:{structuredContent:{items:[{project_id:'69197d56-41b0-4c8b-ac19-181f63e87c1f',title:'工具'}],next_cursor:null}}})}return previous(url,opts)};
