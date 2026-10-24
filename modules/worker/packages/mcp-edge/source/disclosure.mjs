/** Progressive disclosure preserves the full authorized tool surface behind a small entry. */
const field=(name,description,properties,required=[])=>({name,description,inputSchema:{type:'object',properties,required,additionalProperties:false}});
export const disclosureTools=[
 field('hub.work.find','按全局稳定工作短编号查找当前授权范围内的工作；服务端完成项目分页和工作分页，返回一条事实结果或完整覆盖状态。',{short_no:{type:'integer',minimum:1},project_id:{type:'string'},limit_projects:{type:'integer',minimum:1,maximum:100}},['short_no']),
 field('hub.resolve','规范化一个结构化MCP JSON请求：解析工具别名、补安全默认值并返回规范工具名和参数；没有tool时才将intent作为可选检索条件，始终不执行调用。',{tool:{type:'string'},arguments:{type:'object'},request:{type:'object'},intent:{type:'string',maxLength:2000},domain:{type:'string'},mode:{type:'string',enum:['read','plan','effect']},limit:{type:'integer',minimum:1,maximum:20}}),
 field('hub.capabilities','兼容旧入口：发现中枢工具和能力。新调用优先使用 hub.tools；domain、intent、query 会被转换为检索条件。',{domain:{type:'string'},intent:{type:'string'},query:{type:'string'},limit:{type:'integer',minimum:1,maximum:100}}),
 field('hub.help','读取工具契约的兼容入口；未知名称会返回候选工具和下一步。',{tool:{type:'string',minLength:1}},['tool']),
 field('hub.tools','按功能组逐层发现全部中枢能力：先列组，再看组内工具，最后读取单个工具完整契约。可以跨组或用query扩大查找；目录不授予权限。',{group:{type:'string'},tool:{type:'string'},query:{type:'string'},offset:{type:'integer',minimum:0},limit:{type:'integer',minimum:1,maximum:100}}),
 field('hub.invoke','按hub.tools返回的真实工具名称和参数调用任一已登记能力；沿用当前身份、权限和原接口行为，不限制在默认工具列表。',{tool:{type:'string'},arguments:{type:'object'}},['tool','arguments']),
 field('hub.material.designate','根据明确人工指令由当前项目主管/管理人指定或撤销特级；记录真实操作者及指令声明，不能自动证明人类原生来源。普通Agent一级至三级治理不能覆盖特级。',{project_id:{type:'string'},material_id:{type:'string'},special:{type:'boolean'},human_instruction:{type:'string',minLength:1,maxLength:4000},reason:{type:'string'},importance_level:{type:'integer',enum:[1,2,3]},expected_revision:{type:'integer'},idempotency_key:{type:'string'}},['material_id','special','human_instruction','idempotency_key'])
];
const groups=[
 {id:'compatibility',title:'兼容与历史读取',purpose:'既有调用与运维回退；当前语义检索使用简介能力。'},
 {id:'navigation',title:'导航与接入',purpose:'身份、现行规则、项目定位和调用帮助。'},
 {id:'materials',title:'资料与分类',purpose:'查找读写、属性、四级分类、集合及分享。'},
 {id:'search',title:'简介与检索',purpose:'简介维护、固定/扩展属性及语义候选。'},
 {id:'storage',title:'存储与恢复',purpose:'归档、恢复、上传导入、对象修复及回收。'},
 {id:'processing',title:'加工与来源',purpose:'转写、加工、来源、纠正与影响。'},
 {id:'work',title:'项目与工作',purpose:'项目、事项、成果采用和阶段回执。'},
 {id:'collaboration',title:'协作与经验',purpose:'上下文接续、交接、经验、变化及治理候选。'},
 {id:'identity',title:'身份与凭据',purpose:'资格、委派、凭据申请审批、取用和轮换。'},
 {id:'resources',title:'云资源与工程',purpose:'资源供应商和已登记项目施工；公开API可进一步读取工程、交付接口。',public_api:[{system:'hufu',method:'GET',path:'/v2/database-access/help'},{system:'hufu',method:'GET',path:'/v2/engineering/help'},{system:'hufu',method:'GET',path:'/v2/vault/deliveries/help'}]}
];
const groupOf=n=>{
 if(['mem.vector.index','mem.vector.search'].includes(n))return'compatibility';
 if(n==='hub.services'||n.startsWith('database.'))return'resources';
 if(/^(provider\.|resource\.)/.test(n))return'resources';
 if(/^(hufu[._])/.test(n)&&!/[._](whoami|context)$/.test(n))return'identity';
 if(/(description|semantic|vector|index\.text)/.test(n))return'search';
 if(/(processing|asr|source\.invalidate|impact)/.test(n))return'processing';
 if(/(object|upload|multipart|offline|compensation|gc\.|url\.|archive|stage_)/.test(n))return'storage';
 if(/(context\.|handoff|experience|changes|governance)/.test(n)&&!/^hufu/.test(n))return'collaboration';
 if(/^v8\./.test(n)||/^hub\.work/.test(n))return'work';
 if(/^(mem\.|mengchu_|hub\.material|hub\.document)/.test(n))return'materials';
 return'navigation';
};
export function catalogue(full,args={}){
 const tools=[...new Map(full.map(t=>[t.name,t])).values()].map(withResearchGuidance);
 if(args.tool){const t=tools.find(t=>t.name===args.tool);return t?{state:'contract',tool:t,invoke:{tool:'hub.invoke',arguments:{tool:t.name,arguments:{}}},authority:'same_current_identity_and_service_rules'}:{state:'not_found',next_step:'search_by_query_or_group'};}
 if(!args.group&&!args.query)return{state:'groups',groups:groups.map(g=>({...g,tools_count:tools.filter(t=>groupOf(t.name)===g.id).length})),reading:{tool:'hub.tools',arguments:{group:'materials'}},rules:'Agent_can_expand_multiple_groups;no_permission_changes',total_tools:tools.length};
 const q=(args.query||'').toLowerCase(),matching=tools.filter(t=>(!args.group||groupOf(t.name)===args.group)&&(!q||(t.name+' '+t.description).toLowerCase().includes(q)));
 const offset=Math.max(0,args.offset||0),limit=Math.min(100,Math.max(1,args.limit||30)),items=matching.slice(offset,offset+limit).map(t=>({name:t.name,purpose:t.description,contract:{tool:'hub.tools',arguments:{tool:t.name}}}));
 return{state:'capabilities',group:groups.find(g=>g.id===args.group)||null,items,total_matching:matching.length,next_offset:offset+items.length<matching.length?offset+items.length:null,coverage:'actual_current_connection_tool_catalog;provider_readiness_and_authority_checked_on_call'};
}
export const defaultNames=new Set(['hub.work.find','hub.resolve','hufu_whoami','hufu_context','hub.tools','hub.invoke','hub.help','hub.project.open','hub.materials.find','hub.document.open','hub.document.save','hub.work.resume','v8.work.save','hub2_api']);


