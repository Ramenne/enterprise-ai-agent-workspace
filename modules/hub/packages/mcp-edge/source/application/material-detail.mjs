const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const materialDetailTool={name:'hub.material.detail',description:'一次定位当前有权资料，读取属性、物理存储、版本历史、使用和简介；附属查询失败单独返回，固定引用不自动改变。',inputSchema:{type:'object',properties:{material_id:{type:'string',format:'uuid'},version_id:{type:'string',format:'uuid'}},required:['material_id'],additionalProperties:false}};
export function createMaterialDetail({mem}){
 return async(auth,args={})=>{
  if(!args||Array.isArray(args)||typeof args!=='object'||Object.keys(args).some(k=>!Object.hasOwn(materialDetailTool.inputSchema.properties,k))||!uuid.test(args.material_id||'')||args.version_id!==undefined&&!uuid.test(args.version_id))throw Object.assign(Error('invalid_material_detail_input'),{status:400});
  const loc=await mem(auth,'/v2/materials/locate',args),scope={project_id:loc.project_id,material_id:loc.material_id},fixed=loc.fixed_ref;
  if(!fixed)throw Object.assign(Error('no_published_original'),{status:409});
  // The resolved scope is only an address. Each domain call still checks current access.
  const [attributes,storage,history,usage,description]=await Promise.all([
   mem(auth,'/v2/materials/attributes',scope),
   mem(auth,'/v2/objects/storage-tier/info',{...scope,version_id:fixed.version_id}).catch(e=>({state:'unavailable',error:e.message})),
   mem(auth,'/v2/materials/history',{...scope,limit:20}).catch(e=>({state:'unavailable',error:e.message})),
   mem(auth,'/v2/materials/usage',{...scope,window_days:30}).catch(e=>({state:'unavailable',error:e.message})),
   mem(auth,'/v2/materials/description-read',{...scope,version_id:fixed.version_id,sha256:fixed.sha256}).catch(e=>({state:'restricted',error:e.message}))
  ]);
  return{attributes,storage,history,usage,description,fixed_ref:fixed};
 };
}
