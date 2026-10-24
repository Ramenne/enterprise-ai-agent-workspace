// Deliver approved existing resource configuration by default; isolated credentials are optional.
import {loadRuntime} from '/srv/workspace';import {readFile} from 'node:fs/promises';import {spawn} from 'node:child_process';
let input='';for await(const part of process.stdin)input+=part;const b=JSON.parse(input);input='';
const runtime=await loadRuntime('hufu'),pool=await runtime.databasePool('DATABASE_URL');let parent,holder;
const python=async(file,payload)=>await new Promise((resolve,reject)=>{let out='';const p=spawn('/usr/bin/python3',[file],{stdio:['pipe','pipe','pipe']});p.stdout.on('data',x=>out+=x);p.on('close',c=>{try{const r=JSON.parse(out);c?reject(Error(r.error_code??'provider_supply_failed')):resolve(r)}catch{reject(Error('provider_result_unavailable'))}});p.stdin.end(JSON.stringify(payload));});
try{
 const args={package_id:b.package_id,item_id:b.item_id,mode:b.mode,...(['bootstrap','inspect'].includes(b.mode)?{source_key:'zm-center.manage'}:{})};
 const auth=(await pool.query('SELECT authz.service_storage_supply_prepare($1,$2::jsonb) result',[b.proof,args])).rows[0].result;
 const usesResource=b.mode==='supply'&&auth.credential_strategy==='existing_resource';
 let credentials;
 if(['bootstrap','inspect'].includes(b.mode)||usesResource){
  const loc=auth.parent_locator;const[base,query]=loc.secret_ref.split('?');const segments=base.slice(4).split('/');holder=await runtime.optionalSecret(query?{mount:segments.shift(),path:segments.join('/'),version:Number(new URLSearchParams(query).get('version'))}:base);
  parent=typeof holder[loc.value_field]==='string'?JSON.parse(holder[loc.value_field]):holder[loc.value_field];
  credentials={SecretId:parent.SecretId??parent.secret_id??parent.secretId,SecretKey:parent.SecretKey??parent.secret_key??parent.secretKey};
  if(!credentials.SecretId||!credentials.SecretKey)throw Error('registered_source_format_unknown');
 }
 if(['bootstrap','inspect'].includes(b.mode)){
  const result=await python('/usr/local/libexec/workspace-service-storage/'+(b.mode==='inspect'?'inspect-account-manager.py':'bootstrap-storage-issuer.py'),{issuer_credentials:credentials,organization_id:auth.organization_id});console.log(JSON.stringify(result));
 }else{
  const supplier=usesResource?{...credentials,organization_id:auth.organization_id,root_parent_in_config:false,enabled:true,owner_uin:'100029668957',appid:'1316920087',region:'ap-guangzhou'}:JSON.parse(await readFile('/srv/workspace','utf8'));
  if(supplier.organization_id!==auth.organization_id||supplier.root_parent_in_config!==false||supplier.enabled===false||supplier.owner_uin!=='100029668957')throw Error('registered_platform_supplier_required');
  const code=`import importlib.util,pathlib,sys,json
sys.path.insert(0,'/usr/local/libexec/workspace-service-storage')
spec=importlib.util.spec_from_file_location('allocator','/usr/local/libexec/workspace-service-storage/project-bucket-provision.py')
m=importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
m.PRIVATE=pathlib.Path('/srv/workspace')
try:
 m.main()
except Exception as e:
 print(json.dumps({'state':'failed','error_code':str(e) if isinstance(e,RuntimeError) else type(e).__name__,'credentials_in_output':False}))
 sys.exit(1)
`;
  const result=await new Promise((resolve,reject)=>{let out='';const p=spawn('/usr/bin/python3',['-c',code],{stdio:['pipe','pipe','pipe']});p.stdout.on('data',x=>out+=x);p.on('close',c=>{try{const r=JSON.parse(out);c?reject(Error(r.error_code??'provider_supply_failed')):resolve(r)}catch{reject(Error('provider_result_unavailable'))}});p.stdin.end(JSON.stringify({approved_package:auth.approved_package,item:auth.item,...(usesResource?{resource_credentials:supplier}:{issuer_credentials:supplier}),cloud_account:{owner_uin:supplier.owner_uin,appid:supplier.appid,region:supplier.region}}));});
  console.log(JSON.stringify({...result,authenticated_actor_id:auth.actor_id,authenticated_client_id:auth.client_id,root_used_for_allocation:false}));
 }
}catch(e){console.log(JSON.stringify({state:'failed',error_code:/^[A-Za-z_][A-Za-z0-9_.:]{0,120}$/.test(e.message??'')?e.message:'fixed_storage_supply_failed',parent_values_in_output:false}));process.exitCode=1;}finally{parent=holder=undefined;await runtime.close();}
