import {CosTierProvider} from './cos-tier-provider.mjs';
import {createPrivateJournal} from './private-journal.mjs';
/** secrets is the already bootstrapped current machine SDK (fresh scoped AppRole).
 * Do not pass this object to MCP or serialize provider bag/errors into responses. */
export async function createMachineTierProvider({COS,secrets,providerRef,journalDirectory,uid}) {
 if(typeof providerRef!=='string'||!providerRef.startsWith('bao:'))throw Error('controlled_provider_ref_required');
 const journal=await createPrivateJournal(journalDirectory,uid);
 return new CosTierProvider({COS,journal,scopeProvider:async()=>{
  const {data}=await secrets.readKV(providerRef);return data;
 }});
}
