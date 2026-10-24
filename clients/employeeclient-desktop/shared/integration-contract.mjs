// Ordinary EmployeeClient integration HTTP contract. No MCP server or client configuration.
const text=(maxLength=128)=>({type:'string',minLength:1,maxLength});
const target={type:'string',description:'省略或 assistant 为本人文件传输助手；group 为员工客户端工作群；其他值必须是 members 返回的 username（真实 actor_id）。'};
const operation=(name,method,path,description,properties={},required=[])=>({name,method,path,description,input_schema:{type:'object',properties,required,additionalProperties:false}});
export const integrationOperations=[
 operation('members','GET','/members','员工客户端：查询本人有权联系的真实成员；返回的 username 就是真实 actor_id，用于明确选择私聊对象。'),
 operation('conversations','GET','/conversations','员工客户端：查询本人会话、未读和文件传输助手；查询不标记已读。'),
 operation('messages','GET','/messages','员工客户端：分页查询消息、附件和关键词，默认本人文件传输助手；不更改已读。',{target,q:{type:'string',maxLength:200},before:{type:'integer',minimum:0},after:{type:'integer',minimum:0},limit:{type:'integer',minimum:1,maximum:100}}),
 operation('message','GET','/messages/:message_id','员工客户端：按消息ID查询本人有权查看的发送回执/消息。',{message_id:text()},['message_id']),
 operation('send','POST','/messages','员工客户端：用本人身份发送文字，默认文件传输助手；其他成员/工作群须明确选择，不能自动群发。回执 message 才是成功。',{target,body:text(20000),reply_to_id:text()},['body']),
 operation('send_file','POST','/files/send','员工客户端：把本人有权读取的员工客户端项目固定文件发送到助手/明确会话；自动存储，私聊复用端到端附件加密。当前源文件1字节至2MiB；不接任意URL、本地路径或Base64，较大文件仍使用桌面上传。',{target,body:{type:'string',maxLength:20000},material_id:text(),version_id:text(),sha256:{type:'string',pattern:'^[a-f0-9]{64}$'},name:text(200),mime:text(200)},['material_id','version_id','sha256','name','mime'])
];
export function validateIntegrationInput(name,args){
 const spec=integrationOperations.find(t=>t.name===name)?.input_schema;
 const invalid=()=>{throw Object.assign(Error('integration_arguments_invalid'),{code:'integration_arguments_invalid',status:400});};
 if(!spec||!args||typeof args!=='object'||Array.isArray(args))invalid();
 if(Object.keys(args).some(k=>!Object.hasOwn(spec.properties,k))||spec.required.some(k=>!Object.hasOwn(args,k)))invalid();
 for(const [k,v] of Object.entries(args)){const p=spec.properties[k];if(p.type==='string'&&(typeof v!=='string'||p.minLength&&v.length<p.minLength||p.maxLength&&v.length>p.maxLength||p.pattern&&!new RegExp(p.pattern).test(v)))invalid();if(p.type==='integer'&&(!Number.isSafeInteger(v)||v<p.minimum||v>p.maximum))invalid();}
 if(args.before!==undefined&&args.after!==undefined)invalid();
 if(args.target!==undefined&&(typeof args.target!=='string'||!args.target||args.target.length>128))invalid();
 if(name==='send_file'&&(!/^[a-f0-9-]{36}$/i.test(args.material_id)||!/^[a-f0-9-]{36}$/i.test(args.version_id)||/[\x00-\x1f]/.test(args.name)||/[\r\n]/.test(args.mime)))invalid();
}
