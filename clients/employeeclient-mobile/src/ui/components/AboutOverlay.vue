<script setup lang="ts">
// 关于员工客户端（原型 UI v1.1 的 about 弹层）：标题、副标题、callout、正文、页脚「了解了」结构一致。
// 正文换成真实事实：这里不是原型，而是连接中枢的正式客户端；同时如实写明手机端不提供的能力，避免误期待。
import { computed,onBeforeUnmount, onMounted, ref } from 'vue';
import type { PluginListenerHandle } from '@capacitor/core';
import { isAndroidNative } from '@/session/installation';
import { currentVersion, downloadAndroidUpdate, cancelAndroidUpdate,
  installAndroidUpdate, onAndroidUpdateProgress } from '@/platform/androidUpdate';
import type { InstalledVersion } from '@/platform/androidUpdate';
import { useUiStore } from '@/store/ui';
import { CLIENT_RELEASE } from '@/app/release';
import {latestUpdate,checkAppUpdate,checkingUpdate,updateCheckError} from '@/platform/updateAvailability';
import ModalSheet from '@/ui/components/ModalSheet.vue';

const ui = useUiStore();
const android = isAndroidNative();
const current = ref<InstalledVersion | null>(null);
const latest = latestUpdate;
const preparingWeb = ref(false);
const checking = computed(()=>checkingUpdate.value||preparingWeb.value);
const downloading = ref(false);
const received = ref(0);
const message = ref('');
let progressListener: PluginListenerHandle | undefined;
let disposed = false;

const labels: Record<string, string> = {
  update_channel_unavailable: '更新服务暂时不可用，稍后重试即可；当前版本不受影响。',
  update_manifest_invalid: '更新清单不完整或格式不正确，未执行安装；请稍后重试。',
  update_failed: '更新服务暂时不可用，当前版本未修改；请稍后重试。',
  update_download_failed: '下载中断，请检查网络后重试。',
  update_cancelled: '已取消下载，当前版本不受影响。',
  update_hash_mismatch: '安装包校验失败，已丢弃损坏文件，请重试。',
  update_size_mismatch: '安装包大小不符，已丢弃损坏文件，请重试。',
  update_package_mismatch: '安装包名称或版本不匹配，已拒绝安装。',
  update_signature_mismatch: '安装包签名与当前应用不同，不能覆盖安装。请联系维护人员，不要卸载以免丢失本机草稿。',
  update_storage_unavailable: '本机空间不足或文件不可写，请整理存储后重试。',
  update_not_available: '目前没有高于当前版本的更新。',
  update_package_missing: '尚未下载好完整安装包，请重试。',
  install_permission_screen_unavailable: '无法打开安装权限设置，请在系统设置中允许员工客户端安装应用。',
  installer_unavailable: '无法打开系统安装界面，请稍后重试。',
};
const label = (e: unknown) => labels[(e as Error)?.message] || '操作未完成，请稍后重试；当前版本不受影响。';
const size = (bytes: number) => (bytes / 1024 / 1024).toFixed(1) + ' MB';

onMounted(async () => {
  // Opening About is an explicit version read, not a background lifecycle event.
  // A successful startup check may predate a release during this same session.
  void checkAppUpdate(true).catch(()=>{});
  if (!android) return;
  try {
    const installed = await currentVersion();
    if (disposed) return;
    current.value = installed;
    const handle = await onAndroidUpdateProgress(e => { if (!disposed) received.value = e.received; });
    if (disposed) { await handle.remove(); return; }
    progressListener = handle;
  } catch (e) { if (!disposed) message.value = label(e); }
});
onBeforeUnmount(() => {
  disposed = true;
  void progressListener?.remove();
  if (downloading.value) void cancelAndroidUpdate();
});

