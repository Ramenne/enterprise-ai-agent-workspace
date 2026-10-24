import{installLighthouseSource}from'./lighthouse-source.mjs';
import {readFile}from'node:fs/promises';
import{selectModelTarget}from'./model-target-routing.mjs';
import {installSharedRoutes}from'./shared-routes.mjs';
import {installMemStorageNavigation}from'./mem-storage-navigation.mjs';
import {installVaultProjectUse,createManagedEntryReader}from'./vault-project-use.mjs';
import {originalCallerNativeInvoker}from'./native-asr-use-guard.mjs';
import {FileReceipts}from'./file-receipts.mjs';
import {createHash}from'node:crypto';
import{installCustodyMigration,pinnedRef}from'./custody-migration.mjs';
export async function installResourceProjects(app,{pool,runtime}){
 await installCustodyMigration(app,{pool,runtime});
 app.post('/v2/resources/project-catalog',{logLevel:'silent'},async req=>{
  const auth=req.headers.authorization;if(typeof auth!=='string'||!auth.startsWith('Bearer '))throw Object.assign(Error('unauthenticated'),{statusCode:401});
  const proof=createHash('sha256').update(auth.slice(7)).digest('hex');const result=(await pool.query('select authz.project_resource_catalog($1::text,$2::jsonb) as result',[proof,req.body])).rows[0].result;
  if(result.state==='read'){const registry=JSON.parse(await readFile('/etc/workspace-hub2/shared-resources/registry.json','utf8'));result.items=result.items.map(item=>{const target=selectModelTarget(registry.modelTargets??[],item.entry_id,item.project_id);return target&&item.mode==='model_proxy'?{...item,managed_API:{state:target.registration_state??'registered_call_status_needed',base_url:new URL(target.endpoint).origin,models:target.models,actions:['models','chat'],supplier_status:target.supplier_status??null,configuration_source:target.configuration_source},example_parameters:{model:target.models[0],messages:[{role:'user',content:'Your authorized work input'}]}}:item})}
  return result;
 });
 const serviceKey=runtime.optional('resource_execution_key','HUFU_RESOURCE_EXECUTION_KEY');
 if(serviceKey)installLighthouseSource(app,{pool,runtime,serviceKey});
 if(serviceKey)installSharedRoutes(app,pool,{serviceKey,executorUrl:'http://127.0.0.1:4638/execute-shared'});
 installMemStorageNavigation(app,{memOrigin:'http://127.0.0.1:4612'});
 let registry={modelTargets:[],nativeASRGuardInstalled:false};
 try{registry=JSON.parse(await readFile('/etc/workspace-hub2/shared-resources/registry.json','utf8'))}catch(e){if(e.code!=='ENOENT')throw e}
 const receipts=await new FileReceipts('/srv/workspace').init();
 const invokeNative=originalCallerNativeInvoker({hufu:'http://127.0.0.1:4611',mem:'http://127.0.0.1:4612'});
 const latestRegistry=async()=>JSON.parse(await readFile('/etc/workspace-hub2/shared-resources/registry.json','utf8'));
 installVaultProjectUse(app,pool,{invokeNative,receipts,modelTargets:async()=>(await latestRegistry()).modelTargets??[],nativeASRGuardInstalled:registry.nativeASRGuardInstalled===true,
  readEntry:createManagedEntryReader({pool,secretClient:{readKV:async ref=>({data:await runtime.optionalSecret(pinnedRef(ref))})}})});
 app.get('/v2/resources/shared/help',async()=>{const registry=await latestRegistry();return({state:'installed',version:'project-resource-use.v1',shared_execution_configured:!!serviceKey,
  routes:['/v2/resources/shared/usages/save','/v2/resources/shared/usages/confirm','/v2/resources/shared/usages/revoke','/v2/resources/shared/usages/read','/v2/resources/shared/execute','/v2/resources/storage/list','/v2/resources/storage/info','/v2/resources/storage/restore','/v2/resources/storage/status','/v2/vault/project-use/save','/v2/vault/project-use/change','/v2/vault/project-use/directory','/v2/vault/project-use/apply','/v2/vault/project-use/execute'],
  supplier_model_targets_registered:(registry.modelTargets??[]).filter(x=>x.enabled===true).length,native_ASR_use_guard_installed:registry.nativeASRGuardInstalled===true,
  qualification_created:false,identity:'original_current_member_and_software',management:'source_and_consumer_current_managers;metadata_relation_does_not_grant_members'})});
}
