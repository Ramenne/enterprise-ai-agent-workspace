import {fullDateTime} from '../ui/date.mjs';
// Discover business attributes from current authorized records, never from UI
// presets, historical filter selections, or internal audit/transport metadata.
const DESCRIPTION=/^(description|简介|summary|brief|current_summary)$/i;
const LABELS={description:'简介',summary:'摘要',reviewed:'已核对',visibility:'范围',explanation:'说明',completion_claim:'完成说明',name:'名称',file_no:'文件编号',short_no:'工作编号',file_format:'格式',importance_level:'重要性',importance_class:'重要性等级',state:'状态',kind:'持续类型',producer:'制作来源',origin_kind:'来源类型',material_kind:'资料类别',record_kind:'记录类别',work_no:'所属工作',category:'分类',type:'类型',purpose:'用途',stage:'阶段',language:'语言',tags:'标签',related_work_no:'关联工作',related_projects:'相关项目',related_project_ids:'相关项目',project_id:'项目',owner_id:'所有者',manager_id:'主管',size:'大小',sha256:'内容校验',version_id:'固定版本',material_id:'资料标识',local_version_no:'文件内版本',metadata_revision:'属性修订',content_revision:'正文修订',event_revision:'事件修订',reason:'说明依据',judged_at:'判断时间',judged_by:'判断人',important:'重要标记',status:'状态',created_at:'创建时间',updated_at:'更新时间'};
export function valueKey(value){return JSON.stringify(value);}
export function valueLabel(value,key=''){
 if(value===null)return '未设置';if(typeof value==='boolean')return value?'是':'否';
 if(key==='importance_level')return ({0:'特级',1:'一级',2:'二级',3:'三级'})[value]||String(value);
 if(key==='state'||key==='status')return ({in_progress:'进行中',pending:'待处理',paused:'已暂停',active:'进行中',completed:'已完成',cancelled:'已取消',published:'已发布',archived:'已归档'})[value]||'其他状态';
 if(['short_no','work_no','related_work_no'].includes(key)&&Number.isSafeInteger(Number(value)))return '#'+value;
 if(['created_at','updated_at'].includes(key)){const date=new Date(value);return Number.isNaN(date.getTime())?String(value):fullDateTime(date);}
 if(key==='kind')return ({project:'项目',dialogue:'对话'})[value]||String(value);
 return String(value);
}
export function attributeLabel(path){const parts=path.split('.');const leaf=parts.at(-1);return LABELS[leaf]||leaf;}
export function attributeFields(row){
 const fields={};
 const add=(path,value)=>{if(value===undefined)return;if(!fields[path])fields[path]=[];const values=fields[path];if(!values.some(x=>valueKey(x)===valueKey(value)))values.push(value);};
 const visit=(value,path)=>{
  if(DESCRIPTION.test(path.split('.').at(-1)||''))return;
  if(Array.isArray(value)){if(!value.length)fields[path]=[];for(const item of value)visit(item,path);return;}
  if(value!==null&&typeof value==='object'){for(const [key,part] of Object.entries(value))visit(part,path?path+'.'+key:key);return;}
  if(['string','number','boolean'].includes(typeof value)||value===null)add(path,value);
 };
 add('name',row.type==='work'?row.goal:row.title||row.name||row.logical_path?.split('/').at(-1));
 // Fixed query attributes described by the current hub material contract.
 // IDs, hashes, revisions and audit/source envelopes belong in details.
 for(const key of ['file_no','short_no','file_format','importance_level','state','created_at','updated_at'])add(key,row[key]);
 if(row.related_work_no?.length)visit(row.related_work_no,'related_work_no');
 visit(row.projectProperties?.attributes||{},'project.attributes');
 visit(row.properties?.attributes||{},'properties.attributes');
 return fields;
}
export function attributeCatalog(rows){
 const catalog=new Map();for(const row of rows){for(const [key,values] of Object.entries(attributeFields(row))){if(!catalog.has(key))catalog.set(key,{key,label:attributeLabel(key),options:new Map()});const entry=catalog.get(key);for(const value of values)entry.options.set(valueKey(value),{value:valueKey(value),label:valueLabel(value,key.split('.').at(-1))});}}
 const counts=new Map();for(const e of catalog.values())counts.set(e.label,(counts.get(e.label)||0)+1);for(const e of catalog.values())if(counts.get(e.label)>1)e.label+='（'+(e.key.split('.').slice(0,-1).map(p=>({project:'项目',properties:'属性',attributes:'扩展',governance:'分级',source_claim:'来源'})[p]||p).join('·')||'基础')+'）';
 const order=['name','importance_level','file_format','state'];
 return [...catalog.values()].sort((a,b)=>{const rank=k=>order.includes(k)?order.indexOf(k):100;return rank(a.key)-rank(b.key)||a.label.localeCompare(b.label,'zh-CN');}).map(entry=>({...entry,options:[...entry.options.values()].sort((a,b)=>a.label.localeCompare(b.label,'zh-CN'))}));
}
// A selected value remains clearable when it is absent from the current page.
// It is retained user input, not a claim about complete project facets.
export function attributeSelectionCatalog(rows,selected={}){
 const fields=attributeCatalog(rows);
 for(const [key,value]of Object.entries(selected))if(value){let field=fields.find(f=>f.key===key);if(!field){field={key,label:attributeLabel(key),options:[]};fields.push(field);}if(!field.options.some(o=>o.value===value)){try{field.options.push({value,label:valueLabel(JSON.parse(value),key.split('.').at(-1))});}catch{}}}
 return fields;
}
// Scope labels reflect only the project kinds returned by the authorized hub.
// An obsolete or unknown kind cannot become a third UI permission category.
export function projectScopeOptions(projects){
 const labels={team:'团队',personal:'个人'};
 return Object.entries(labels).filter(([value])=>projects.some(p=>value==='personal'?['personal','private'].includes(p.visibility):p.visibility===value)).map(([value,label])=>({value,label}));
}
export function retainAttributeSelection(rows,selected){
 const catalog=attributeCatalog(rows);
 return Object.fromEntries(Object.entries(selected||{}).filter(([key,value])=>value&&catalog.some(field=>field.key===key&&field.options.some(option=>option.value===value))));
}
export function filterAttributes(rows,selected){return rows.filter(row=>{const fields=attributeFields(row);return Object.entries(selected).every(([key,value])=>!value||(fields[key]||[]).some(v=>valueKey(v)===value));});}
// Match already available display metadata for immediate local rendering.
// Authoritative search and attribute filtering are performed by query-projection.
export function metadataMatches(row,query){
 const text=query.trim().toLocaleLowerCase();if(!text)return true;
 const aliases=[row.short_no&&'#'+row.short_no,row.file_no,row.display_no,row.goal,row.title,row.name,row.logical_path,row.description,row.summary];
 return aliases.some(v=>v!==undefined&&String(v).toLocaleLowerCase().includes(text))||JSON.stringify(row.properties||{}).toLocaleLowerCase().includes(text);
}
