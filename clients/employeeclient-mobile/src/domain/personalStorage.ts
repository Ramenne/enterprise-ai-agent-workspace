import { ApiError } from '@/api/client';
import type { PersonalStorageContext, PersonalStorageDiscovery, PersonalStorageFile } from '@/api/types';

/** The client presents the active projection, never tombstoned files. */
export function activePersonalFiles(files: PersonalStorageFile[] | PersonalStorageContext['files'] = []) {
  return files.filter(file => !('removed_at' in file) || !file.removed_at);
}

/** A count that includes files discovered from 资料存储服务 as well as V8-created jobs. */
export function personalStorageFileCount(context: PersonalStorageContext | null): number {
  return activePersonalFiles(context?.files || []).length;
}

export function personalStorageStateLabel(state: PersonalStorageDiscovery['state'] | undefined): string {
  if (state === 'synced') return '梦空间已同步';
  if (state === 'syncing') return '正在同步梦空间';
  if (state === 'failed') return '梦空间同步失败';
  if (state === 'unavailable') return '梦空间暂不可用';
  return '正在确认梦空间';
}

export function personalStorageDisplayLabel(context: PersonalStorageContext | null, discovery: PersonalStorageDiscovery | null): string {
  const project = discovery?.projects.find(row => row.project_id === context?.project_id);
  const state = project?.state || project?.status || discovery?.state;
  const lastError = project?.last_error || context?.last_error;
  if (context?.status === 'failed' || state === 'failed') {
    if (personalStorageFileCount(context) > 0) return lastError === 'storage_http_429'
      ? '文件已加载，梦空间同步暂时受限'
      : '文件已加载，梦空间同步暂时失败';
    return '梦空间同步失败';
  }
  if (context?.status === 'pending' || state === 'syncing') return '正在同步梦空间';
  if (context?.status === 'synced' && state !== 'synced') return '已加载已归档文件，等待确认新文件';
  return personalStorageStateLabel(state as PersonalStorageDiscovery['state']);
}

/** Keep transport and authorization failures distinct in the UI without exposing raw internals. */
export function personalStorageErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.needsAuth || error.status === 401) return '登录状态已失效，请重新连接后再读取梦空间。';
    if (error.status === 403 || error.code === 'forbidden_scope') return '当前账号没有读取这个个人项目的权限。';
    if (error.retryable || error.status === 0) return '客户端连接梦空间失败，请稍后重试。';
    if (error.status === 404) return '这个个人项目尚未建立梦空间目录。';
    if (error.status === 503 || error.code === 'upstream_unavailable' || error.code === 'provider_unavailable') return '梦空间服务暂时不可用，请稍后重试。';
  }
  return '暂时无法确认梦空间状态，请稍后重试。';
}
