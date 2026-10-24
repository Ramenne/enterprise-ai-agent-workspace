// Android native update only. No PWA registration, route or service-worker cache.
import { registerPlugin } from '@capacitor/core';
import type { PluginListenerHandle } from '@capacitor/core';
import { isAndroidNative } from '@/session/installation';

export type InstalledVersion = { packageName: string; versionCode: number; versionName: string; signerSha256: string };
export type AvailableVersion = {
  versionCode: number; versionName: string; currentVersionCode: number; currentVersionName: string;
  notes: string; size: number; available: boolean; downloaded: boolean;
};
export type UpdateProgress = { received: number; total: number };

const native = registerPlugin<{
  current(): Promise<InstalledVersion>;
  check(): Promise<AvailableVersion>;
  download(): Promise<{ downloaded: boolean }>;
  cancel(): Promise<void>;
  install(): Promise<{ status: 'permission_required' | 'installer_opened' }>;
  addListener(name: 'progress', fn: (e: UpdateProgress) => void): Promise<PluginListenerHandle>;
}>('EmployeeClientUpdate');

function requireAndroid() { if (!isAndroidNative()) throw new Error('仅安卓安装包支持应用内更新'); }
export async function currentVersion() { requireAndroid(); return native.current(); }
export async function checkAndroidUpdate() { requireAndroid(); return native.check(); }
export async function downloadAndroidUpdate() { requireAndroid(); return native.download(); }
export async function cancelAndroidUpdate() { requireAndroid(); return native.cancel(); }
export async function installAndroidUpdate() { requireAndroid(); return native.install(); }
export async function onAndroidUpdateProgress(fn: (e: UpdateProgress) => void) {
  requireAndroid(); return native.addListener('progress', fn);
}
