import { registerPlugin } from '@capacitor/core';
const viewer = registerPlugin<{ open(options: { url: string }): Promise<void> }>('EmployeeClientFileViewer');
import { isAndroidNative } from '@/session/installation';

/** File pages must open for viewing, never trigger the system share workflow. */
export async function openFilePage(address: string): Promise<void> {
  const url = new URL(address);
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('文件地址无效');
  if (isAndroidNative()) {
    await viewer.open({ url: url.href });
  } else {
    const opened = window.open(url.href, '_blank', 'noopener,noreferrer');
    // noopener can return null even when navigation succeeds; do not open a second tab.
    void opened;
  }
}

/** Reserve a web window in the click gesture before fetching a signed URL. */
export async function openResolvedFilePage(resolveAddress: () => Promise<string>): Promise<void> {
  if (isAndroidNative()) { await openFilePage(await resolveAddress()); return; }
  const opened = window.open('about:blank', '_blank');
  if (!opened) throw new Error('请允许打开新窗口后重试');
  opened.opener = null;
  try {
    const url = new URL(await resolveAddress());
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error('文件地址无效');
    if (!opened.closed) opened.location.replace(url.href);
  } catch (error) { opened.close(); throw error; }
}
