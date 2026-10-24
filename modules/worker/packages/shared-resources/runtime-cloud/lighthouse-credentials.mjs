/** Existing approved resource identity; parent values stay between local services. */
export class LighthouseCredentials{
 constructor(upstream,machineKey){this.upstream=upstream;this.machineKey=machineKey}
 async get(ref,ctx){
  if(ref!=='managed:lighthouse-jiaxin')return this.upstream.get(ref,ctx);
  const {target,permit,action,bearer}=ctx;
  if(target.id!=='jiaxin-lighthouse-instance'||target.account_id!=='100048716377'||target.instance_id!=='example-resource-id'||!['lighthouse.instance.describe','lighthouse.instance.start','lighthouse.instance.stop','lighthouse.instance.restart'].includes(action)||!bearer)throw Error('fixed_lighthouse_source_required');
  const request=async mode=>{const r=await fetch('http://127.0.0.1:4611/internal/resource-lighthouse/source',{method:'POST',headers:{authorization:'Bearer '+bearer,'x-hub-service-key':this.machineKey,'x-hub-resource-key':this.machineKey,'content-type':'application/json'},body:JSON.stringify({target_id:target.id,action,permit,mode}),signal:AbortSignal.timeout(8000)});const d=await r.json();if(!r.ok)throw Object.assign(Error(d.error_code??'cloud_source_unavailable'),{code:d.error_code,status:r.status});return d;};
  const secret=await request('get');return{...secret,secret_ref:ref,target_fingerprint:target.fingerprint,current_scope_verified:true,deadline:new Date(Date.now()+30000).toISOString(),managed_lighthouse:true,assertActive:async()=>{const d=await request('guard');if(d.revision!==secret.source_revision)throw Error('cloud_source_changed');}};
 }
 async release(secret){if(secret?.managed_lighthouse){secret.secret_id=undefined;secret.secret_key=undefined;return;}await this.upstream.release?.(secret)}
}
