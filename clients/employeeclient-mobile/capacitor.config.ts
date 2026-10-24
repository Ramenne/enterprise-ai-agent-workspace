import type { CapacitorConfig } from '@capacitor/cli';

// 员工客户端 Android 薄壳配置：复用同一 Vue 构建产物（webDir=dist），不另建业务页面或写链。
// appId/appName 为公司签名与安装包的标识，正式集成时由主控确认；此处为可用默认值。
//
// 无 plugins 配置项是有意为之：Android 已取消第三方／厂商推送（阿里云 SDK、原生插件与
// @capacitor/push-notifications 依赖均已删除），不再存在需要配置的推送插件；
// iPhone 交付为 PWA，不走 Capacitor 原生，其 Web Push 由浏览器 PushManager + sw.ts 处理。
// 本地系统通知的渠道（employeeclient_work / _urgent / _silent）在运行时由
// src/platform/localNotify.ts 的 ensureChannels() 建立，Android 渠道不属于本配置文件的项。
const config: CapacitorConfig = {
  appId: 'com.workspace.employeeclient',
  appName: '员工客户端',
  webDir: 'dist',
  android: {
    // 生产以 HTTPS 同源 /api 反向代理接共享 V8；不允许混合内容。
    allowMixedContent: false,
  },
  server: {
    // 默认打包内置 dist（离线壳）；如需指向独立 origin，可在此配置 url（生产由主控决定）。
    androidScheme: 'https',
  },
};

export default config;
