import {loadBudget} from '../../../packages/platform/src/machine-budget.js';
import {createUrlImportWorker} from './url-import-worker.js';
import {spawn} from 'node:child_process';
import {mkdir,lstat} from 'node:fs/promises';
const state=process.env['URL_IMPORT_STATE_DIRECTORY'];if(!state)throw new Error('owned_import_state_directory_required');
await mkdir(state,{recursive:true,mode:0o700});const st=await lstat(state);if(!st.isDirectory()||st.isSymbolicLink()||st.uid!==process.getuid?.()||(st.mode&0o777)!==0o700)throw new Error('owned_private_import_state_required');
// One OS-enforced worker for an owned state directory; no stale PID-lock reclamation race.
if(process.env['HUB_URL_IMPORT_LOCKED']!=='1'){
 process.umask(0o077);const child=spawn('/usr/bin/flock',['--exclusive','--nonblock','--no-fork',state+'/.worker.lock',process.execPath,process.argv[1]!],{stdio:'inherit',env:{...process.env,HUB_URL_IMPORT_LOCKED:'1'}});for(const signal of['SIGINT','SIGTERM']as const)process.once(signal,()=>child.kill(signal));child.once('error',()=>process.exit(1));child.once('exit',code=>process.exit(code??1));
}else{
 const ioBudget=await loadBudget(undefined,'url_import');const app=createUrlImportWorker({ioBudget,hufu_url:process.env['HUFU_URL']??'http://127.0.0.1:4611',mem_url:process.env['MEM_URL']??'http://127.0.0.1:4612',state_directory:state});await app.listen({host:'127.0.0.1',port:Number(process.env['URL_IMPORT_PORT']??4623)});const stop=()=>{void app.close().then(()=>ioBudget.close()).then(()=>process.exit(0));};process.once('SIGINT',stop);process.once('SIGTERM',stop);
}
