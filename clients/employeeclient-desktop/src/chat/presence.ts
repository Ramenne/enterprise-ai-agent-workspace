export interface PresenceMember {
  online?: boolean;
  last_seen_at?: number | string | null;
  /** Kept for older cached member snapshots while V8 0.6.34 rolls out. */
  last_auth_sync_at?: number | string | null;
}

function timestamp(value: number | string | null | undefined): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 0) return numeric;
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

export function presenceStatus(member: PresenceMember, now = Date.now()): string {
  if (member.online === true) return '在线';
  const stamp = timestamp(member.last_seen_at ?? member.last_auth_sync_at);
  if (!stamp || stamp < 0) return '离线';
  const elapsed = Math.max(0, now - stamp);
  if (elapsed <= 60_000) return '1分钟之内在线';
  if (elapsed <= 3 * 60_000) return '3分钟之内在线';
  if (elapsed <= 5 * 60_000) return '5分钟之内在线';
  if (elapsed <= 30 * 60_000) return '半个小时之内在线';
  const today = new Date(now); today.setHours(0, 0, 0, 0);
  const yesterday = new Date(today); yesterday.setDate(yesterday.getDate() - 1);
  if (stamp >= today.getTime()) return '当天在线';
  if (stamp >= yesterday.getTime()) return '昨日在线';
  if (elapsed <= 7 * 86_400_000) return '7天之内在线';
  return '一个月之内在线';
}

/** Deterministic display order, without extra member requests. */
export function comparePresence(a: PresenceMember & { nickname?: string; username?: string }, b: PresenceMember & { nickname?: string; username?: string }): number {
  const online = Number(b.online === true) - Number(a.online === true);
  if (online) return online;
  if (a.online !== true) {
    const recent = timestamp(b.last_seen_at ?? b.last_auth_sync_at) - timestamp(a.last_seen_at ?? a.last_auth_sync_at);
    if (recent) return recent;
  }
  return (a.nickname || a.username || '').localeCompare(b.nickname || b.username || '', 'zh-CN-u-co-pinyin', { sensitivity: 'base' }) || (a.username || '').localeCompare(b.username || '');
}
