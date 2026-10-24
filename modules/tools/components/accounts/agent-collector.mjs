import {createHmac} from 'node:crypto';
const fail=(status,message)=>Object.assign(Error(message),{status});
export function createAgentCollector(db,{origin='http://127.0.0.1:18766',transport=fetch}={}){
 db.exec('CREATE TABLE IF NOT EXISTS tools_collector_jobs(actor TEXT NOT NULL,id TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(actor,id))');
 async function request(path,body,key){
  let response;try{response=await transport(origin+path,{method:body?'POST':'GET',headers:{'Content-Type':'application/json',...(key?{'Idempotency-Key':key}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(60000)})}catch{throw fail(503,'素材解析服务暂未确认，请保留原请求核对')}
  let data;try{data=await response.json()}catch{throw fail(503,'素材解析服务没有返回有效结果')}
  if(!response.ok)throw fail([400,403,404,409,413,429].includes(response.status)?response.status:503,typeof data.detail==='string'?data.detail:'素材解析服务尚未完成');return data;
 }
 const own=(member,id)=>{if(typeof id!=='string'||!/^[-_a-zA-Z0-9]{1,100}$/.test(id))throw fail(400,'解析任务编号无效');if(!db.prepare('SELECT 1 FROM tools_collector_jobs WHERE actor=? AND id=?').get(member.owner,id))throw fail(404,'当前成员没有这项解析任务')};
 return {
  async capabilities(){const health=await request('/api/health');return {state:'available',service:health.service,version:health.version,mode:'browser_direct_download',supported:['public video/image source parsing','explicit selected-asset download manifests'],downloaded:false,limitations:['平台URL可能过期','B站分轨须由调用端无转码合并','任务只在解析服务进程中保留约30分钟','实际落盘由调用端或本机采集MCP完成，本接口不返回虚构本机路径']}},
  async start(member,args,operationId){if((await request('/api/health')).agent_idempotency!==true)throw fail(503,'素材解析接口尚未完成固定请求核对接入');const master=Buffer.from(process.env.XIANYU_KEY||'','base64');if(master.length!==32)throw fail(503,'采集请求核对密钥未配置');const idempotency='tools-agent:'+createHmac('sha256',master).update(member.owner+'\0'+operationId).digest('hex');const job=await request('/api/collector/tasks',{text:args.text,known_urls:args.knownUrls||[]},idempotency);if(typeof job.id!=='string')throw fail(503,'解析服务未返回任务编号');db.prepare('INSERT OR IGNORE INTO tools_collector_jobs VALUES(?,?,?)').run(member.owner,job.id,new Date().toISOString());return {state:'accepted',job,downloaded:false}},
  async status(member,id){own(member,id);const job=await request('/api/collector/tasks/'+encodeURIComponent(id));return {...job,downloaded:false,delivery:'source_urls_to_caller'}},
  async manifest(member,args){const job=await this.status(member,args.jobId);if(!['complete','failed'].includes(job.state))return {state:'pending',jobId:args.jobId,downloaded:false};const media=(job.works||[]).flatMap(w=>(w.items||[]).map(item=>({...item,source:w.source,title:w.title,platform:w.platform})));const unique=[...new Set(args.mediaIds)];if(!unique.length||unique.some(id=>!media.some(m=>m.id===id)))throw fail(400,'只可选择本次解析得到的明确素材编号');return {state:'delivery_required',jobId:args.jobId,downloaded:false,files:unique.map(id=>media.find(m=>m.id===id)),instructions:'由调用端直连来源下载原文件；B站音画分轨无转码合并。只有调用端实际落盘并核对后才能声明下载完成。'}}
 };
}
