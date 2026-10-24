<script setup lang="ts">
// 发布公司公告（链路5，所有员工）：勾选具体接收账号（不按部门；全选只是快捷选择），标题/正文/优先级/选填失效时间。
// 服务端校验账号、去重、排除发布者并固化收件人快照；发布者不接收自己的公告。
import { ref, onMounted, computed } from 'vue';
import { communication } from '@/api/endpoints';
import { ApiError } from '@/api/client';
import { usePendingWrite } from '@/ui/usePendingWrite';
import { useDataStore } from '@/store/data';
import { useUiStore } from '@/store/ui';
import { useSessionStore } from '@/session/store';
import type { AssigneeOption } from '@/api/types';
import ModalSheet from '@/ui/components/ModalSheet.vue';
import AppIcon from '@/ui/components/AppIcon.vue';
import ChoiceSelect from '@/ui/components/ChoiceSelect.vue';

const data = useDataStore();
const session = useSessionStore();
const account = session.user?.username;
const ui = useUiStore();
const title = ref('');
const body = ref('');
const priority = ref<'normal' | 'urgent'>('normal');
const expires = ref('');   // yyyy-mm-dd（选填）
const members = ref<AssigneeOption[]>([]);
const selected = ref<string[]>([]);
const busy = ref(false);
const err = ref('');
const membersLoading = ref(false), membersError = ref('');
const write = usePendingWrite<Parameters<typeof communication.publishAnnouncement>[0]>('company', 'announcement');
const pending = write.pending;
if (pending.value) {
  const value = pending.value.body;
  title.value = value.title || ''; body.value = value.body; priority.value = value.priority || 'normal'; selected.value = [...value.recipient_usernames];
  if (value.expires_at) { const d = new Date(value.expires_at); expires.value = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }
}
const selCount = computed(() => selected.value.length);
const priorityOptions = [
  { value: 'normal', label: '普通' },
  { value: 'urgent', label: '紧急' },
];
function setPriority(value: string) { priority.value = value as 'normal' | 'urgent'; }

async function loadMembers() {
  if (membersLoading.value) return;
  membersLoading.value = true; membersError.value = '';
  try { const result = await communication.members(); if (session.user?.username === account) members.value = result.members.filter(a => a.username !== account); }
  catch { membersError.value = '暂时无法读取接收人，已填写的内容仍保留。'; }
  finally { membersLoading.value = false; }
}
onMounted(() => void loadMembers());
function selectAll() { if (!pending.value) selected.value = members.value.map(m => m.username); }
function clearAll() { if (!pending.value) selected.value = []; }
function toggle(u: string) { if (!pending.value) selected.value = selected.value.includes(u) ? selected.value.filter(x => x !== u) : [...selected.value, u]; }

async function submit() {
  if (busy.value || !write.valid() || session.status !== 'online') return;
  err.value = '';
  if (!body.value.trim()) { err.value = '请填写公告正文'; return; }
  if (!selected.value.length) { err.value = '请选择至少一位接收人'; return; }
  if (!pending.value && expires.value) { const t = new Date(expires.value + 'T23:59:59').getTime(); if (t <= Date.now()) { err.value = '有效期不能早于现在；也可以留空，长期保留'; return; } }
  busy.value = true;
  try {
    const intent = write.start({
      title: title.value.trim() || '公司公告', body: body.value.trim(), priority: priority.value,
      recipient_usernames: selected.value, expires_at: expires.value ? new Date(expires.value + 'T23:59:59').getTime() : null,
    });
    const r = await communication.publishAnnouncement(intent.body, intent.key);
    if (!write.valid()) return;
    write.finish();
    ui.closeOverlay(); await data.syncLists(write.account,true).catch(() => undefined); if (!write.valid()) return;
    ui.toast(`公告已发送给 ${r.recipient_count ?? selected.value.length} 位接收人`);
  } catch (e) { if (write.valid()) err.value = e instanceof ApiError ? (e.hint || e.code) : e instanceof Error ? e.message : '发布失败'; }
  finally { busy.value = false; }
}
</script>

<template>
  <ModalSheet title="发布公司公告" sub="选择需要收到这条消息的人" @close="!busy && ui.closeOverlay()">
    <div v-if="pending" class="callout">上次结果尚未确认，将使用原内容和接收人恢复。<button class="btn small" :disabled="busy" @click="write.discard()">放弃本次恢复</button></div>
    <div class="form-field"><label for="qn-ann-title">标题</label>
      <input id="qn-ann-title" class="input" v-model="title" :disabled="!!pending" placeholder="这次想告诉大家什么？" maxlength="120"></div>
    <div class="form-field"><label for="qn-ann-body">内容</label>
      <textarea id="qn-ann-body" class="input" v-model="body" :disabled="!!pending" placeholder="写下清楚、简洁的通知内容" maxlength="2000"></textarea></div>
    <div class="form-field"><label>接收人</label>
      <p v-if="membersLoading" class="field-help" role="status">正在读取公司成员…</p>
      <div v-if="membersError" class="error-text" role="alert">{{ membersError }}<button class="btn small" :disabled="membersLoading" @click="loadMembers">重试接收人</button></div>
      <p v-else-if="!membersLoading && !members.length" class="field-help">当前没有可选择的其他公司成员。</p>
      <div class="recipient-tools">
        <button class="btn ghost small" @click="selectAll">全选当前人员</button>
        <button class="btn ghost small" @click="clearAll">清空</button>
        <span>已选 {{ selCount }} 人</span>
      </div>
      <div class="checkbox-list recipient-accounts">
        <label v-for="m in members" :key="m.username"><input type="checkbox" :checked="selected.includes(m.username)" @change="toggle(m.username)">
          <span class="avatar">{{ (m.nickname || m.username).slice(0, 1) }}</span><span>{{ m.nickname || m.username }}</span></label>
      </div>
      <p class="field-help">只发给已勾选的账号，不发给自己。全选只是选中当前人员，不按部门发放。</p>
    </div>
    <div class="form-grid">
      <div class="form-field"><label for="qn-ann-pri">优先级</label>
        <ChoiceSelect id="qn-ann-pri" :model-value="priority" :options="priorityOptions" label="优先级" :disabled="!!pending || busy" @update:model-value="setPriority" /></div>
      <div class="form-field"><label for="qn-ann-exp">有效至 <small>选填，默认不过期</small></label>
        <input id="qn-ann-exp" type="date" class="input" v-model="expires" :disabled="!!pending"></div>
    </div>
    <div v-if="err" class="error-text" role="alert">{{ err }}</div>
    <template #footer>
      <button class="btn" :disabled="busy" @click="ui.closeOverlay()">取消</button>
      <button class="btn primary" :disabled="busy || session.status !== 'online'" @click="submit"><AppIcon name="send" />{{ busy ? '发布中…' : pending ? '重试确认发布' : '发布公告' }}</button>
    </template>
  </ModalSheet>
</template>

<style scoped>fieldset{border:0;padding:0;margin:0;min-width:0}</style>
