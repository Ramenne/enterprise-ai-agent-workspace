import {readFile} from 'node:fs/promises';
import {Dispatcher,requireThat,Rejected} from './core.mjs';import {PostgresAdapter} from './postgres.mjs';import {SSHAdapter} from './ssh.mjs';import {COSAdapter,LighthouseAdapter,awsCOSFactory} from './cloud.mjs';import {FileReceipts} from './receipts.mjs';import {privateJSON,currentHufuAuthority,BaoCredentials,pgPoolFactory} from './bridges.mjs';
/** Explicit Root config selects deployed SDK paths. It contains only refs and
 * registration, never a caller-provided SQL password or provider master value.
 */
export async function start(config){
 requireThat(process.geteuid()!==0,'nonroot_executor_required');
 const {default:fastify}=await import(config.fastify_module);const {default:pg}=await import(config.pg_module);const sdk=await import(config.secrets_sdk_module);
 const client=sdk.createSecretClient(config.bootstrap);await client.start();const own=(await client.readKV(config.runtime_ref)).data;const machineKey=own.resource_check_key;
 const regions=(await privateJSON(config.registry_file)).regions;const receipts=await new FileReceipts(config.journal_root).init();const credentials=new BaoCredentials(client);
 const dispatch=new Dispatcher({regions,receipts,credentials,authority:currentHufuAuthority({url:config.authority_url,serviceKey:machineKey}),adapters:{postgres:new PostgresAdapter(pgPoolFactory(pg.Pool)),ssh:new SSHAdapter(),cos:new COSAdapter((t,s)=>awsCOSFactory(t,s,config.s3_sdk_module)),lighthouse:new LighthouseAdapter()}});
 const app=fastify({logger:false,bodyLimit:3*1024*1024});app.get('/ready',async()=>({state:'ready',effects:'only current registered regions/targets with current member permits'}));
 app.post('/execute',async(req,reply)=>{try{requireThat(req.headers['x-hub-resource-key']===machineKey,'untrusted_relay');const token=req.headers.authorization;requireThat(typeof token==='string'&&token.startsWith('Bearer '),'member_authentication_required');return await dispatch.execute(token.slice(7),req.body)}catch(e){return reply.code(e instanceof Rejected?e.status:503).send({state:'rejected_or_outcome_unknown',error_code:e instanceof Rejected?e.code:'execution_failed_reconcile_required',raw_secrets_logged:false})}});
 await app.listen({host:'127.0.0.1',port:config.port});const close=async()=>{await app.close();await client.close()};process.once('SIGTERM',()=>void close());return {app,close};
}
if(process.argv.includes('--execute')){const at=process.argv.indexOf('--config');if(at<0)throw Error('Root_installed_config_required');await start(await privateJSON(process.argv[at+1]))}else console.log(JSON.stringify({state:'render_only',effects:0,registered_target_classes:['postgres','ssh','cos','lighthouse']}));
