const str={type:'string'},integer={type:'integer',minimum:1},bool={type:'boolean',enum:[true]};
const schema=(properties={},required=[])=>({type:'object',properties,required,additionalProperties:false});
const properties=Object.fromEntries(['id','platform','purchasedAt','buyerId','userId','projectId','paidAmount','shipping','discount','note'].map(k=>[k,str]));
properties.revision=integer;properties.lines={type:'array',minItems:1,maxItems:100,items:schema({name:str,spec:str,quantity:{...integer,maximum:100000},unitPrice:str,url:str},['name','quantity','unitPrice'])};
properties.newFiles={type:'array',maxItems:12,items:schema({name:str,base64:str},['name','base64'])};properties.removeFileIds={type:'array',maxItems:12,items:str};
export function createHardwareAdapter(hardware,{version,ready=false}={}){
 if(!hardware||!ready||!version)throw Error('Hardware adapter requires a verified published library/version');
 return {id:'hardware',title:'硬件管理平台（采购）',ready:true,version,
 operations:[
  {name:'hardware_options',description:'读取当前成员、购买人与使用人选项、平台选项。',inputSchema:schema()},
  {name:'hardware_projects',description:'读取本人有权查看的中枢项目用于采购关联。',inputSchema:schema()},
  {name:'hardware_list',description:'按商品、购买人、购买平台、日期查询采购订单和实际记录统计。',inputSchema:schema({search:str,buyer:str,platform:str,from:str,to:str,page:integer,archived:{type:'boolean'}})},
  {name:'hardware_read',description:'读取采购订单、多件商品、凭证清单和修订记录，遵守原平台成员查看规则。',inputSchema:schema({id:str},['id'])},
  {name:'hardware_save',write:true,description:'登记或修订采购订单，可附图片/PDF凭证。登记人由真实身份确定；修改需当前revision及登记人/管理员权限。本操作只记录已有采购，不下单或付款。',inputSchema:schema(properties,['platform','purchasedAt','buyerId','paidAmount','lines'])},
  {name:'hardware_state_save',write:true,description:'登记人或管理员明确确认归档或恢复采购记录，保留原凭证与历史。',inputSchema:schema({id:str,revision:integer,action:{type:'string',enum:['archive','restore']},confirmed:bool},['id','revision','action','confirmed'])},
  {name:'hardware_file_read',agentAvailable:false,description:'直接API读取原始图片/PDF凭证Base64与SHA-256；仅在原平台权限核验和原件哈希校验通过后返回。',inputSchema:schema({id:str},['id'])}
 ],
 async run(member,name,args,finish,operationId){switch(name){
  case 'hardware_options':return hardware.options(member);
  case 'hardware_projects':return hardware.projects(member);
  case 'hardware_list':return hardware.list(member,{...args,...(args.archived!==undefined?{archived:String(args.archived)}:{})});
  case 'hardware_read':return hardware.detail(member,args.id);
  case 'hardware_save':return {state:'published',...await hardware.save(member,{...args,operationId})};
  case 'hardware_state_save':{const {confirmed,...body}=args;return {state:'published',...hardware.archive(member,{...body,operationId})}}
  case 'hardware_file_read':{const file=hardware.file(member,args.id);return {id:file.id,orderId:file.order_id,name:file.name,mime:file.mime,size:file.size,sha256:file.sha256,bytesBase64:Buffer.from(file.bytes).toString('base64')}}
  default:throw Object.assign(Error('硬件操作不存在'),{status:404});
 }}
 };
}
