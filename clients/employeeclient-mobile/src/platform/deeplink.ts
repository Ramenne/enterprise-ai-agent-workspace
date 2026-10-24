// src/platform/deeplink.ts —— 【职责4 平台适配层】把服务端受控深链/通知映射到客户端路由。
// 只接受服务端生成的对象深链，不接受任意外部 URL（与 02-Contract §四一致）。
// 服务端实际下发的深链只有五种（主线 `03-代码文档/当前实现/v8-v2/notify.mjs`，未合并候选 v1.3 同）：
//   /api/v2/control/tasks/:id、/api/v2/me/tasks/:id、/api/v2/me/issues/:id、/api/v2/me/announcements、/api/v2/me/devices；
// 当前原生 work_item 必须带真实 project_id；退役Task/Issue不猜映射。未识别来源返回null。
import type { Notification } from '@/api/types';

export interface DeepTarget { name: string; params: Record<string, string>; review?: boolean; query?: Record<string, string> }

/** 深链/通知共用的最小服务端事实（Android 本地通知点击只能从 extra 还原这几个字段）。 */
export interface NotifyTarget {
  kind?: string; object_type?: string; object_id?: string; deep_link?: string; project_id?: string; snapshot?: Record<string,unknown>;
}

/** 解析服务端深链（/api/v2/{me|control}/...）为客户端路由目标。 */
export function routeFromDeepLink(link: string, _kind?: string): DeepTarget | null {
  if (!link) return null;
  const projectUpdate = /^\/business\/v1\/projects\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/updates$/i.exec(link);
  if(projectUpdate)return {name:'work',params:{},query:{project:projectUpdate[1]}};
  const chat = /^(?:\/api\/v2\/company\/chat|\/business\/v1)\/messages(?:\/([^/?#]+))?$/.exec(link);
  if (chat) return { name: 'chat', params: {}, query: chat[1] ? { message: chat[1] } : {} };
  const ann = /^(?:\/api\/v2\/me|\/business\/v1)\/announcements\/([^/?#]+)$/.exec(link);
  if (ann) return { name: 'announcements', params: { id: ann[1] } };
  // Retired Task/Plan/Code IDs are not native work IDs. Do not fabricate a mapping.
  if (/\/api\/v2\/(?:me|control)\/(?:tasks|plans|code-versions|issues)\//.test(link)) return null;
  if (/announcements/.test(link)) return { name: 'announcements', params: {} };
  if (/devices/.test(link)) return { name: 'profile', params: {} };
  return null;
}

/** 由最小服务端事实推导跳转目标：优先 object_type/object_id（稳定），再回退 deep_link。 */
export function routeFromTarget(t: NotifyTarget): DeepTarget | null {
  const snapshot=t.snapshot||{},uuid=(v:unknown):v is string=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
  const project=t.project_id||snapshot.project_id;
  const work=t.object_type==='work_item'?t.object_id:snapshot.work_item_id;
  if(uuid(project)&&uuid(work))return {name:'work-detail',params:{id:work},query:{project,returnTo:'/notifications'}};
  const id = t.object_id;
  if (id) {
    switch (t.object_type) {
      case 'task':
      case 'plan':
      case 'code_version':
      case 'issue': return null;
      case 'announcement': return { name: 'announcements', params: { id } };
      case 'chat_message': return { name: 'chat', params: {}, query: { message: id,...(typeof snapshot.conversation_peer==='string'?{peer:snapshot.conversation_peer}:{}) } };
      case 'device': return { name: 'profile', params: {} };
      default: break;
    }
  }
  const target=routeFromDeepLink(t.deep_link || '', t.kind);
  if(target?.name==='chat'&&typeof snapshot.conversation_peer==='string')target.query={...target.query,peer:snapshot.conversation_peer};
  return target;
}

/** 由完整通知对象推导跳转目标。 */
export function routeFromNotification(n: Notification): DeepTarget | null {
  return routeFromTarget(n);
}

export function deepTargetQuery(target: DeepTarget): Record<string, string> {
  return { ...target.query, ...(target.review ? { review: '1' } : {}) };
}
export function notificationRoutePath(value: string | NotifyTarget, kind?: string): string {
  const target = typeof value==='string'?routeFromDeepLink(value, kind):routeFromTarget(value);
  if (!target) return '/work';
  const path = '/' + (target.name==='work-detail'?'work':target.name) + (target.params.id ? '/' + encodeURIComponent(target.params.id) : '');
  const query = new URLSearchParams(deepTargetQuery(target)).toString();
  return path + (query ? '?' + query : '');
}
