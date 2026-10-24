// src/api/client.ts —— 【职责2 统一 API 层】唯一 HTTP 客户端。
// 所有页面/Store 通过这里访问中枢；认证头、幂等键、错误映射、超时与可重试只实现一次，不各页面各写一套。
import type { ErrorCode } from './types';
import { serviceOrigin } from './runtime';
import {businessRequest} from '@/native/business-transport.mjs';
import {NativeError} from '@/native/client.mjs';

export class ApiError extends Error {
  code: ErrorCode;
  hint: string;
  status: number;
  constructor(code: ErrorCode, hint: string, status: number) {
    super(`[${code}] ${hint || ''}`.trim());
    this.code = code; this.hint = hint || ''; this.status = status;
  }
  /** 可重试：网络中断、上游不可达、供应商暂时失败（不改变已成功的业务事实） */
  get retryable(): boolean { return [408,502,503,504].includes(this.status)||this.code === 'network' || this.code === 'upstream_unavailable' || this.code === 'provider_unavailable'; }
  /** 需要重新认证：设备会话被解绑/撤销或身份权限服务失效 */
  get needsAuth(): boolean { return this.code === 'unauthenticated'; }
}

export interface ApiConfig {
  fastMedia?: boolean;
  canWrite?:()=>boolean;
  isVerified?:()=>boolean;
  /** V8 产品 API 基址；默认 '' 表示同源（生产 /api 反向代理，开发由 Vite 代理） */
  apiBase: string;
  /** 身份权限服务鉴权基址；与产品 API 共用运行时服务 origin。 */
  hufuBase: string;
  /** 旧调用兼容位；原生会话不向 JavaScript 提供令牌。 */
  getToken: () => string | null;
  getEpoch: () => number;
  getAccount: () => string;
  /** 401/设备会话失效回调；由 session 层注入，用于触发重新连接（不在 API 层处理 UI） */
  onUnauthorized: () => void;
  onPersonalDenied?: () => Promise<void>;
  /** 单请求超时（毫秒） */
  timeoutMs: number;
}

export const apiConfig: ApiConfig = {
  apiBase: serviceOrigin(),
  hufuBase: serviceOrigin() + '/hufu',
  getToken: () => null,
  getEpoch: () => 0,
  getAccount: () => '',
  onUnauthorized: () => {},
  timeoutMs: 15000,
};
export function configureApi(patch: Partial<ApiConfig>): void { Object.assign(apiConfig, patch); }

export function captureApiLease() {
  const account=apiConfig.getAccount(),epoch=apiConfig.getEpoch();
  return {account,epoch,networkReady:()=>apiConfig.isVerified?.()!==false,valid:()=>Boolean(account)&&apiConfig.getAccount()===account&&apiConfig.getEpoch()===epoch};
}

export function isOnline(): boolean { return typeof navigator === 'undefined' ? true : navigator.onLine !== false; }

/** 生成一次业务动作的稳定幂等键：调用方在用户发起动作时生成一次，重试复用同一键，避免重复创建。 */
export function newIdempotencyKey(prefix = 'qn'): string {
  const rnd = (globalThis.crypto && 'randomUUID' in globalThis.crypto)
    ? globalThis.crypto.randomUUID().replace(/-/g, '').slice(0, 16)
    : Math.random().toString(36).slice(2) + Date.now().toString(36);
  return `${prefix}-${Date.now().toString(36)}-${rnd}`;
}

export interface RequestOptions {
  /** Override only for bounded long-running operations such as voice transcription. */
  timeoutMs?: number;
  body?: unknown;
  query?: Record<string, string | number | boolean | null | undefined>;
  /** 写操作幂等键；同一逻辑动作的重试必须复用同一键 */
  idempotencyKey?: string;
  /** 显式 Authorization 值（用于换取 qn1 前的身份权限服务 Bearer 调用）；缺省用 getToken() */
  auth?: string | null;
  /** 不自动附加 Authorization（匿名请求，如身份权限服务登录） */
  anonymous?: boolean;
  signal?: AbortSignal;
  /** 命中该 HTTP 状态不视为错误（如某些 4xx 需要读取 body） */
  raw?: boolean;
}

/** Only the current EmployeeClient business namespace uses the native member cookie. */
export async function apiRequest<T=unknown>(method:string,path:string,opts:RequestOptions={}):Promise<T>{
 if(!path.startsWith('/business/v1/'))throw new ApiError('unknown','该旧接口已退役，请使用当前中枢入口',410);
 if(apiConfig.isVerified?.()===false&&path!=='/business/v1/bootstrap')throw new ApiError('session_recovering','连接恢复后自动更新',0);
 const lease=captureApiLease();
 try{return await businessRequest(apiConfig.apiBase,method,path,{lease,body:opts.body,query:opts.query,key:opts.idempotencyKey,signal:opts.signal,timeout:opts.timeoutMs??apiConfig.timeoutMs,onUnauthorized:apiConfig.onUnauthorized}) as T;}
 catch(e){if(e instanceof NativeError)throw new ApiError(e.status===401?'unauthenticated':['business_transport_failed','business_transport_timeout'].includes(e.code)?'network':e.code as ErrorCode,e.message,e.status);if(e instanceof DOMException&&e.name==='AbortError')throw e;throw new ApiError('network','连接未完成，请重试',0);}
}

/** 对可重试错误（网络/上游不可达）有限重试；写操作靠同一幂等键保证不重复创建。 */
export async function withRetry<T>(fn: () => Promise<T>, attempts = 2, delayMs = 600): Promise<T> {
  let last: unknown;
  for (let i = 0; i <= attempts; i++) {
    try { return await fn(); }
    catch (e) {
      last = e;
      const retryable = e instanceof ApiError && e.retryable && !e.needsAuth;
      if (!retryable || i === attempts) throw e;
      await new Promise(r => setTimeout(r, delayMs * (i + 1)));
    }
  }
  throw last;
}

/** 身份权限服务鉴权调用（登录/刷新）——使用统一运行时服务 origin。 */
export async function hufuRequest<T = unknown>(path: string, opts: RequestOptions = {}): Promise<T> {
  const base = apiConfig.hufuBase.replace(/\/$/, '');
  const full = path.replace(/^\/hufu/, base);
  return apiRequest<T>('POST', full, { ...opts, anonymous: true });
}
