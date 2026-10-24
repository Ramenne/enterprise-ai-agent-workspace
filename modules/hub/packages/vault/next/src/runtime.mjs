import {installVerifiedDeliveries} from './deliveries.mjs';
import {createSecretClient} from '../../../secrets/src/index.js';
import {connectVaultNext} from './connect.mjs';
import {createVaultWriter} from './scoped-writer.mjs';
import {createLegacyVaultAdapter,installLegacyVaultRoutes} from './legacy-adapter.mjs';
import {installDirectGrantRoute} from './grant-http.mjs';
import {installRegistryRoutes} from './http.mjs';
import {installVaultIdentityRoutes} from './identity-http.mjs';
export async function installVaultNext(app,pool,runtime,installVaultRoutes){
 const writer=await createVaultWriter(createSecretClient,{bootstrap_file:process.env.HUB_BAO_BOOTSTRAP_FILE,ca_file:process.env.HUB_BAO_CA_FILE,...(process.env.HUB_BAO_URL?{base_url:process.env.HUB_BAO_URL}:{})});
 const next=connectVaultNext({pool,secretRuntime:runtime,writer});
 const credentials={current:async auth=>{const token=auth.current_2_0_token;if(!token)throw Error('current_caller_required');const identity=await next.verifyCurrent(token);return{token,kind:identity.kind,actor_id:identity.actor_id,invocation_id:auth.invocation_id};}};
 const adapter=createLegacyVaultAdapter({client:next.base,currentCredentialProvider:credentials,authorityLookup:next.authorityLookup});
 installVerifiedDeliveries(app,{pool,writer,runtime});
 installVaultRoutes(app,next.base);installVaultIdentityRoutes(app,next.base);installRegistryRoutes(app,next.registry);installDirectGrantRoute(app,next.base);installLegacyVaultRoutes(app,adapter);
 app.addHook('onClose',()=>writer.close());
 return {...next,deliveryWriter:writer};
}