const researchExamples={
 'hub.work.find':[{short_no:1000152}],
 'hub.work.resume':[{project_id:'<found.project_id>',work_item_id:'<found.work_item_id>',include_history:false}],
 'hub2_api':[{system:'hufu',method:'GET',path:'/v2/engineering/help'},{system:'hufu',method:'POST',path:'/v2/engineering/execute',body:{project_id:'<authorized project_id>',action:'runtime',parameters:{target:'<runtime_targets.target_id from authorization catalog>',action:'status',parameters:{}}}}],
 'hub.materials.find':[{scope:'new',project_id:'<project_id from project lookup>',q:'<topic or filename>',semantic:false,limit:5}],
 'hub.document.open':[{project_id:'<candidate.project_id>',material_id:'<candidate.reference.material_id>',version_id:'<candidate.reference.version_id>',sha256:'<candidate.reference.sha256>'},{file_id:'<known legacy file ID>'}],
 'mem.search':[{project_id:'<project_id>',query:'<topic>',limit:5}],
 'v8.work.search':[{project_id:'<project_id>',query:'<goal>',limit:5}],
 'v8.work.read':[{project_id:'<selected.project_id>',work_item_id:'<selected.work_item_id>'}]
};
function withResearchGuidance(t){
 const examples=researchExamples[t.name];if(!examples)return t;
 const required=['mem.search','v8.work.search'].includes(t.name)?['project_id']:t.name==='v8.work.read'?['project_id','work_item_id']:t.inputSchema?.required||[];
 return {...t,inputSchema:{...t.inputSchema,required:[...new Set([...(t.inputSchema?.required||[]),...required])]},examples:examples.map(arguments_=>({tool:'hub.invoke',arguments:{tool:t.name,arguments:arguments_},template:true,replace_placeholders_with_authorized_scope:true})),calling_guidance:{version:'research-efficiency-v1.1',shortest_path:'known_work_number:hub.work.find_then_hub.work.resume_then_selected_fixed_document;known_project_and_work_uuid:hub.work.resume_directly;expand_history_only_if_needed',contract_reuse:'retain_minimum_example_and_observed_contract_version_in_work_handoff;refresh_on_schema_change_or_invalid_input;identity_scope_is_not_cached_authority',batch:'verify_one_request_before_parallel_fanout;stop_unsent_same_scope_requests_after_first_permission_denial;already_dispatched_requests_remain_observed_facts;reuse_observed_contract_in_same_work',invalid_input:'read_contract_and_correct_once;do_not_replay_identical_invalid_arguments',permission_denied:'stop_branch;do_not_switch_wrappers_to_bypass_authority',read_transport_failure:'one_same_request_retry_total_for_busy_502_or_transport_then_change_path_with_evidence_or_stop',write_transport_failure:'query_existing_operation;reuse_original_idempotency_key',no_match:'state_searched_scope;seek_new_clue_or_stop;partial_coverage_is_not_nonexistence'}};
}
