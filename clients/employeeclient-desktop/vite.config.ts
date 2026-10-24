import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { VitePWA } from 'vite-plugin-pwa';

// 本地联调：/api 代理到真实 V8 共享服务端，/hufu 代理到身份权限服务（生产为同源反向代理或绝对地址）。
// 端口可用环境变量覆盖，与 dev/run-backend.mjs 保持一致。
const V8_PROXY = process.env.V8_PROXY || 'http://127.0.0.1:8934';
const HUFU_PROXY = process.env.HUFU_PROXY || 'http://127.0.0.1:8933';

export default defineConfig({
  // 相对 base：同一构建产物既能挂在独立 origin 根，也能被 Capacitor 以本地方式加载。
  base: './',
  plugins: [
    vue(),
    VitePWA({
      registerType: 'autoUpdate',
      strategies: 'injectManifest',   // 自定义 SW（src/sw.ts）：预缓存应用壳 + Web Push 接收 + 通知点击深链
      srcDir: 'src',
      filename: 'sw.ts',
      // 只预缓存应用壳与静态资源；业务数据由应用层按账号写入 IndexedDB，SW 不无差别缓存 /api。
      includeAssets: ['employeeclient.svg', 'icons/icon-192.png', 'icons/icon-512.png'],
      manifest: {
        id: './',
        name: '员工客户端',
        short_name: '员工客户端',
        description: '员工客户端——让每一件事，都有回音。员工工作收件箱与个人项目空间。',
        lang: 'zh-CN',
        start_url: './',
        scope: './',
        display: 'standalone',
        orientation: 'portrait',
        background_color: '#f5f7f8',
        theme_color: '#f5f8f5',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      injectManifest: {
        globPatterns: ['**/*.{js,css,html,svg,png,ico,woff2}'],
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
      },
      devOptions: { enabled: false },
    }),
  ],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: {
    host: true,
    port: Number(process.env.VITE_PORT || 5173),
    proxy: {
      '/api': { target: V8_PROXY, changeOrigin: true },
      '/hufu': { target: HUFU_PROXY, changeOrigin: true },
    },
  },
  build: {
    target: 'es2020',
    outDir: 'dist',
    sourcemap: false,
  },
});
