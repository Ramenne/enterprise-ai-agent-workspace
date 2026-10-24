import {fullDate} from '@/ui/date.mjs';
const pad = (n: number) => String(n).padStart(2, '0');
const day = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
export function chatTime(timestamp: number, now = Date.now()): string {
  const date = new Date(timestamp), today = new Date(now);
  if (!Number.isFinite(date.getTime())) return '时间未知';
  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  if (day(date) === day(today)) return clock;
  const yesterday = new Date(today); yesterday.setDate(yesterday.getDate() - 1);
  if (day(date) === day(yesterday)) return `昨天 ${clock}`;
  return `${fullDate(date)} ${clock}`;
}
export function chatTimeMarkers(rows: { created_at: number }[]): boolean[] {
  let last = 0;
  return rows.map((row, index) => {
    const stamp = row.created_at;
    const show = index === 0 || day(new Date(stamp)) !== day(new Date(last)) || Math.abs(stamp - last) >= 5 * 60_000;
    if (show) last = stamp;
    return show;
  });
}
