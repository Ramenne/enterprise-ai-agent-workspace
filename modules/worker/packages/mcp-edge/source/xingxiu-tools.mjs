const string={type:'string'},uuid={type:'string',format:'uuid'},limit={type:'integer',minimum:1,maximum:50};
const specs=[
 ['xingxiu.query','查询成员关联工作与当前原始状态；默认progress排除背景资料和私人请求。view=background/all可查获准背景；显式material:编号保持兼容。include_history可读取本人获准历史理解。返回关系、过时提示、覆盖和来源，登记作者不等于执行者。','/query',{member_id:uuid,project_id:uuid,work_id:string,limit,view:{type:'string',enum:['progress','background','all']},include_history:{type:'boolean'}},[]],
 ['xingxiu.agents','查询成员一对一星宿Agent身份、维护状态与最近错误。普通成员只看自己的Agent；主管可看组织登记。','/agents',{},[]],
 ['xingxiu.request','向本人的星宿维护Agent提交理解或上下文请求。按15分钟周期处理；不自动执行业务或扩大权限。','/request',{text:{type:'string',minLength:1,maxLength:8000},project_id:uuid,work_id:uuid,idempotency_key:{type:'string',minLength:1,maxLength:200}},['text','idempotency_key']],
 ['xingxiu.request.status','查询本人已提交请求的处理结果。','/request-status',{request_id:uuid},['request_id']],
 ['xingxiu.maintenance.run','主管触发发现；process_pending=true可释放指定成员已有任务的本轮处理，仍沿原队列和并发限制。返回queued不代表已完成。','/run',{member_id:uuid,process_pending:{type:'boolean'}},[]],
 ['xingxiu.maintenance.metrics','主管查询实际观察成本、共享理解复用、资料/工作分布与日统计；供收工复盘。缺usage不等于零成本，各调用层不能混加为独立请求。','/metrics',{since:{type:'number',minimum:0},days:{type:'integer',minimum:1,maximum:7}},[]],
 ['xingxiu.agents.register','主管登记活跃成员的一对一内部Agent，并刷新成员当前团队范围的读取授权。秘密只留服务器。','/register',{},[]]
];
export const xingxiuTools=specs.map(([name,description,path,properties,required])=>({name,description,inputSchema:{type:'object',properties,required,additionalProperties:false},annotations:{readOnlyHint:['/query','/agents','/metrics','/request-status'].includes(path)}}));
export const xingxiuRoute=name=>specs.find(x=>x[0]===name)?.[2];
