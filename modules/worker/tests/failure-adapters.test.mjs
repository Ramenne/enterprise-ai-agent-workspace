import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,writeFile,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';
import {server,bearer,DomainError} from '../dist/packages/platform/src/http.js';
import {installBaizeDirectory} from '../apps/hufu/src/hufu-baize-directory.mjs';
import {installProductServices} from '../apps/hufu/src/product-services.mjs';
import {installVaultRoutes} from '../packages/vault/src/http.mjs';
import {installRegistryRoutes} from '../packages/vault/next/src/http.mjs';
import {installDirectGrantRoute} from '../packages/vault/next/src/grant-http.mjs';
import {installVerifiedDeliveries} from '../packages/vault/next/src/deliveries.mjs';
import {installOfficialManuals} from '../packages/handbook/src/http.mjs';
import {installSystemReleases} from '../packages/handbook/src/releases.mjs';
import {installEngineering} from '../packages/engineering/src/engineering.mjs';
import {installDatabaseAccess} from '../packages/database-access/src/database-access.mjs';
import {installAuthorization} from '../packages/authorization/src/authorization.mjs';
import {installLegacyApplicationGrants} from '../packages/legacy-application-grants/src/http.mjs';
import {installApplicationDevices} from '../packages/legacy-application-grants/src/devices.mjs';
import {installProjectBackups} from '../packages/project-backups/src/http.mjs';
import {installAssetBackups} from '../packages/asset-backups/src/asset-api.mjs';
import {installNativeVaultEntryClaims} from '../packages/native-vault-claims/src/http.mjs';
import {installSqliteDatabaseAccess} from '../packages/sqlite-database-access/src/http.mjs';
import {installProjectMembers} from '../packages/project-members/src/http.mjs';
import {installCustodyMigration} from '../dist/packages/shared-resources/src/custody-migration.mjs';
import {installStandardEntry} from '../packages/member-auth/src/entry.mjs';
import {installControlInbox} from '../packages/control-inbox/src/http.mjs';
const id='ab817207-5829-4429-a165-bf1159ae4de0',headers={authorization:'Bearer SYNTHETIC_TEST_IDENTITY'};
const fixtures=[
 ['baize-directory',installBaizeDirectory,'/v2/applications/baize/members',{}],
 ['product-services',installProductServices,'/v2/services/authorizations',{}],
 ['vault',(a,d)=>installVaultRoutes(a,d.service),'/v2/vault/directory',{}],
 ['registry',(a,d)=>installRegistryRoutes(a,d.service),'/v2/vault/secret/status',{operation_id:id}],
 ['direct-grants',(a,d)=>installDirectGrantRoute(a,d.service),'/v2/vault/grants/set',{entry_id:id,principal_id:id,enabled:true}],
 ['verified-deliveries',installVerifiedDeliveries,'/v2/vault/deliveries/list',{}],
 ['manuals',(a,d)=>installOfficialManuals(a,d.pool),'/v2/manuals/catalog'],
 ['releases',(a,d)=>installSystemReleases(a,d.pool),'/v2/releases/help'],
 ['engineering',installEngineering,'/v2/engineering/projects',{}],
 ['database',installDatabaseAccess,'/v2/database-access/objects',{project_id:id}],
 ['authorization',installAuthorization,'/v2/authorization/catalog',{}],
 ['legacy-grants',installLegacyApplicationGrants,'/v2/authorization/legacy-grants/list',{}],
 ['device',installApplicationDevices,'/v2/authorization/application-devices/revoke',{binding_id:id,expected_revision:1}],
 ['asset-backup',installAssetBackups,'/v2/engineering/backups/assets/authority',{project_id:id,action:'sources'}],
 ['sqlite',installSqliteDatabaseAccess,'/v2/database-access/sqlite/inspect',{project_id:id,schema:'synthetic'}],
 ['project-backup',installProjectBackups,'/v2/engineering/backups/list',{project_id:id}],
 ['native-claim',installNativeVaultEntryClaims,'/v2/vault/entry-deliveries/prepare',{entry_id:id}],
 ['members',installProjectMembers,'/v2/projects/members',{project_id:id}],
 ['custody',installCustodyMigration,'/v2/vault/custody/inspect',{}],
 ['member-entry',(a,d)=>installStandardEntry(a,{pool:d.pool,assertPolicy:async()=>{},auth:{api:{getSession:async()=>null}},prefix:'',baseURL:'http://localhost',issuer:'http://localhost',resource:'http://localhost'}),'/v2/member/software'],
 ['control',installControlInbox,'/v2/control/submit',{project_id:id,idempotency_key:'synthetic'}]
];
for(const [name,install,url,payload] of fixtures)test(name+': identity, permission and busy are distinct',async t=>{
 const app=server('adapter-test');t.after(()=>app.close());let failure;const deny=async()=>{throw failure;},pool={query:deny},service=new Proxy({},{get:()=>deny}),writer={readKV:deny,writeKV:deny,close:async()=>{}},runtime={optional:()=>null,required:()=> 'SYNTHETIC_TEST_KEY'};
 await install(app,{pool,service,writer,runtime,bearer,DomainError,sqlFunction:deny,credentialKey:'SYNTHETIC_TEST_KEY',serviceKey:'SYNTHETIC_TEST_KEY',memberAuth:{},vaultNext:{deliveryWriter:writer,base:{reveal:deny}}});
 for(const [code,message,status,expected] of [['42501','unauthenticated',401,'unauthenticated'],['42501','manager_required',403,null],['55P03','private SQL value',503,'dependency_busy'],['57014','private SQL value',503,'dependency_busy']]){
  failure=Object.assign(Error(message),{code});const r=await app.inject({method:payload===undefined?'GET':'POST',url,headers,...(payload===undefined?{}:{payload})});assert.equal(r.statusCode,status,name+':'+r.body);if(expected)assert.equal(r.json().error_code,expected,name);assert.ok(!r.body.includes('private SQL'));
  if(name==='native-claim')assert.equal(r.json().next_step,'query_original_entry_grant_and_claim;never_repeat_unknown_secret_release');
  if(name==='project-backup')assert.equal(r.json().next_step,'query_original_operation;backup_is_workspace_only');
  if(name==='authorization'&&status===403){assert.equal(r.json().state,'denied');assert.equal(r.json().error_code,'manager_required');assert.equal(r.json().original_effect,'not_assumed');}
 }
});
test('release optional private list tolerates absent permission but propagates revocation',async t=>{
 const root=await mkdtemp(tmpdir()+'/release-auth-');t.after(()=>rm(root,{recursive:true,force:true}));await writeFile(root+'/manifest.json',JSON.stringify({documents:[]}));const app=server('release-test');t.after(()=>app.close());let reason='manager_required';
 installSystemReleases(app,{query:async sql=>{if(sql.includes('authenticate'))return{rows:[{identity:{actor_id:id}}]};throw Object.assign(Error(reason),{code:'42501'});}},root+'/');
 let r=await app.inject({url:'/v2/releases/updates',headers});assert.equal(r.statusCode,200);assert.equal(r.json().personal_delivery_state,'outside_current_client_scope');reason='unauthenticated';r=await app.inject({url:'/v2/releases/updates',headers});assert.equal(r.statusCode,401);assert.equal(r.json().error_code,'unauthenticated');
});
test('MCP vault keeps original logical key and unknown effect recovery',async()=>{
 const {registerVaultTools,vaultTools}=await import('../packages/vault/src/mcp.mjs');const callbacks=new Map();let failure;registerVaultTools({registerTool:(name,options,fn)=>callbacks.set(name,fn)},{inputSchemas:Object.fromEntries(vaultTools.map(x=>[x.operation,{}])),service:{call:async()=>{throw failure;}}});
 for(const [code,message,status]of[['42501','unauthenticated',401],['57014','private query',503]]){failure=Object.assign(Error(message),{code});const r=await callbacks.get('hufu.vault.apply')({key:'synthetic',idempotency_key:'original'},{http:{authInfo:{token:'SYNTHETIC'}}});assert.equal(r.structuredContent.http_status,status);assert.equal(r.structuredContent.idempotency_key,'original');if(status===503){assert.equal(r.structuredContent.state,'outcome_unknown');assert.equal(r.structuredContent.next_step,'query_original_application_or_retry_same_input_and_key');}else assert.equal(r.structuredContent.error_code,'unauthenticated');}
});
test('OTP registration preserves protocol status and never sends email on identity failure',async()=>{
 const {registerOTPMember}=await import('../packages/member-auth/src/provider.mjs');let reason,mail=0;const provider={otpConfigured:true,pool:{connect:async()=>({query:async sql=>{if(sql.includes('register_member_otp'))throw Object.assign(Error(reason),{code:'42501'});return{rows:[]};},release(){}})},auth:{api:{sendVerificationOTP:async()=>mail++}}};
 for(const [message,status]of[['unauthenticated',401],['primary_required',403]]){reason=message;await assert.rejects(registerOTPMember(provider,'SYNTHETIC',{email:'synthetic@example.invalid',name:'Synthetic'}),e=>{assert.equal(e.statusCode,status);return true;});}assert.equal(mail,0);
});

