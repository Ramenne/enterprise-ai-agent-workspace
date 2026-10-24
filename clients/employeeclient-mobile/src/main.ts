import './ui/styles/messageMenu.css';
import { bindPwaUpdates } from './platform/pwaUpdate';
import { startUpdateNotices } from './platform/updateAvailability';
// src/main.ts —— 应用入口：装配 Pinia + Router，注册 PWA Service Worker，挂载根组件。
import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import { router } from './app/router';
import './ui/styles/system.css';

const app = createApp(App);
app.use(createPinia());
app.use(router);
app.mount('#app');
startUpdateNotices();

// PWA：生产构建注册 Service Worker（预缓存应用壳，autoUpdate）；开发不注册，避免干扰热更新。
if (import.meta.env.PROD) {
  import('virtual:pwa-register').then(({ registerSW }) => registerSW({ immediate: true, onRegisteredSW(_url, registration) { if (registration) bindPwaUpdates(registration); } })).catch(() => { /* 非 PWA 环境忽略 */ });
}
