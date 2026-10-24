<script setup lang="ts">
import {useReadFeedback} from '@/ui/useReadFeedback';
import {pageNavigation} from '@/app/router';
import {startGroupSend} from '@/files/groupSend';
import {storedFile,EMPLOYEECLIENT_PROJECT} from '@/files/native-library';
import type {Attachment,MediaContext} from '@/collaboration/media';
import {referenceCopyText} from '@/ui/referenceCopy.mjs';
import ReferenceNumber from '@/ui/components/ReferenceNumber.vue';
import {ref,computed,watch,onBeforeUnmount} from 'vue';
import {useRoute,useRouter} from 'vue-router';
import {NativeClient} from '@/native/client.mjs';
import {numberLabel,fileName} from '@/native/discovery.mjs';
import {detailProperties,workBrief,workRelations,fixedReference,sizeLabel,resolveFixedVersion} from '@/native/detail-model.mjs';
import {userError} from '@/domain/userError.mjs';
import {serviceOrigin} from '@/api/runtime';
import {captureApiLease} from '@/api/client';
import {useSessionStore} from '@/session/store';
import {useUiStore} from '@/store/ui';
import {reserveSave,saveVerified} from '@/native/save';
import {readHubDetail,readProjects,hubCache} from '@/native/hub-data';
import {valueLabel} from '@/native/attribute-query.mjs';
import NativeWorkHistory from '@/ui/components/NativeWorkHistory.vue';
const route=useRoute(),router=useRouter(),session=useSessionStore(),ui=useUiStore();
const lease=captureApiLease(),client=new NativeClient({base:serviceOrigin(),onUnauthorized:()=>session.onUnauthorized()});
const projectTitle=ref('');
const recordOpen=ref(false),moreFiles=ref(false),returnPressed=ref(false);
const preview=ref(''),previewBusy=ref(false);
const {error,feedback}=useReadFeedback({retry:()=>load(),ready:()=>session.businessReady});
let loadedTarget='';
const value=ref<any>(null),busy=ref(false),saving=ref(false),saved=ref('');let generation=0,abort:AbortController|undefined,pendingReady=false;
const work=computed(()=>route.name==='work-detail'),project=computed(()=>String(route.query.project||'')),id=computed(()=>String(route.params.id||''));
const object=computed(()=>work.value?value.value?.work_item:value.value?.material||value.value);
const resolvedVersion=ref<any>(null),relationMeta=ref<Record<string,any>>({}),refMeta=ref<Record<string,any>>({});
const versionChanged=computed(()=>!work.value&&!!route.query.version&&value.value?.fixed_ref?.version_id!==route.query.version);
const historicalUnavailable=computed(()=>!!route.query.version&&!resolvedVersion.value);
const fixed=computed(()=>route.query.version?resolvedVersion.value:value.value?.fixed_ref);
const relations=computed(()=>workRelations(value.value,id.value));
const refs=computed(()=>{const all=[...(value.value?.fixed_refs||[]),...relations.value.filter((r:any)=>r.outgoing).flatMap((r:any)=>r.basis?.refs||[])].map(fixedReference).filter(Boolean);const map=new Map<string,any>();for(const r of all){const key=r.material_id+':'+r.version_id;map.set(key,{...r,...map.get(key)});}return [...map.values()];});
const brief=computed(()=>workBrief(value.value?.current_summary?.text||object.value?.description));
const attributes=computed(()=>detailProperties(object.value?.properties?.attributes));
const versionLabel=computed(()=>fixed.value?.local_version_no||object.value?.local_version_no||object.value?.version_no||'已固定');
const number=computed(()=>work.value?numberLabel(object.value?.short_no):fixed.value?.display_no||object.value?.display_no||'');
function destination(r:any){return {...r,project:r.targetProject||project.value,meta:relationMeta.value[r.target]};}
async function enrichRelations(n:number,signal:AbortSignal){
 for(const r of relations.value){if(n!==generation||!lease.valid()||signal.aborted)return;
  try{const result=await readHubDetail(lease,r.targetProject||project.value,r.target,true);if(n===generation&&lease.valid())relationMeta.value={...relationMeta.value,[r.target]:result.work_item};}catch{/* A limited relation never grants access to its target. */}
 }
}
async function enrichFiles(n:number,signal:AbortSignal){for(const r of refs.value){if(n!==generation||!lease.valid()||signal.aborted)return;try{const result=await readHubDetail(lease,r.project_id||project.value,r.material_id,false);if(n===generation&&lease.valid())refMeta.value={...refMeta.value,[r.material_id]:result.material||result};}catch{/* Show only metadata returned by authorized reads. */}}}
async function back(){if(returnPressed.value)return;returnPressed.value=true;try{await pageNavigation.back();}finally{returnPressed.value=false;}}
const title=computed(()=>work.value?object.value?.goal:fileName(object.value||{}));
async function load(){pendingReady=!session.businessReady;const n=++generation;projectTitle.value='';const targetProject=project.value;const applyProject=(list:any[])=>{if(n===generation&&lease.valid())projectTitle.value=list.find(p=>p.project_id===targetProject)?.title||'';};void readProjects(lease,{onSnapshot:applyProject}).then(applyProject).catch(()=>{});abort?.abort();abort=new AbortController();busy.value=true;const nextTarget=JSON.stringify([project.value,id.value,work.value,route.query.version]);if(nextTarget!==loadedTarget){loadedTarget=nextTarget;feedback.succeeded();value.value=null;recordOpen.value=false;moreFiles.value=false;returnPressed.value=false;saved.value='';preview.value='';previewBusy.value=false;resolvedVersion.value=null;relationMeta.value={};refMeta.value={};}feedback.begin(!!value.value);
 try{if(!project.value||!id.value)throw Error('缺少内容地址，请从列表重新打开');const result=await readHubDetail(lease,project.value,id.value,work.value,{onSnapshot:(cached:any)=>{if(n===generation&&lease.valid()){value.value=cached;feedback.begin(true);}}});if(n!==generation||!lease.valid())return;value.value=result;
 if(work.value){feedback.succeeded();void enrichRelations(n,abort.signal);void enrichFiles(n,abort.signal);}
 else if(route.query.version){const resolved=await hubCache.read(lease,'fixed:'+project.value+':'+id.value+':'+route.query.version+':'+route.query.hash,()=>resolveFixedVersion(client,project.value,id.value,String(route.query.version),String(route.query.hash||''),abort?.signal));if(n===generation&&lease.valid())resolvedVersion.value=resolved;}if(n===generation&&lease.valid())feedback.succeeded();}
 catch(e){if(n===generation&&lease.valid()){feedback.failed(e,'内容暂未读取，请重试');if([401,403].includes((e as any)?.status))value.value=null;}}finally{if(n===generation)busy.value=false;}
}
const forwarding=ref<Record<string,boolean>>({}),forwardErrors=ref<Record<string,string>>({});
async function forwardFile(r:any){
 const key=r.material_id+':'+r.version_id;if(forwarding.value[key]||!lease.valid())return;
 const accepted=await ui.confirm({title:'发送到公司工作群？',text:'发送后，群成员可以查看这份文件。',label:'发送'});if(!accepted||!lease.valid())return;
 forwarding.value[key]=true;forwardErrors.value[key]='';const target=r.project_id||project.value;
 try{const head=await client.head(target,r.material_id);if(!lease.valid())return;
 const version=r.version_id?await client.rpc('mem.version.read',{project_id:target,material_id:r.material_id,version_id:r.version_id,offset:0,limit:1,encoding:'base64'}):head;
 const fixed=version.fixed_ref;if(!fixed||r.sha256&&fixed.sha256!==r.sha256)throw Error('文件版本与引用不一致，请重新读取');
 const name=r.title||fileName(head.material||head),mime=head.properties?.employeeclient?.mime||'application/octet-stream';
 const a:Attachment={id:key,name,mime,size:fixed.size,sha256:fixed.sha256,kind:'file',version:fixed.version_id+':'+fixed.sha256,resolveUrl:async()=>client.fileUrl(target,fixed,name)};
 const ctx:MediaContext={account:lease.account,computer:'cloud',provider:'work',thread:target};
 const job=startGroupSend(a,ctx,'',target===EMPLOYEECLIENT_PROJECT?storedFile({...head,fixed_ref:fixed},name):undefined);await job.promise;if(!lease.valid())return;
 await router.push({name:'chat',query:{message:job.messageId}});
 }catch(e){if(lease.valid())forwardErrors.value[key]=userError(e,'文件未发送，请重试');}finally{forwarding.value[key]=false;}
}
async function copy(){const text=referenceCopyText(number.value,projectTitle.value);if(!text){ui.toast('项目名称尚未读取，请稍后重试',true);return;}try{await navigator.clipboard.writeText(text);ui.toast('已复制编号和项目名称');}catch{ui.openOverlay('copyFallback',{text});}}
function openFile(r:any){void router.push({name:'material-detail',params:{id:r.material_id},query:{project:r.project_id||project.value,returnTo:route.fullPath,...(r.version_id?{version:r.version_id,...(r.sha256?{hash:r.sha256}:{}),...(Number.isSafeInteger(r.size)?{size:String(r.size)}:{})}:{})}});}
function openRelation(r:any){const t=destination(r);if(t.target)void router.push({name:'work-detail',params:{id:t.target},query:{project:t.project,returnTo:route.fullPath}});}
async function previewFile(){if(previewBusy.value||!fixed.value||historicalUnavailable.value)return;const n=generation,f={...fixed.value};previewBusy.value=true;error.value='';try{if(f.size>1024*1024)throw Error('较大文件请保存到设备后打开');const blob=await client.readFile(project.value,f,abort?.signal);const text=await blob.text();if(n===generation&&lease.valid())preview.value=text;}catch(e){if(n===generation&&lease.valid())error.value=userError(e);}finally{if(n===generation)previewBusy.value=false;}}
const isText=computed(()=>/\.(txt|md|json|csv|log|js|mjs|ts|vue|py|css|html|xml|yml|yaml)$/i.test(title.value||''));
async function download(){if(saving.value||!fixed.value||historicalUnavailable.value)return;const n=generation,f={...fixed.value},p=project.value,name=title.value||'文件';saving.value=true;error.value='';let target:any;
 try{target=await reserveSave(name);if(n!==generation||!lease.valid()){target?.cancel();return;}
 if(f.size>64*1024*1024){target?.cancel();const a=document.createElement('a');a.href=client.fileUrl(p,f,name);a.download=name;a.rel='noopener';document.body.append(a);a.click();a.remove();saved.value='已交给系统下载，请在下载列表查看';return;}
 const blob=await client.readFile(p,f,abort?.signal);if(n!==generation||!lease.valid()){target?.cancel();return;}
 const result=await saveVerified(blob,name,f.sha256,[lease.account,p,f.material_id,f.version_id,f.sha256],()=>n===generation&&lease.valid(),target);if(n===generation&&lease.valid())saved.value=result.message;
 }catch(e){target?.cancel();if(n===generation&&lease.valid())error.value=userError(e);}finally{saving.value=false;}
}
watch(()=>session.businessReady,ready=>{if(ready&&pendingReady&&!busy.value){pendingReady=false;void load();}});
watch(()=>[route.name,id.value,project.value,route.query.version,route.query.hash,route.query.size],()=>void load(),{immediate:true});onBeforeUnmount(()=>{generation++;abort?.abort();client.reset();});
</script>
<template><section class="hub-detail">
 <button class="detail-back" :class="{pressed:returnPressed}" :disabled="returnPressed" data-page-back @click="back">‹ 返回</button>
 <p v-if="busy" role="status">正在读取详情…</p><p v-if="error" role="alert" class="error-text">{{error}}<button class="btn" @click="load">重试</button></p>
 <template v-if="value"><header><h1>{{title}}</h1><div class="detail-number"><span>{{number||'固定资料'}}</span><button v-if="number" class="btn small ghost" @click="copy">复制编号和项目名称</button></div></header>
  <template v-if="work">
   <span class="detail-state">{{valueLabel(object.state,'state')}}</span>
   <section v-if="brief" class="brief"><h2>最近进展</h2><p>{{brief}}</p></section>
   <section v-if="attributes.length" class="detail-attributes"><span v-for="p in attributes" :key="p.key">{{p.label}}：{{p.value}}</span></section>
   <section v-if="refs.length" class="compact-files"><h2>相关资料 <small>{{refs.length}}</small></h2><div v-for="r in (moreFiles?refs:refs.slice(0,3))" :key="r.material_id+':'+r.version_id"><div class="related-file-row"><button class="file-row" @click="openFile(r)"><span>{{r.title||(refMeta[r.material_id]?fileName(refMeta[r.material_id]):r.logical_path?.split('/').at(-1)||r.display_no||'相关文件')}}</span><b>›</b></button><button class="file-forward" :disabled="forwarding[r.material_id+':'+r.version_id]" @click="forwardFile(r)">{{forwarding[r.material_id+':'+r.version_id]?'发送中…':'发到群聊'}}</button></div><p v-if="forwardErrors[r.material_id+':'+r.version_id]" class="field-help" role="alert">{{forwardErrors[r.material_id+':'+r.version_id]}}</p></div><button v-if="refs.length>3" class="detail-more" @click="moreFiles=!moreFiles">{{moreFiles?'收起':'查看全部资料（'+refs.length+'）'}}</button></section>
   <details v-if="relations.length" class="detail-fold"><summary>关联工作 <small>{{relations.length}}</small></summary><div v-for="(r,index) in relations" :key="index" class="relation-row"><span class="relation-direction">{{r.outgoing?'引用':'被引用'}}</span><ReferenceNumber v-if="numberLabel(relationMeta[r.target]?.short_no||r.short_no)" :number="numberLabel(relationMeta[r.target]?.short_no||r.short_no)" @open="openRelation(r)"/><span class="relation-title">{{relationMeta[r.target]?.goal||r.title||r.goal||'关联工作'}}</span></div></details>
   <details class="detail-fold" @toggle="recordOpen=($event.target as HTMLDetailsElement).open"><summary>完整工作记录</summary><template v-if="recordOpen"><p class="detail-body">{{value.current_summary?.text||object.description||'暂无记录'}}</p><NativeWorkHistory :project-id="project" :work-item-id="id"/></template></details>
  </template>
  <template v-if="!work"><section><h2>文件信息</h2><p v-if="historicalUnavailable" class="error-text">暂未取得该固定版本的信息。请重试读取，避免保存错误版本。</p><p v-else-if="versionChanged" class="hub-hint">正在查看这项工作引用的固定历史版本。</p><dl><template v-for="p in attributes" :key="p.key"><dt>{{p.label}}</dt><dd>{{p.value}}</dd></template><dt>文件版本</dt><dd>{{versionLabel}}</dd><dt>大小</dt><dd>{{sizeLabel(fixed?.size??object?.size)}}</dd></dl><details><summary>固定版本标识</summary><p class="hub-hint">{{fixed?.version_id||'未取得'}}</p></details><div class="file-actions"><button v-if="isText" class="btn" :disabled="previewBusy||!fixed||historicalUnavailable" @click="previewFile">{{previewBusy?'正在读取…':'查看正文'}}</button><button class="btn soft" :disabled="saving||!fixed||historicalUnavailable" @click="download">{{saving?'正在保存…':'保存原文件'}}</button></div><pre v-if="preview" class="file-preview">{{preview}}</pre><p v-if="saved" role="status">{{saved}}</p></section></template>
 </template>
