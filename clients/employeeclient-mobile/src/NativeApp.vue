<script setup lang="ts">
import {computed,onMounted,ref} from 'vue';
import ChoiceSelect from './ui/components/ChoiceSelect.vue';
import {serviceOrigin} from './api/runtime';
import {NativeClient,NativeError} from './native/client.mjs';
type Project={project_id:string;title:string;visibility:string};
type Material={material_id:string;version_id:string;sha256:string;logical_path:string;display_no?:string};
type Work={work_item_id:string;short_no:number;goal:string;state:string};
const signedIn=ref(false),restoring=ref(true),name=ref(''),email=ref(''),otp=ref(''),error=ref(''),busy=ref(false),sent=ref(false);
const client=new NativeClient({base:serviceOrigin(),onUnauthorized:()=>{signedIn.value=false;name.value='';clearView();}});
const projects=ref<Project[]>([]),project=ref(''),files=ref<Material[]>([]),works=ref<Work[]>([]),query=ref(''),tab=ref('files');
const coverage=ref(''),detail=ref(''),nextWorkCursor=ref<string|undefined>(),loading=ref(false);
const uploadFile=ref<File|null>(null),uploadNotice=ref('');
const options=computed(()=>projects.value.map(p=>({value:p.project_id,label:p.title+(p.visibility==='team'?' · 团队':' · 个人')})));
let viewEpoch=0;
function clearView(){viewEpoch++;files.value=[];works.value=[];detail.value='';coverage.value='';project.value='';projects.value=[];}
function explain(e:unknown){return e instanceof NativeError?({unauthenticated:'登录已过期，请重新验证邮箱。',login_required:'请先验证本人邮箱。',forbidden:'当前账号没有这项资料权限。',origin_denied:'当前应用地址尚未配置。',native_session_cookie_missing:'登录会话未建立，请重试。',browser_download_limit_64MiB:'当前支持下载 64 MiB 以内的文件。',native_upstream_unavailable:'暂时无法连接中枢，请稍后重试。'} as Record<string,string>)[e.code]||e.code:'请求未完成，请检查连接后重试。';}
async function loadIdentity(){const session=await client.session();name.value=session.user?.name||session.identity.actor_id;signedIn.value=true;projects.value=await client.projects();if(!project.value&&projects.value.length)project.value=projects.value[0].project_id;await load();}
async function send(){if(busy.value)return;busy.value=true;error.value='';try{await client.sendCode(email.value.trim());sent.value=true;}catch(e){error.value=explain(e);}finally{busy.value=false;}}
async function login(){if(busy.value)return;busy.value=true;error.value='';try{await client.signIn(email.value.trim(),otp.value);await loadIdentity();}catch(e){error.value=explain(e);}finally{otp.value='';busy.value=false;}}
async function load(){const n=++viewEpoch,p=project.value;files.value=[];works.value=[];detail.value='';coverage.value='';nextWorkCursor.value=undefined;if(!p)return;loading.value=true;error.value='';try{if(tab.value==='files'){const result=await client.files(p,query.value);if(n!==viewEpoch)return;files.value=result.items||[];coverage.value='当前关键词匹配资料，最多显示 100 份；这不是项目全量清单。';}else{const result=await client.works(p);if(n!==viewEpoch)return;works.value=result.items||[];nextWorkCursor.value=result.next_cursor;coverage.value=result.coverage?.complete?'当前有权工作已列出。':'当前工作分页，可继续读取。';}}catch(e){if(n===viewEpoch)error.value=explain(e);}finally{if(n===viewEpoch)loading.value=false;}}
async function moreWorks(){const cursor=nextWorkCursor.value;if(!cursor||loading.value)return;const n=viewEpoch;loading.value=true;try{const result=await client.works(project.value,cursor);if(n!==viewEpoch)return;works.value.push(...(result.items||[]));nextWorkCursor.value=result.next_cursor;}catch(e){if(n===viewEpoch)error.value=explain(e);}finally{if(n===viewEpoch)loading.value=false;}}
async function download(file:Material){if(busy.value)return;busy.value=true;error.value='';const n=viewEpoch,p=project.value;try{const head=await client.head(p,file.material_id);if(n!==viewEpoch)return;const fixed=head.fixed_ref;if(fixed.version_id!==file.version_id){error.value='资料已有新版本，请刷新列表后重新选择。';return;}const blob=await client.readFile(p,fixed);if(n!==viewEpoch)return;const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=file.logical_path.split('/').at(-1)||'资料';a.click();setTimeout(()=>URL.revokeObjectURL(url),60000);}catch(e){if(n===viewEpoch)error.value=explain(e);}finally{busy.value=false;}}
async function openWork(work:Work){const n=viewEpoch;error.value='';try{const result=await client.work(project.value,work.work_item_id);if(n===viewEpoch)detail.value=JSON.stringify(result,null,2);}catch(e){if(n===viewEpoch)error.value=explain(e);}}
function chooseFile(event:Event){uploadFile.value=(event.target as HTMLInputElement).files?.[0]||null;uploadNotice.value='';}
async function upload(){
  const file=uploadFile.value,p=project.value,scope=client.partition,n=viewEpoch;
  if(!file||!p||busy.value)return;busy.value=true;error.value='';uploadNotice.value='';
  const storageKey='qn.native.upload.'+scope+'.'+p;
  try{
    const saved=localStorage.getItem(storageKey);let operation=saved?JSON.parse(saved):null;
    if(operation&&operation.name!==file.name)throw new NativeError('pending_upload_select_original_file');
    const key=operation?.key||crypto.randomUUID();
    if(!operation){operation={key,name:file.name};localStorage.setItem(storageKey,JSON.stringify(operation));}
    if(!operation.operation_id){operation=await client.prepareUpload(p,file,key);if(n!==viewEpoch||client.partition!==scope)return;localStorage.setItem(storageKey,JSON.stringify(operation));}
    const result=await client.finishUpload(operation,file);
    if(client.partition!==scope)return;
    localStorage.removeItem(storageKey);
    if(n!==viewEpoch)return;
    uploadNotice.value='文件已发布到当前项目：'+(result.fixed_refs[0].display_no||result.fixed_refs[0].file_display_no||'固定版本已确认');
    uploadFile.value=null;await load();
  }catch(e){if(n===viewEpoch)error.value=explain(e)+'。重试时选择同一原文件，继续原上传操作。';}finally{busy.value=false;}
}
onMounted(async()=>{localStorage.removeItem('qn.session');try{await loadIdentity();}catch(e){if(!(e instanceof NativeError&&e.status===401))error.value=explain(e);}finally{restoring.value=false;}});
</script>
<template>
  <main class="native-page">
    <header><img src="/employeeclient.svg" alt="员工客户端" width="36"><h1>员工客户端</h1><small>{{ signedIn?name:'0.49.19' }}</small></header>
    <p v-if="restoring">正在确认本人身份…</p>
    <section v-else-if="!signedIn" class="connection-card">
      <h2>连接你的中枢</h2><p>使用身份权限服务成员邮箱接收验证码。</p>
      <form @submit.prevent="login"><label>成员邮箱<input class="input" v-model="email" type="email" autocomplete="username" required :disabled="busy"></label>
        <label>验证码<input class="input" v-model="otp" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]{6}" required :disabled="busy"></label>
        <button type="button" class="btn" @click="send" :disabled="busy||!email">获取验证码</button>
        <p v-if="sent">验证码已请求，请检查本人邮箱。</p>
        <button type="submit" class="btn primary" :disabled="busy">{{busy?'正在连接…':'连接'}}</button>
      </form>
    </section>
    <section v-else>
      <ChoiceSelect v-model="project" :options="options" label="当前项目" @update:model-value="load"/>
      <p v-if="!projects.length">当前身份尚无可访问项目。</p>
      <nav><button class="btn" @click="tab='files';load()">资料</button><button class="btn" @click="tab='works';load()">工作</button></nav>
      <form v-if="tab==='files'" @submit.prevent="load"><input class="input" v-model="query" placeholder="查找项目资料" aria-label="关键词"><button class="btn" :disabled="loading">查找</button></form>
      <form v-if="tab==='files'&&project" @submit.prevent="upload"><label>上传到当前项目<input type="file" @change="chooseFile" :disabled="busy"></label><button class="btn" :disabled="busy||!uploadFile">{{busy?'处理中…':'上传'}}</button><p v-if="uploadNotice">{{uploadNotice}}</p></form>
      <p v-if="loading">正在读取…</p><small>{{coverage}}</small>
      <article v-for="file in files" :key="file.material_id" class="native-row"><div><strong>{{file.logical_path.split('/').at(-1)}}</strong><small>{{file.display_no}}</small></div><button class="btn" @click="download(file)" :disabled="busy">下载</button></article>
      <article v-for="work in works" :key="work.work_item_id" class="native-row"><div><strong>#{{work.short_no}} · {{work.goal}}</strong><small>{{work.state}}</small></div><button class="btn" @click="openWork(work)">查看</button></article>
      <button v-if="nextWorkCursor" class="btn" @click="moreWorks" :disabled="loading">更多工作</button>
      <pre v-if="detail">{{detail}}</pre>
      <p class="muted">聊天和协作服务迁移中，暂不可用。</p>
    </section>
    <p v-if="error" class="error-text" role="alert">{{error}}</p>
  </main>
</template>
<style scoped>
.native-page{max-width:560px;margin:0 auto;padding:20px 16px calc(24px + env(safe-area-inset-bottom));}header{display:flex;gap:10px;align-items:center;}header h1{font-size:22px;flex:1;}nav{display:flex;gap:8px;margin:16px 0;}label,small{display:block;}label{margin:16px 0;}form>.btn{margin:10px 8px 10px 0;}.native-row{display:flex;align-items:center;gap:12px;padding:16px 0;border-bottom:1px solid var(--border,#dde4e2);}.native-row>div{flex:1;min-width:0;overflow-wrap:anywhere;}pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px;}small{color:var(--text-muted,#67766e);line-height:1.6;}
</style>
