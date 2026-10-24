/** No bearer serialization. Rotated/same-Actor fresh client replaces only live execution binding. */
export class RuntimeError extends Error{constructor(code,status=503,retryable=true){super(code);this.code=code;this.status=status;this.retryable=retryable;}}
export class RamAuthority{
 constructor(callerFactory,{ttlMs=600000,clock=Date.now}={}){if(ttlMs<1||ttlMs>600000)throw Error('bounded_RAM_authority_required');this.factory=callerFactory;this.ttl=ttlMs;this.clock=clock;this.bindings=new Map();}
 async attach(job,request){const api=await this.factory(request),identity=await api.getIdentity();if(identity.actor_id!==job.actor_id)throw new RuntimeError('job_owner_mismatch',403,false);const previous=this.bindings.get(job.run_id);previous?.api.close?.();const ctx={api,identity,deadline:this.clock()+this.ttl,cancel:new AbortController()};this.bindings.set(job.run_id,ctx);return ctx;}
 require(job){const ctx=this.bindings.get(job.run_id);if(!ctx||ctx.identity.actor_id!==job.actor_id||ctx.deadline<=this.clock()||ctx.cancel.signal.aborted){this.bindings.delete(job.run_id);ctx?.api.close?.();ctx?.cancel.abort();throw new RuntimeError('needs_current_credential',409,true);}return ctx;}
 forget(run){const ctx=this.bindings.get(run);ctx?.api.close?.();ctx?.cancel.abort();this.bindings.delete(run);}
 close(){for(const key of this.bindings.keys())this.forget(key);}
}
