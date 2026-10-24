const str=maxLength=>({type:'string',maxLength});
const id=str(150),uuid={type:'string',format:'uuid'},plain={type:'object',additionalProperties:false};
const tool=(name,description,properties={},required=[],effect=false)=>({name:'gallery.'+name,description,annotations:{readOnlyHint:!effect,idempotentHint:true},inputSchema:{...plain,properties,required}});
const image={prompt:{type:'string',minLength:1,maxLength:10000},width:{type:'integer',minimum:512,maximum:2048,multipleOf:16},height:{type:'integer',minimum:512,maximum:2048,multipleOf:16},seed:{type:'integer',minimum:0,maximum:4294967295},lora_id:uuid,lora_strength:{type:'number',minimum:-2,maximum:2}};
const source={...plain,properties:{post_id:id,slice_id:str(100),revision:{type:'integer',minimum:1}},required:['post_id','slice_id','revision']};
export const galleryLoopTools=[
 tool('generation.capabilities','读取画廊生成能力；与visual.*共用执行层、成员身份和任务编号。'),
 tool('generation.preview','从拼装提示词预检Krea2参数与LoRA，不提交、不扣费。',image,['prompt']),
 tool('generation.create','保存固定片段来源草稿并提交生图；同UUID不重复。用generation.sync查进度并将原图自动入库。默认零散任务，由统一visual执行层选路。',{...image,title:str(120),kind:{type:'string',enum:['场景','角色','静物']},sources:{type:'array',maxItems:40,items:source},generation_authorized:{type:'boolean'},estimated_credits:{type:'number',exclusiveMinimum:0},budget_credits:{type:'number',exclusiveMinimum:0},idempotency_key:uuid},['prompt','generation_authorized','estimated_credits','budget_credits','idempotency_key'],true),
 tool('generation.get','只读当前成员画廊任务记录，不重新提交，不拉取供应商或归档。',{id:uuid},['id']),
 tool('generation.sync','查询原生成任务并把成功原图、实际提示词参数与固定来源归档；重复同步不重复出图或入库，未知提交保留原任务。',{id:uuid},['id'],true),
 tool('generation.list','读取当前成员最近30条画廊生成任务。'),
 tool('feedback.add','向现有作品点评库追加反馈；幂等键防重复，作者由当前身份生成。source区分AI观察和用户原话声明；不可伪造用户评价，不自动把反馈认定为模型规律。',{post_id:id,body:{type:'string',minLength:1,maxLength:1900},source:{type:'string',enum:['agent_observation','user_quote']},idempotency_key:str(200)},['post_id','body','source','idempotency_key'],true),
 tool('feedback.list','读取作品点评及来源类型；旧网页点评来源标明web_comment，不自动认定为用户原话。',{post_id:id,limit:{type:'integer',minimum:1,maximum:200}},['post_id']),
 tool('provenance.get','读取作品→实际生成参数→拼装草稿→固定来源片段→点评的关联；无来源明确为空，不补造。',{post_id:id},['post_id'])
];
