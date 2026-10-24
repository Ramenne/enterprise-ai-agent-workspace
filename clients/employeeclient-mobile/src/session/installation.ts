// src/session/installation.ts —— 【职责4 平台适配层的一部分】安装实例标识与平台识别。
// installation_id：一次安装一个、稳定持久；用于当前身份权限服务主体下的设备绑定。不携带任何凭据。
//
// 策划 v0.24 §零-8：Android 设备以“身份权限服务认证账号 + 稳定 device_id + 服务端设备绑定关系”识别，
// 并明确“若现有 Contract 使用 installation_id，则对应同一安装实例，不另建两套设备身份”。
// 因此本工程的 installation_id 就是策划所说的 device_id：同一安装生命周期内稳定，卸载重装才重建；
// 不引入第二个设备标识字段，也不依赖任何供应商 deviceId。
import type { DevicePlatform } from '@/api/types';

const INSTALL_KEY = 'qn.installation_id';

/** Capacitor 注入的原生桥（Android 薄壳）；Web/PWA 下不存在。 */
interface CapacitorBridge { isNativePlatform?: () => boolean; getPlatform?: () => string; }
function cap(): CapacitorBridge | null {
  return (globalThis as unknown as { Capacitor?: CapacitorBridge }).Capacitor || null;
}

/** 是否运行在 Android 原生薄壳内（Capacitor）。 */
export function isAndroidNative(): boolean {
  const c = cap();
  return !!c && !!c.isNativePlatform && c.isNativePlatform() && (c.getPlatform ? c.getPlatform() : '') === 'android';
}

/** 后端设备平台枚举：Android 薄壳=android_native；其余（iOS PWA / 浏览器）=ios_web_push（Web Push）。 */
export function devicePlatform(): DevicePlatform {
  return isAndroidNative() ? 'android_native' : 'ios_web_push';
}

/** 取得或创建稳定的 installation_id（2-128 位 [A-Za-z0-9_.:-]，与后端校验一致）。 */
export function getInstallationId(): string {
  try {
    const existing = localStorage.getItem(INSTALL_KEY);
    if (existing && /^[A-Za-z0-9_.:-]{2,128}$/.test(existing)) return existing;
  } catch { /* 隐私模式等：退化为内存值 */ }
  const rnd = (globalThis.crypto && 'randomUUID' in globalThis.crypto)
    ? globalThis.crypto.randomUUID().replace(/-/g, '')
    : Array.from({ length: 32 }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('');
  const id = 'qn-' + rnd.slice(0, 24);
  try { localStorage.setItem(INSTALL_KEY, id); } catch { /* 不阻断 */ }
  return id;
}

/** 是否具备 Web Push 能力（浏览器/PWA）。
 *  iPhone PWA 靠它接收系统推送；Android 本期不用供应商推送，弹窗由 localNotify.ts 本地触发
 *  （策划 v0.24 §零-1／§零-10：iPhone PWA Web Push 方案不变，Android 移除第三方供应商投递路径）。 */
export function hasWebPushSupport(): boolean {
  return typeof navigator !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window;
}
