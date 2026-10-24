import{createHash}from'node:crypto';
const hash=x=>createHash('sha256').update(x).digest('hex');
const fail=message=>{throw Object.assign(Error(message),{status:400})};
const views=['mine','pending','managed'];
const specs={
 application_private:{path:'/v2/authorization/legacy-grants/requests',paged:false,limit:null},
 project:{path:null,paged:true,limit:200,sql:'authorization_applications'},
 engineering:{path:'/v2/engineering/requests',paged:false,limit:null},
 database:{path:'/v2/database-access/requests',paged:true,limit:200},
 vault:{path:'/v2/vault/applications',paged:true,limit:100},
 delivery:{path:'/v2/vault/deliveries/applications',paged:true,limit:100},
 service_resource:{path:'/v2/services/resource-packages/list',paged:true,limit:200}
};
export const authorizationInboxContract={view:{enum:views},source_kind:{enum:Object.keys(specs)},cursor:{type:'string'},state:{enum:['pending','approved','rejected','withdrawn']},limit:{type:'integer',minimum:1,maximum:200}};
/** Existing authority processors remain the only facts. Root replaces only the old aggregate handler. */
export function createAuthorizationInbox({pool,invoke}){
 const sql=async(name,proof,b)=>(await pool.query('SELECT authz.'+name+'($1,$2) result',[proof,b])).rows[0].result;
 return async function inbox(token,b={}){
  if(!b||Array.isArray(b)||Object.keys(b).some(k=>!Object.hasOwn(authorizationInboxContract,k)))fail('invalid_inbox_input');
  const view=b.view??'mine';if(!views.includes(view))fail('invalid_inbox_view');
  if(b.source_kind!==undefined&&!specs[b.source_kind])fail('invalid_inbox_source');
  if(b.cursor!==undefined&&(!b.source_kind||!specs[b.source_kind].paged||!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(b.cursor)))fail('cursor_requires_original_paged_source');
  if(b.state!==undefined&&(b.source_kind!=='vault'||!authorizationInboxContract.state.enum.includes(b.state)))fail('state_filter_requires_vault_source');
  if(b.limit!==undefined&&(!['project','database','delivery','service_resource'].includes(b.source_kind)||!Number.isInteger(b.limit)||b.limit<1||b.limit>(b.source_kind==='delivery'?100:200)))fail('limit_requires_project_database_or_delivery_source');
  const proof=hash(token),identity=(await pool.query('SELECT authz.authenticate($1) result',[proof])).rows[0].result;
  const selected=b.source_kind?[b.source_kind]:Object.keys(specs);
  const outcomes=await Promise.allSettled(selected.map(async kind=>{
   const spec=specs[kind],body=kind==='service_resource'?{view,state:view==='pending'?'pending':'all',limit:b.limit??200}:{view};if(spec.paged&&b.cursor)body.cursor=b.cursor;
   if(kind==='vault'&&b.state)body.state=b.state;if(['project','database','delivery','service_resource'].includes(kind))body.limit=b.limit??spec.limit;
   const data=spec.sql?await sql(spec.sql,proof,body):await invoke(spec.path,token,body);
   return{kind,spec,body,data};
  }));
  const actorIds=[...new Set(outcomes.flatMap(o=>o.status==='fulfilled'?(o.value.data.items??o.value.data.applications??[]):[]).flatMap(x=>[x.actor_id,x.applicant_id,x.requester_id,x.grantee_id,x.owner_actor_id,x.requested_by]).filter(x=>typeof x==='string'&&/^[a-f0-9-]{36}$/i.test(x)))];
  let actorLabels=new Map();
  if(actorIds.length){const labels=(await pool.query('SELECT authz.authorization_actor_labels($1,$2::uuid[]) result',[proof,actorIds])).rows[0].result;actorLabels=new Map(labels.map(x=>[x.id,x.label]));}
  const scopeText=(kind,x)=>kind==='service_resource'?'资源整包审批与实际交付分开；未交付项沿原包补齐':kind==='database'?(x.objects?.length??0)+' 张表；'+([...new Set((x.objects??[]).flatMap(o=>o.actions??[]))].every(a=>a==='inspect')?'仅看结构，不读取业务数据':'按列明表和动作访问'):kind==='engineering'?'本项目工程工作区、构建与部署；不包含整台服务器':kind==='application_private'?'指定个人资料的'+x.resource_type+'，范围'+x.scope+'；需要实际所有人和主管确认':kind==='project'?(x.profile==='business'?'本项目普通业务完整范围':'列明资源动作与范围'):'按申请列明条目与领取范围';
  const items=[],coverage=[];
  for(let n=0;n<outcomes.length;n++){
   const outcome=outcomes[n],kind=selected[n],spec=specs[kind];
   if(outcome.status==='rejected'){
    const code=outcome.reason?.message??'source_unavailable';coverage.push({kind,state:'unavailable',error_code:code,original_route:{method:'POST',path:spec.path,body:{view,...(kind==='delivery'?{limit:b.limit??100}:{})}},scope_hint:kind==='delivery'&&code==='forbidden'?(identity.scope_filters?.length?'current_original_software_has_project_filters;organization_delivery_view_may_be_outside_scope;check_current_reviewer_role_and_actions;do_not_repeat_OTP_blindly':'check_current_organization_reviewer_role_and_software_actions;forbidden_does_not_imply_OTP_failure'):null,has_more:'unknown',complete:false});continue;
   }
   const {body,data}=outcome.value;
   for(const x of data.items??data.applications??[]){
    const requesterId=x.actor_id??x.applicant_id??x.requester_id??x.grantee_id??x.requested_by;
    // Defense and explicit invariant; original SQL performs filtering before pagination.
    if(view==='mine'&&requesterId!==identity.actor_id)continue;
    items.push({...x,kind,request_id:x.id??x.request_id??x.application_id??x.package_id,actual_handler:spec.path??'authz.'+spec.sql,human_summary:{requester:x.requester??x.applicant??x.member_label??actorLabels.get(requesterId)??requesterId,project:x.project_title??x.project_id??'本人凭据交付',purpose:x.purpose??x.summary??'',scope:x.objects??x.resource_scope??x.actions??x.entry_id??null,scope_text:scopeText(kind,x),expires_at:x.requested_until??x.requested_expires_at??x.expires_at??null}});
   }
   const next=data.next_cursor??null,hasMore=spec.paged?Boolean(next):data.has_more??(spec.limit?((data.items??[]).length>=spec.limit?'unknown':false):false);
   const nextBody=next?{...body,cursor:next}:null;
   coverage.push({kind,state:'read',original_route:spec.path?{method:'POST',path:spec.path,body}:null,original_sql:spec.sql?'authz.'+spec.sql:null,readable_entry:spec.sql?{method:'POST',path:'/v2/authorization/applications',body:{view,source_kind:kind}}:null,pagination:{supported:spec.paged,ordering:kind==='vault'?'UUID ascending':spec.paged?'created_at,UUID descending':'original source order',limit:body.limit??spec.limit??'uncapped original query',next_cursor:next},has_more:hasMore,complete:hasMore===false,coverage:spec.paged?'original_authority_page':spec.limit?'bounded_current_scope_no_cursor':'original_current_scope_query_no_cursor',continuation:next?{unified:{method:'POST',path:'/v2/authorization/applications',body:{view,source_kind:kind,cursor:next,...(b.state?{state:b.state}:{}),...(['project','database','delivery','service_resource'].includes(kind)?{limit:body.limit}:{})}},original:{method:'POST',path:spec.path,body:nextBody}}:null});
  }
  if(b.source_kind&&b.cursor&&coverage[0]?.error_code?.startsWith('cursor_not_currently_visible'))return{state:'cursor_rejected',view,source_kind:b.source_kind,error_code:'cursor_not_currently_visible',next_step:'read_first_page_without_cursor_with_current_scope',items:[],coverage,complete:false};
  return{state:'read',view,items,coverage,complete:coverage.every(x=>x.complete===true),note:'Seven current authorities including service resource packages;pending packages include approved but undelivered resources;approval is not delivery;unavailable sources are not empty inboxes.'};
 };
}
