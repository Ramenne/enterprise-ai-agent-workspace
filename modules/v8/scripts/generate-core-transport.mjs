import{stripTypeScriptTypes}from'node:module';import{readFile,writeFile,mkdir}from'node:fs/promises';import{createHash}from'node:crypto';import{z}from'zod';
const root=new URL('../',import.meta.url),path='apps/v8/src/core-contracts.ts',source=await readFile(new URL(path,root),'utf8'),sha256=createHash('sha256').update(source).digest('hex');
const code=stripTypeScriptTypes(source).replace(/from\s+(['"])zod\1/, 'from '+JSON.stringify(import.meta.resolve('zod')));
const domain=await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));
let removedDefaults=0;
function inputOnly(schema){if(Array.isArray(schema))return schema.map(inputOnly);if(!schema||typeof schema!=='object')return schema;const out={};for(const[k,v]of Object.entries(schema)){if(k==='default'){removedDefaults++;continue;}out[k]=['properties','patternProperties','$defs','definitions'].includes(k)?Object.fromEntries(Object.entries(v).map(([name,definition])=>[name,inputOnly(definition)])):inputOnly(v);}return out;}
const contracts=domain.schemas.map(([path,command,action,schema])=>({method:'POST',path,command,action,input_schema:inputOnly(z.toJSONSchema(schema,{io:'input'}))}));
contracts.push(...domain.supplementalTransportContracts.map(([path,schema])=>({method:'POST',path,input_schema:inputOnly(z.toJSONSchema(schema,{io:'input'}))})));
const origin={owner:'v8',project_id:'4e14ec27-e8b0-4d2e-a106-489c25efc29d',path,sha256,projection:'domain-input-without-default-injection-v1',removed_defaults:removedDefaults,maintenance:'generated; edit the domain contract and regenerate, never edit the consumer copy'};
const text=JSON.stringify({origin,contracts},null,2)+'\n',target=new URL('generated/mcp/v8-core.json',root);await mkdir(new URL('generated/mcp/',root),{recursive:true});if(process.argv.includes('--check')){if(await readFile(target,'utf8')!==text)throw Error('core_transport_requires_regeneration');}else await writeFile(target,text);
console.log(JSON.stringify({state:process.argv.includes('--check')?'verified':'generated',routes:contracts.length,removed_defaults:removedDefaults,source_sha256:sha256}));
