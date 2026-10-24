import {lstat,readFile} from 'node:fs/promises';
// Only a private configuration PATH is an argument; no execution tokens or credentials.
const at=process.argv.indexOf('--config');
if(at<0)process.stdout.write(JSON.stringify({state:'executor_unavailable',effects:0,next_step:'Root_install_scoped_GC_service_profile'})+'\n');
else{
 const path=process.argv[at+1];if(!path)throw Error('GC_private_config_required');
 const s=await lstat(path);if(!s.isFile()||s.isSymbolicLink()||![0,process.geteuid?.()].includes(s.uid)||(s.mode&0o077))throw Error('GC_private_config_required');
 const module=new URL('../../../../apps/gc-executor/runtime/service.mjs',import.meta.url).href;
 const service=await import(module) as {start(config:unknown):Promise<unknown>};
 await service.start(JSON.parse(await readFile(path,'utf8')));
}
