/** Integrate BEFORE fixed read in gateway readFull. This is a permission-checked
 * source resolution, not a 403 fallback that guesses another project's UUID. */
export async function resolveFixedSource(auth,args,req,{memberMem}){
 if(!args.material_id||!args.version_id)return args; // Latest-by-material keeps existing ordinary project lookup.
 const result=await memberMem(auth,'/v2/references/resolve',{material_id:args.material_id,version_id:args.version_id,...(args.sha256?{sha256:args.sha256}:{})},req);
 if(result.state!=='authorized_fixed_reference'||!result.fixed_ref?.project_id)throw Object.assign(Error('forbidden'),{status:403});
 const ref=result.fixed_ref;
 if(ref.material_id!==args.material_id||ref.version_id!==args.version_id||args.sha256&&ref.sha256!==args.sha256)throw Object.assign(Error('fixed_reference_mismatch'),{status:409});
 return{...args,project_id:ref.project_id,sha256:ref.sha256};
}
