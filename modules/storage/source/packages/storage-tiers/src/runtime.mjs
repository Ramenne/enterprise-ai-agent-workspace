import COS from 'cos-nodejs-sdk-v5';
import {legacyScopeProvider} from './legacy-tier.mjs';
import {withCopyLineage} from './archive-lifecycle.mjs';
import {CosTierProvider} from './cos-tier-provider.mjs';
import {createPrivateJournal} from './private-journal.mjs';
export async function loadTierProvider(runtime){
 const journal=await createPrivateJournal('/srv/workspace',process.getuid());
 const legacy=legacyScopeProvider();
 return withCopyLineage(new CosTierProvider({COS,journal,scopeProvider:async(locator,operation,context)=>{
  if(locator?.provider==='cos-legacy-shanghai')return legacy(locator,operation,context);
  const data=await runtime.optionalSecret('bao:hub2/object-store/mem');
  if(!data)throw new Error('tier_credentials_unavailable');
  const expiration=data.expires_at??data.credential_expires_at;
  return {...data,provider:'cos',scope_verified:true,source_prefixes:['final/'],archive_prefix:'archive/',
   valid_until:typeof expiration==='number'?new Date(expiration*1000).toISOString():expiration,
   actions:['head','read','copy','restore','retire_hot']};
 }}));
}
