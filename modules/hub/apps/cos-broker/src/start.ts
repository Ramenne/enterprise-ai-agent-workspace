import {createSecretClient} from '../../../packages/secrets/src/index.js';
import {createBroker,type SecretStore,type BrokerState} from './broker.js';
import {stateFile} from './state.js';
import {BrokerError,issueSts} from './tc3.js';
const event=(data:Record<string,unknown>)=>process.stdout.write(JSON.stringify({service:'hub2-cos-lease-broker',...data})+'\n');
async function main(){
 const client=createSecretClient({bootstrap_file:process.env['HUB_BAO_BOOTSTRAP_FILE']??'/etc/workspace-hub2/bootstrap/hufu/machine.private.json',ca_file:process.env['HUB_BAO_CA_FILE']??'/etc/workspace-hub2/bao-ca.crt',base_url:process.env['HUB_BAO_URL']??'https://127.0.0.1:8200',request_timeout_ms:5000,reconnect_budget_ms:15000});
 if(typeof client.writeKV!=='function'){await client.close();throw new BrokerError('secret_writer_unavailable');}
 const store:SecretStore={readKV:ref=>client.readKV(ref),writeKV:(ref,data)=>client.writeKV(ref,data)};
 const file=stateFile(process.env['HUB_COS_BROKER_STATE_PATH']??'/srv/workspace');let initial:BrokerState={};
 try{initial=await file.load();}catch{event({state:'receipt_metadata_unavailable',next_step:'issue_fresh_scoped_lease_without_discarding_consumer_KV'});}
 const broker=createBroker({store,issue:issueSts,initial,save:file.save,on_event:data=>event({...data})});
 let stopping=false;let timer:NodeJS.Timeout|undefined;
 const stop=async()=>{if(stopping)return;stopping=true;if(timer)clearTimeout(timer);await Promise.allSettled([broker.stop(),client.close()]);};
 process.once('SIGTERM',()=>{void stop();});process.once('SIGINT',()=>{void stop();});
 const tick=async()=>{await broker.check().catch(()=>{});if(!stopping)timer=setTimeout(()=>{void tick();},300000);};
 event({state:'started',check_seconds:300,refresh_margin_seconds:900,requested_lease_seconds:3600,human_periodic_access_required:false});await tick();
}
main().catch(error=>{const allowed=error instanceof BrokerError?error.code:'management_unavailable';event({state:'startup_failed',code:allowed,secret_values_logged:false});process.exitCode=1;});
