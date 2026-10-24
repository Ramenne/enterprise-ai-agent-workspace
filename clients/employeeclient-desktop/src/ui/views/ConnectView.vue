<script setup lang="ts">
// 邮箱验证码连接；凭据只由HttpOnly会话保管。
import {ensureNotificationPermission} from '@/platform/push';
import {isAndroidNative} from '@/session/installation';
import {requestLocalNotifyPermission} from '@/platform/localNotify';
import {rememberedEmail} from '@/session/login-preference.mjs';
import {restoredRoute} from '@/app/restore-route.mjs';
import { ref, computed } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { useSessionStore } from '@/session/store';

const session = useSessionStore();
const router = useRouter();
const route = useRoute();
const username = ref(rememberedEmail());
const otp = ref('');
const sent=ref(false);
const recoveryOnly=computed(()=>['recovering','offline'].includes(session.status));
async function recover(){if(busy.value)return;busy.value=true;try{if(await session.restore())await router.replace(restoredRoute(route.query.redirect));}finally{busy.value=false;}}
async function send(){if(busy.value)return;busy.value=true;try{sent.value=await session.sendCode(username.value.trim());}finally{busy.value=false;}}
const busy = ref(false);

const heading = computed(() =>
  session.status === 'expired' ? '重新连接，继续你的工作'
    : session.status === 'unbound' ? '当前账号没有员工客户端访问资格'
      : '让每一件事，都有回音');
const sub = computed(() =>
  session.status === 'expired' ? '账号认证已失效。重新通过身份权限服务账号连接后，找回云端的工作记录。未提交的本机草稿仍然保留。'
    : session.status === 'unbound' ? '请确认当前成员的员工客户端项目访问资格，授权恢复后重新检查连接。'
      : '群消息、工作进展和个人项目，在这里汇合。验证成员邮箱，即可读取中枢资料与工作。');
const btnLabel = computed(() => busy.value ? '正在连接…' : (session.status === 'anonymous' ? '通过身份权限服务连接' : '重新验证本人身份'));

async function submit() {
  if (busy.value) return;
  if (!username.value.trim() || !otp.value) { session.lastError = '请输入成员邮箱与验证码'; return; }
  busy.value = true;
  void (isAndroidNative()?requestLocalNotifyPermission():ensureNotificationPermission());
  const ok = await session.login(username.value.trim(), otp.value);
  busy.value = false;
  if (ok) {
    otp.value = '';   // 验证码不保留
    const redirect = restoredRoute(route.query.redirect);
    void router.replace(redirect);
  }
}
</script>

<template>
  <div class="connection-page">
    <section class="connection-card">
      <img src="/employeeclient.svg" class="welcome-mark" alt="员工客户端">
      <template v-if="session.status==='unbound'"><h2>{{heading}}</h2><p>{{sub}}</p><p v-if="session.lastError" class="error-text" role="alert">{{session.lastError}}</p><button class="btn primary" :disabled="busy" @click="recover">{{busy?'正在检查…':'重新检查访问资格'}}</button></template>
      <template v-else-if="recoveryOnly"><h2>恢复连接</h2><p>登录凭据仍保留，暂时无法连接服务。</p><button class="btn primary" :disabled="busy" @click="recover">{{busy?'正在恢复…':'重试连接'}}</button></template>
      <template v-else><h2>{{ heading }}</h2>
      <p>{{ sub }}</p>
      <form class="connect-form" @submit.prevent="submit">
        <div class="form-field">
          <label for="qn-u">成员邮箱</label>
          <input id="qn-u" class="input" type="email" v-model="username" autocomplete="username" autocapitalize="off"
            autocorrect="off" placeholder="输入注册邮箱" :disabled="busy" :readonly="session.status==='expired'&&!!rememberedEmail()">
        </div>
        <div class="form-field">
          <label for="qn-p">验证码</label>
          <input id="qn-p" class="input" v-model="otp" inputmode="numeric" maxlength="6" pattern="[0-9]{6}" autocomplete="one-time-code"
            placeholder="输入验证码" :disabled="busy" @keydown.enter="submit">
        </div>
        <button class="btn" type="button" @click="send" :disabled="busy||!username">获取验证码</button><p v-if="sent" class="muted">验证码已请求，请查看本人邮箱。</p>
        <div v-if="session.lastError" class="error-text" role="alert">{{ session.lastError }}</div>
        <button class="btn primary" type="submit" :disabled="busy">{{ btnLabel }}</button>
      </form>
      <small class="muted">使用身份权限服务注册邮箱验证本人身份。员工客户端不保存验证码。</small></template>
    </section>
  </div>
</template>

<style scoped>
.connect-form { text-align: left; margin-bottom: 18px; }
.connect-form .form-field { margin-bottom: 16px; }
.connect-form .btn { width: 100%; min-height: 46px; }
.connection-card small { display: block; line-height: 1.8; }
</style>