test('member registration HTTP adapts protocol rejection without sending mail',async t=>{
 const app=server('member-register-test');t.after(()=>app.close());let reason='unauthenticated',mail=0;
 const member={otpConfigured:true,assertPolicy:async()=>{},prefix:'',baseURL:'http://localhost',issuer:'http://localhost',resource:'http://localhost',pool:{connect:async()=>({query:async sql=>{if(sql.includes('register_member_otp'))throw Object.assign(Error(reason),{code:'42501'});return{rows:[]};},release(){}})},auth:{api:{sendVerificationOTP:async()=>mail++,getSession:async()=>null}}};
 await installStandardEntry(app,member);
 for(const [message,status]of[['unauthenticated',401],['primary_required',403]]){reason=message;const r=await app.inject({method:'POST',url:'/v2/member/register-otp',headers,payload:{email:'synthetic@example.invalid',name:'Synthetic'}});assert.equal(r.statusCode,status,r.body);assert.equal(r.json().error_code,status===401?'unauthenticated':'current_primary_member_required');}
 const missing=await app.inject({method:'POST',url:'/v2/member/register-otp',payload:{email:'synthetic@example.invalid',name:'Synthetic'}});assert.equal(missing.statusCode,401);assert.equal(mail,0);
});

test('device request validation retains SQL invalid-input status',async t=>{const app=server('device-input-test');t.after(()=>app.close());installApplicationDevices(app,{pool:{query:async()=>{throw Object.assign(Error('application_device_action_required'),{code:'22023'});}}});const r=await app.inject({method:'POST',url:'/v2/authorization/application-devices/check',headers,payload:{application_id:'wrong-synthetic',action:'read',device_credential:'SYNTHETIC'}});assert.equal(r.statusCode,400);assert.equal(r.json().error_code,'application_device_action_required');});

test('asset authority invalid input is not a transient dependency failure',async t=>{const app=server('asset-input-test');t.after(()=>app.close());installAssetBackups(app,{pool:{query:async()=>{throw Object.assign(Error('asset_backup_action_required'),{code:'22023'});}}});const r=await app.inject({method:'POST',url:'/v2/engineering/backups/assets/authority',headers,payload:{project_id:id,action:'wrong-synthetic'}});assert.equal(r.statusCode,400);assert.equal(r.json().error_code,'asset_backup_action_required');});