</section></template>
<style scoped>
.related-file-row{display:flex;align-items:center;gap:10px}.related-file-row>.file-row{flex:1;min-width:0}.file-forward{flex:none;font-size:12px;min-height:40px;padding:5px 8px;border:0;border-radius:5px;background:var(--green-soft);color:var(--green)}.file-forward:active{background:#cee6da}
.hub-detail{max-width:560px;margin:auto;min-width:0}.hub-detail header{padding:12px 0;border-bottom:1px solid var(--line-soft)}h1{font-size:18px;line-height:1.45;overflow-wrap:anywhere}h2{font-size:16px;margin-bottom:12px}.detail-number{display:flex;align-items:center;gap:12px;font-size:15px;color:var(--muted);flex-wrap:wrap}.hub-detail section{padding:14px 0;border-bottom:1px solid var(--line-soft)}.detail-body{white-space:pre-wrap;overflow-wrap:anywhere;font-size:16px;line-height:1.6}.detail-link{display:block;text-align:left;width:100%;min-height:64px;border:0;border-bottom:1px solid var(--line-soft);padding:12px 0;background:transparent;color:var(--ink)}.detail-link strong{display:block;font-size:16px;font-weight:500;overflow-wrap:anywhere}.detail-link span{display:block;font-size:13px;line-height:1.5;color:var(--muted);margin-top:6px;overflow-wrap:anywhere}dl{display:grid;grid-template-columns:minmax(80px,28%) minmax(0,1fr);gap:10px;font-size:14px;margin-bottom:20px}.file-actions{margin-top:16px;display:flex;gap:8px;flex-wrap:wrap}.file-preview{font-size:15px;line-height:1.6;white-space:pre-wrap;overflow-wrap:anywhere;padding:16px 0;max-height:60dvh;overflow:auto}dt{color:var(--muted);overflow-wrap:anywhere}dd{overflow-wrap:anywhere;margin:0}
.detail-state{display:inline-block;margin-top:12px;padding:3px 8px;border-radius:5px;background:var(--green-soft);color:var(--green);font-size:12px}.brief p{font-size:15px;line-height:1.6;overflow-wrap:anywhere}.detail-fold{border-bottom:1px solid var(--line-soft)}.detail-fold>summary{min-height:48px;display:flex;align-items:center;gap:8px;cursor:pointer;font-size:14px;color:var(--muted);list-style:none}.detail-fold>summary::after{content:'›';margin-left:auto}.detail-fold[open]>summary::after{content:'⌄'}.file-row{display:flex;align-items:center;justify-content:space-between;gap:12px;width:100%;text-align:left;border:0;background:transparent;min-height:46px;padding:10px 0;font-size:15px;color:var(--ink)}.file-row span{overflow-wrap:anywhere;min-width:0}.file-row b{color:var(--muted);font-weight:400}.detail-more{padding:10px 0;border:0;background:transparent;color:var(--green);font-size:13px;min-height:44px}h2 small,.detail-fold small{font-size:12px;font-weight:400;color:var(--muted)}.detail-attributes{display:flex;gap:6px;flex-wrap:wrap}.detail-attributes span{font-size:12px;padding:3px 7px;border-radius:4px;background:#eef1ef;color:var(--muted);overflow-wrap:anywhere}
.detail-back{border:0;border-radius:7px;background:transparent;color:var(--ink);font:inherit;font-size:14px;min-height:40px;padding:7px 10px;transition:background-color .1s}.detail-back:active,.detail-back.pressed{background:#e1e8e6;opacity:1}.relation-row{display:flex;align-items:baseline;flex-wrap:wrap;gap:6px;padding:10px 0;font-size:15px;line-height:1.6}.relation-direction{color:var(--muted);font-size:13px}.work-mention{display:inline;border:0;border-radius:4px;padding:1px 4px;background:#e8effa;color:#28598d;font:inherit;font-weight:500;line-height:1.5;white-space:nowrap;touch-action:manipulation}.work-mention:active{background:#cadcf4}.relation-title{color:var(--ink);overflow-wrap:anywhere}
</style>
