<script setup lang="ts">
// 启动/恢复期的加载屏：先呈现品牌，再进入登录或工作区（避免恢复会话时的白屏与闪跳）。
defineProps<{ error?: string }>();
defineEmits<{ retry: [] }>();
</script>
<template>
  <div class="connection-page">
    <section class="connection-card">
      <img src="/employeeclient.svg" class="welcome-mark" alt="员工客户端">
      <h2>员工客户端</h2>
      <p>让每一件事，都有回音。</p>
      <template v-if="!error">
        <div class="splash-spinner" role="status" aria-label="正在连接"></div>
        <small class="muted">正在恢复你的工作收件箱…</small>
      </template>
      <template v-else>
        <p class="error-text" role="alert">{{ error }}</p>
        <button class="btn soft" type="button" @click="$emit('retry')">重新尝试</button>
      </template>
    </section>
  </div>
</template>
