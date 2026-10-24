<script setup lang="ts">
import {useReadFeedback} from '@/ui/useReadFeedback';
import {ref,watch,onBeforeUnmount} from 'vue';
import {useRouter,useRoute} from 'vue-router';
import {captureApiLease} from '@/api/client';
import {fileName} from '@/native/discovery.mjs';
import {basisText,fixedReference} from '@/native/detail-model.mjs';
import {userError} from '@/domain/userError.mjs';
import {NativeClient} from '@/native/client.mjs';
import {readStatement} from '@/native/statement.mjs';
import {serviceOrigin} from '@/api/runtime';
import {useSessionStore} from '@/session/store';
const props=defineProps<{projectId:string;workItemId:string}>();
const router=useRouter(),route=useRoute(),lease=captureApiLease();
const session=useSessionStore(),client=new NativeClient({base:serviceOrigin(),onUnauthorized:()=>session.onUnauthorized()});
type Entry={statement_id:string;work_revision:number;kind:string;size:number;sha256:string;statement?:{summary?:string;explanation?:unknown;outputs?:any[]}};
const names=ref<Record<string,string>>({});
const {error:readError,feedback}=useReadFeedback({retry:()=>load(retryMore),ready:()=>session.businessReady});
let scope='',retryMore=false;
const entries=ref<Entry[]>([]),cursor=ref<string|undefined>(),busy=ref(false),error=ref(''),opening=ref('');let epoch=0,abort:AbortController|undefined;
async function load(more=false){
 const key=JSON.stringify([props.projectId,props.workItemId]);if(busy.value&&scope===key)return;if(scope!==key){scope=key;feedback.succeeded();entries.value=[];names.value={};cursor.value=undefined;}retryMore=more;const n=++epoch;abort?.abort();abort=new AbortController();busy.value=true;feedback.begin(entries.value.length>0);opening.value='';
 try{const page=await client.rpc('v8.work.history.page',{project_id:props.projectId,work_item_id:props.workItemId,kind:'updates',limit:20,...(more&&cursor.value?{cursor:cursor.value}:{})},undefined,abort.signal);
  if(n!==epoch||!lease.valid())return;entries.value=more?[...entries.value,...page.items]:page.items;cursor.value=page.next_cursor||undefined;feedback.succeeded();
 }catch(e){if(lease.valid()&&n===epoch&&!abort.signal.aborted){if([401,403].includes((e as any)?.status))entries.value=[];feedback.failed(e,'历史记录暂未读取，请重试');}}
 finally{if(n===epoch)busy.value=false;}
}
async function expand(item:Entry){
 if(opening.value)return;const n=epoch;opening.value=item.statement_id;error.value='';
 try{const value=await readStatement(client,props.projectId,item,abort?.signal);if(n!==epoch||!lease.valid())return;item.statement=value;
 for(const r of outputs(item)){if(n!==epoch||!lease.valid())return;try{const head=await client.rpc('mem.material.head',{project_id:r.project_id||props.projectId,material_id:r.material_id},undefined,abort?.signal);if(n===epoch&&lease.valid())names.value={...names.value,[r.material_id]:fileName(head.material||head)};}catch{}}}
 catch(e){if(lease.valid()&&n===epoch)error.value=userError(e);}
 finally{if(n===epoch)opening.value='';}
}
function outputs(item:Entry){return (item.statement?.outputs||[]).map(fixedReference).filter(Boolean);}
function openOutput(r:any){void router.push({name:'material-detail',params:{id:r.material_id},query:{project:r.project_id||props.projectId,returnTo:route.fullPath,...(r.version_id?{version:r.version_id}:{}),...(r.sha256?{hash:r.sha256}:{})}});}
watch(()=>[props.projectId,props.workItemId,session.user?.username],()=>void load(),{immediate:true});
onBeforeUnmount(()=>{epoch++;abort?.abort();client.reset();});
</script>
<template><section class="native-history"><h3>工作记录与更新历史</h3><p v-if="readError" class="field-help" role="status">{{readError}}<button class="btn small" :disabled="busy" @click="load(retryMore)">重试读取</button></p><p v-if="error" role="alert" class="error-text">{{error}}<button class="btn small" @click="load()">重试读取</button></p>
<article v-for="item in entries" :key="item.statement_id"><small>记录修订 {{item.work_revision}}</small><template v-if="item.statement"><p>{{item.statement.summary||'本记录未提供摘要'}}</p><details v-if="item.statement.explanation"><summary>判断与依据</summary><p>{{basisText(item.statement.explanation)}}</p></details><button v-for="(r,i) in outputs(item)" :key="r.material_id+':'+r.version_id+':'+i" class="history-output" @click="openOutput(r)">{{r.title||names[r.material_id]||r.display_no||'固定文件'}}<span>{{r.role==='result'?'交付文件':'引用文件'}} · 查看 ›</span></button></template><button v-else class="btn" :disabled="!!opening" @click="expand(item)">{{opening===item.statement_id?'正在读取…':'展开原记录'}}</button></article>
<button v-if="cursor" class="btn" :disabled="busy" @click="load(true)">继续读取</button><p v-if="busy">正在读取…</p><p v-if="!entries.length&&!busy&&!error">当前未返回更新记录。</p>
</section></template>
<style scoped>.native-history{margin-top:20px}.native-history article{padding:16px 0;border-bottom:1px solid var(--line)}.native-history p,.native-history pre{white-space:pre-wrap;overflow-wrap:anywhere}.history-output{display:block;text-align:left;width:100%;background:transparent;border:0;border-bottom:1px solid var(--line-soft);min-height:48px;padding:12px 0;font-size:16px;color:var(--ink);overflow-wrap:anywhere}.history-output span{display:block;color:var(--muted);font-size:13px;margin-top:4px}.native-history p{font-size:16px;line-height:1.6}.native-history summary{min-height:44px;display:flex;align-items:center}.native-history small{color:var(--muted)}</style>