const actionLabel=computed(()=>checking.value?'读取版本…':downloading.value?'下载中…':updateCheckError.value?'重试':latest.value?.available?(latest.value.downloaded?'继续安装':'立刻更新'):latest.value?'已是最新版':'读取版本…');
const actionDisabled=computed(()=>checking.value||downloading.value||(!updateCheckError.value&&!latest.value?.available));
async function updateAction(){
  if(actionDisabled.value)return;
  if(updateCheckError.value){await checkAppUpdate().catch(()=>{});return;}
  if(android)await install();else await refreshWeb();
}
async function refreshWeb() {
  if (checking.value) return;
  preparingWeb.value=true;message.value='';
  try {
    const registration=await navigator.serviceWorker?.getRegistration();
    await registration?.update();
    const worker=registration?.installing||registration?.waiting;
    if(worker&&worker.state!=='activated')await new Promise<void>((resolve,reject)=>{
      const timer=setTimeout(()=>finish(Error('update_failed')),10000);
      function finish(error?:Error){clearTimeout(timer);worker!.removeEventListener('statechange',changed);error?reject(error):resolve();}
      function changed(){if(worker!.state==='activated')finish();else if(worker!.state==='redundant')finish(Error('update_failed'));}
      worker.addEventListener('statechange',changed);changed();
    });
    if(!disposed)window.location.reload();
  }catch(e){if(!disposed)message.value=label(e);}
  finally{preparingWeb.value=false;}
}
async function install() {
  if (!latest.value?.available || downloading.value) return;
  downloading.value = true; message.value = '';
  try {
    if (!latest.value.downloaded) {
      received.value = 0;
      await downloadAndroidUpdate();
      if (disposed) return;
      latest.value.downloaded = true;
    }
    if (disposed) return;
    const result = await installAndroidUpdate();
    if (!disposed) message.value = result.status === 'permission_required'
      ? '请在系统设置中允许员工客户端安装应用，返回后再点“继续安装”。'
      : '已打开系统安装确认。取消安装时旧版仍可正常使用；安装后重新打开可查看真实版本。';
  } catch (e) { if (!disposed) message.value = label(e); }
  finally { if (!disposed) downloading.value = false; }
}
async function cancelDownload() {
  await cancelAndroidUpdate();
  if (!disposed) message.value = '正在取消下载…';
}
</script>

<template>
  <ModalSheet title="关于员工客户端" @close="ui.closeOverlay()">
    <section v-if="!android" class="about-version" aria-label="网页客户端版本">
      <h3>当前网页版本</h3><p>{{ CLIENT_RELEASE.versionName }} · 构建 {{ CLIENT_RELEASE.versionCode }}</p>
      <p v-if="latest?.available">最新版本：{{latest.versionName}}</p>
      <button class="btn" :class="{primary:latest?.available}" :disabled="actionDisabled" @click="updateAction">{{actionLabel}}</button>
      <p v-if="updateCheckError" role="status">暂时无法读取版本，请重试。</p>
      <p v-if="message" role="status">{{message}}</p>
    </section>
    <section v-if="android" class="callout" aria-label="安卓应用内更新">
      <strong>版本更新</strong>
      <p>当前版本：{{ current ? `${current.versionName}（${current.versionCode}）` : '读取中…' }}</p>
      <template v-if="latest">
        <p>最新版本：{{ latest.versionName }}（{{ latest.versionCode }}）<template v-if="latest.available"> · {{ size(latest.size) }}</template></p>
        <p v-if="latest.notes">{{ latest.notes }}</p>
        <p v-if="downloading">下载中：{{ size(received) }} / {{ size(latest.size) }}</p>
        <progress v-if="downloading" :value="received" :max="latest.size" style="width:100%" />
      </template>
      <p v-if="message" role="status">{{ message }}</p>
      <p v-if="updateCheckError" role="status">暂时无法读取版本，请重试。</p>
      <button v-if="!downloading" class="btn" :class="{primary:latest?.available}" :disabled="actionDisabled" @click="updateAction">{{actionLabel}}</button>
      <button v-if="downloading" class="btn" @click="cancelDownload">取消下载</button>
    </section>
    <details class="about-details"><summary>数据与通知说明</summary>
      <p class="body-text">个人项目仅本人可见，与公司项目分开保存。归档只调整展示，不等于完成任务或解决问题。</p>
      <p class="body-text">Android 使用应用内连接和本地系统通知；PWA 使用系统 Web Push。断网、系统限制或进程结束时不承诺即时通知，恢复后重新获取消息。</p>
    </details>
    <template #footer>
      <button class="btn primary" @click="ui.closeOverlay()">完成</button>
    </template>
  </ModalSheet>
</template>
<style scoped>
.about-version{padding:0 0 16px;border:0;border-bottom:1px solid var(--line-soft);border-radius:0;margin-bottom:8px}.about-version h3{font-size:16px;margin-bottom:8px}.about-version>p{color:var(--muted)}.about-details summary{min-height:44px;display:flex;align-items:center;cursor:pointer;color:var(--accent);font-size:14px}.about-details p{margin:12px 0}
</style>
