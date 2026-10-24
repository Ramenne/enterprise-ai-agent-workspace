import {readFile,writeFile,mkdir,copyFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=new URL('../../',import.meta.url),profile=JSON.parse(await readFile(new URL('runtime-profile.json',import.meta.url),'utf8'));
const source=new URL('source/',import.meta.url),target=new URL('dist/semantic-source/',root),files=[];
await mkdir(target,{recursive:true});
for(const name of profile.code_files){
 if(!['warm_service.py','semantic_adapter.py','input_contracts.py','model-manifest.json','export-result.json'].includes(name))throw Error('unexpected_semantic_source');
 const path=new URL(name,source),bytes=await readFile(path);
 if(name.endsWith('.py'))execFileSync('/usr/bin/python3',['-c','import pathlib,sys; p=pathlib.Path(sys.argv[1]); compile(p.read_text(),str(p),"exec")',fileURLToPath(path)]);
 else JSON.parse(bytes.toString('utf8'));
 await copyFile(path,new URL(name,target));files.push({path:profile.maintained_source+'/'+name,artifact:'dist/semantic-source/'+name,sha256:createHash('sha256').update(bytes).digest('hex')});
}
const contract=execFileSync('/usr/bin/python3',[fileURLToPath(new URL('input_contracts.py',source))],{encoding:'utf8'});JSON.parse(contract);await writeFile(new URL('mcp-input.json',target),contract);
const consumer=new URL('apps/mcp/src/domain-contracts/semantic-input.json',root);
if(process.argv.includes('--publish-contract'))await writeFile(consumer,contract);
if(process.argv.includes('--check-contract')&&await readFile(consumer,'utf8')!==contract)throw Error('semantic_contract_publication_stale');
const receipt={state:'built',scope:'public source and paired model verification metadata;no weights or credentials',files};
await writeFile(new URL('source-manifest.json',target),JSON.stringify(receipt,null,2)+'\n');console.log(JSON.stringify(receipt));
