import { isAndroidNative } from '@/session/installation';

// All network transports use this one origin. Capacitor's WebView is hosted at
// https://localhost, which is a UI origin only and must never become an API base.
const PRODUCTION_ORIGIN = 'https://employeeclient.example.invalid/';
const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env || {};

export function serviceOrigin(): string {
  const configured = (env.VITE_PUBLIC_ORIGIN || '').trim().replace(/\/$/, '');
  if (configured) return configured;
  if (isAndroidNative()) return PRODUCTION_ORIGIN;
  return '';
}

export function servicePath(path: string): string {
  const origin = serviceOrigin();
  return origin ? origin + path : path;
}
