/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue';
  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>;
  export default component;
}

interface ImportMetaEnv {
  /** 共享服务端统一基址；API、身份权限服务和事件连接均从此值派生。 */
  readonly VITE_PUBLIC_ORIGIN?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
