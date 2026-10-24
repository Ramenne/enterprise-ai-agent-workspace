// src/session/tokenStore.ts —— 【职责3 会话层】设备会话令牌的运行时持久化。
// 安全边界：这里保存的是【运行时会话】（qn1 设备会话 + 用于无感重换的身份权限服务 refresh_token，或降级模式下的身份权限服务 Bearer+refresh），
// 不是写进源码/交付物的凭据。正常使用中服务端会用密封凭据自动续期 qn1，本机 refresh_token 只在 qn1 确已失效时用于无感重换。
// 会话被服务端判定失效时由 store.restore 的失效分支调用 clearSession() 清除；手机端没有用户可触发的登出入口（策划 v0.24）。

export type SessionMode = 'device' | 'bearer' | 'bearer-dev';   // device=qn1 设备会话（正式路径）；bearer-dev=仅开发调试显式开启的身份权限服务直连；bearer=旧会话兼容
export interface SessionToken {
  mode: SessionMode;         // device=qn1 设备会话；bearer=身份权限服务令牌直连（无推送时的降级/开发路径）
  token: string;             // Authorization 里使用的令牌（qn1.* 或身份权限服务 token）
  refreshToken?: string;     // 身份权限服务 refresh_token：bearer 模式用于客户端自续期；device 模式用于 qn1 失效时的无感重换
  username: string;
  installationId: string;
  issuedAt: number;
}

const KEY = 'qn.session';

export function loadSession(): SessionToken | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as SessionToken;
    if (!s || !s.token || !s.username) return null;
    return s;
  } catch { return null; }
}
export function saveSession(s: SessionToken): void {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* 隐私模式：仅内存态由 store 持有 */ }
}
export function clearSession(): void {
  try { localStorage.removeItem(KEY); } catch { /* 忽略 */ }
}
