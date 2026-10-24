import{readFile,writeFile}from'node:fs/promises';import{stripTypeScriptTypes}from'node:module';import{createHash}from'node:crypto';
const source=await readFile(new URL('../../../apps/mcp/src/tools.ts',import.meta.url),'utf8');
const {tools}=await import('data:text/javascript;base64,'+Buffer.from(stripTypeScriptTypes(source)).toString('base64'));
const used=new Set();const usecaseHashes={};
for(const name of ['document','workflows','material-govern','material-maintenance']){const text=await readFile(new URL('./application/'+name+'.mjs',import.meta.url),'utf8');usecaseHashes[name]=createHash('sha256').update(text).digest('hex');for(const m of text.matchAll(/invoke(?:Next)?\((?:auth,)?'([^']+)'/g))used.add(m[1]);}
const routes=Object.fromEntries(tools.filter(t=>used.has(t.name)).map(({name,service,method,path,readOnly,pathParameter,endpointKey})=>[name,{service,method,path,readOnly,...(pathParameter?{pathParameter}:{}),...(endpointKey?{endpointKey}:{})}]));
const text=JSON.stringify({generated_from:'apps/mcp/src/tools.ts',usecase_sha256:usecaseHashes,source_sha256:createHash('sha256').update(source).digest('hex'),routes},null,2)+'\n';
const target=new URL('./application/domain-routes.json',import.meta.url);
if(process.argv.includes('--check')){if(await readFile(target,'utf8')!==text)throw Error('domain_routes_require_generation');}else await writeFile(target,text);
console.log(JSON.stringify({state:process.argv.includes('--check')?'verified':'generated',routes:Object.keys(routes).length}));
