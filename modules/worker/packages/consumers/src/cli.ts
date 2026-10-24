#!/usr/bin/env node
import {pathToFileURL} from 'node:url';
import {resolve,basename,dirname} from 'node:path';
import {HubApiClient,ConsumerError} from './transport.js';
import {FileCredentialProvider} from './credentials.js';
import {ProjectConsumer,requireUuid} from './projection.js';
import {FileProjectionStore,readControlledJson,downloadFixed,fixedReference,atomicJson} from './local-files.js';
import {prepareReplay,replay,replayEnvelope} from './replay.js';
import {watchProject} from './watch.js';

function argumentsMap(args:string[]):{command:string;values:Map<string,string>}{
 const command=args.shift()??'',values=new Map<string,string>();
 while(args.length){const key=args.shift(),value=args.shift();if(!key?.startsWith('--')||value===undefined||values.has(key))throw new ConsumerError('invalid_cli_arguments');values.set(key,value);}
 return {command,values};
}
export async function main(args:string[]):Promise<void>{
 if(Number(process.versions.node.split('.')[0])!==24)throw new ConsumerError('node24_required');
 const {command,values}=argumentsMap(args.slice());
 const get=(key:string)=>{const value=values.get('--'+key);if(!value)throw new ConsumerError('cli_option_required_'+key.replaceAll('-','_'));return value;};
 const provider=new FileCredentialProvider(get('credentials-file'));
 const service=get('service');if(service!=='mem'&&service!=='v8')throw new ConsumerError('invalid_consumer_service');
 const api=new HubApiClient(get('url'),provider);
 if(command==='watch'){
  const controller=new AbortController(),stop=()=>controller.abort();process.once('SIGTERM',stop);process.once('SIGINT',stop);
  try{await watchProject(api,{project:get('project'),directory:get('state-dir'),signal:controller.signal,resync:values.get('--resync')==='true',intervalMs:Number(values.get('--interval-ms')??10000),heartbeatMs:Number(values.get('--heartbeat-ms')??300000)});}finally{process.removeListener('SIGTERM',stop);process.removeListener('SIGINT',stop);}
 }else if(command==='sync'){
  const project=requireUuid(get('project')),store=new FileProjectionStore(get('state-dir'));
  const channel=await api.bindingId();
  const consumer=new ProjectConsumer(api,project,()=>api.bindingId(),await store.load(project,channel));
  const view=await consumer.sync({resync:values.get('--resync')==='true'});
  await store.save(consumer.exportCheckpoint());console.log(JSON.stringify(values.get('--output')==='summary'?{status:view.status,item_count:view.items.length,pending_groups:view.pending_groups,checked_at:view.checked_at,error_code:view.error_code,checkpoint_preserved:true}:view));
  if(view.status!=='current'&&view.status!=='gap_pending')process.exitCode=2;
 }else if(command==='read-fixed'){
  if(service!=='mem')throw new ConsumerError('fixed_read_requires_mem');
  const ref=fixedReference(await readControlledJson(get('ref-file')));
  const chunk=values.get('--chunk-bytes');
  console.log(JSON.stringify(await downloadFixed(api,ref,get('cache-dir'),chunk===undefined?{}:{chunkBytes:Number(chunk)})));
 }else if(command==='prepare-replay'){
  const body=await readControlledJson(get('body-file'));if(!body||typeof body!=='object'||Array.isArray(body))throw new ConsumerError('invalid_replay_body');
  const envelope=prepareReplay(get('api-path'),body as Record<string,unknown>,get('logical-key'),{bodyKey:values.get('--body-key')!=='false'});
  const output=resolve(get('operation-file'));await atomicJson(dirname(output),basename(output),envelope);
  console.log(JSON.stringify({state:'replay_prepared',operation_file:output,credentials_included:false}));
 }else if(command==='replay'){
  const envelope=replayEnvelope(await readControlledJson(get('operation-file')));
  const result=await replay(api,envelope);
  // Public endpoint response only. No private credential configuration is printed.
  console.log(JSON.stringify({state:'returned',result}));
 }else throw new ConsumerError('unknown_consumer_command');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 main(process.argv.slice(2)).catch(error=>{
  const code=error instanceof ConsumerError?error.code:'consumer_cli_failed';
  console.error(JSON.stringify({state:'failed',error_code:code,next_step:'inspect_current_authority_or_replay_same_logical_operation'}));process.exitCode=1;
 });
}
