// src/session/db.ts —— 【职责3 会话与同步缓存层】IndexedDB 按账号分区缓存。
// 铁律：缓存只为启动速度与弱网恢复服务，不是权威账本；账号失效/解绑/退出必须清除对应账号记录，绝不跨账号串数据。
// 记录统一带 _account 字段并建索引；读取恒按当前账号过滤。

const DB_NAME = 'employeeclient-cache';
import { isPersonalRecord } from './scopeAccess';
import { jsonSnapshot } from './jsonSnapshot.mjs';
const DB_VERSION = 1;
export const STORES = ['tasks', 'issues', 'notifications', 'projects', 'announcements'] as const;
export type StoreName = typeof STORES[number];

export interface CachedRecord { id: string; _account: string; [k: string]: unknown; }

let dbp: Promise<IDBDatabase> | null = null;
function open(): Promise<IDBDatabase> {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('indexeddb_unavailable')); return; }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
      for (const s of STORES) {
        if (!db.objectStoreNames.contains(s)) {
          const store = db.createObjectStore(s, { keyPath: 'id' });
          store.createIndex('acct', '_account', { unique: false });
        }
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

function txp<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
}

/** 写入/覆盖一批记录（自动附加 _account）。 */
export async function putMany(store: StoreName, account: string, records: Array<Record<string, unknown>>, valid = () => true): Promise<void> {
  const db = await open();
  if (!valid()) return;
  const tx = db.transaction(store, 'readwrite');
  const os = tx.objectStore(store);
  for (const r of records) os.put(jsonSnapshot({ ...r, _account: account }));
  await new Promise<void>((res, rej) => { tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error); });
}

/** 删除某账号在某 store 的单条记录（服务端判定该 id 已不存在时清本地 ghost）。
 *  先按主键读出校验 _account 再删，只删属于本账号的记录，绝不跨账号串数据（本文件铁律）。
 *  同一事务的 onsuccess 内校验并删除，不在事务中 await，避免读取后跨账号覆盖的竞态。 */
export async function removeById(store: StoreName, account: string, id: string, valid = () => true): Promise<void> {
  const db = await open();
  if (!valid()) return;
  const wTx = db.transaction(store, 'readwrite');
  const os = wTx.objectStore(store), req = os.get(id);
  req.onsuccess = () => { if (valid() && req.result?._account === account) os.delete(id); };
  await new Promise<void>((res, rej) => { wTx.oncomplete = () => res(); wTx.onerror = () => rej(wTx.error); wTx.onabort = () => rej(wTx.error); });
}

/** 读取某账号在某 store 的全部缓存记录。 */
export async function getAllByAccount<T = CachedRecord>(store: StoreName, account: string): Promise<T[]> {
  const db = await open();
  const tx = db.transaction(store, 'readonly');
  const idx = tx.objectStore(store).index('acct');
  return txp(idx.getAll(account) as IDBRequest<T[]>);
}

/** meta 键值（按账号前缀隔离）：sync_version、notification_synced_at、bootstrap 摘要等。 */
export async function metaGet<T = unknown>(account: string, key: string): Promise<T | null> {
  const db = await open();
  const tx = db.transaction('meta', 'readonly');
  const r = await txp(tx.objectStore('meta').get(`${account}:${key}`) as IDBRequest<{ key: string; value: T } | undefined>);
  return r ? r.value : null;
}
/** Read this account's composer records without scanning unrelated caches. */
export async function metaByPrefix<T>(account: string, prefix: string): Promise<Record<string, T>> {
  const db = await open(), start = `${account}:${prefix}`;
  const tx = db.transaction('meta', 'readonly'), result: Record<string, T> = {};
  const req = tx.objectStore('meta').openCursor(IDBKeyRange.bound(start, start + '\uffff'));
  return new Promise((resolve, reject) => {
    req.onsuccess = () => { const cursor = req.result; if (!cursor) return;
      result[String(cursor.key).slice(start.length)] = cursor.value.value; cursor.continue(); };
    tx.oncomplete = () => resolve(result); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
  });
}
export async function metaSet(account: string, key: string, value: unknown, valid = () => true): Promise<void> {
  const db = await open();
  if (!valid()) return;
  const tx = db.transaction('meta', 'readwrite');
  tx.objectStore('meta').put({ key: `${account}:${key}`, value: jsonSnapshot(value) });
  await new Promise<void>((res, rej) => { tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error); });
}
/** 删除单个 meta 键（分页链走完后清续读游标；游标失效时清 sync_version 强制重同步）。 */
export async function metaRemove(account: string, key: string, valid = () => true): Promise<void> {
  const db = await open();
  if (!valid()) return;
  const tx = db.transaction('meta', 'readwrite');
  tx.objectStore('meta').delete(`${account}:${key}`);
  await new Promise<void>((res, rej) => { tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error); });
}

/** 清除某账号的全部缓存（登出/解绑/账号失效时调用）。 */
export async function clearAccount(account: string): Promise<void> {
  const db = await open();
  // One transaction: no partial cache clear and no await gap between account
  // lookup and deletion. Earlier write transactions finish before this one.
  const tx = db.transaction([...STORES, 'meta'], 'readwrite');
  for (const store of STORES) {
    const idx = tx.objectStore(store).index('acct');
    const req = idx.openCursor(IDBKeyRange.only(account));
    req.onsuccess = () => { const c = req.result; if (c) { c.delete(); c.continue(); } };
  }
  // 清除该账号 meta（前缀匹配）
  const req = tx.objectStore('meta').openCursor();
  req.onsuccess = () => { const c = req.result; if (c) { if (String(c.key).startsWith(account + ':')) c.delete(); c.continue(); } };
  await new Promise<void>((res, rej) => { tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error); });
}
/** Scope-only purge in one transaction. Company records and notification cursors stay intact. */
export async function clearPersonalScope(account: string): Promise<void> {
  const db = await open();
  const tx = db.transaction([...STORES, 'meta'], 'readwrite');
  for (const store of STORES) {
    const req = tx.objectStore(store).index('acct').openCursor(IDBKeyRange.only(account));
    req.onsuccess = () => { const c = req.result; if (c) {
      if (isPersonalRecord(c.value) || (store === 'projects' && c.value.scope !== 'company')) c.delete();
      c.continue();
    } };
  }
  const meta = tx.objectStore('meta'), req = meta.openCursor();
  req.onsuccess = () => { const c = req.result; if (!c) return;
    const k = String(c.key);
    if (k.startsWith(account + ':')) {
      if (k === account + ':list:projects') c.update({ key: k, value: [] });
      else if (Array.isArray(c.value.value)) c.update({ key: k, value: c.value.value.filter((r: Record<string, unknown>) => !isPersonalRecord(r)) });
    }
    c.continue();
  };
  await new Promise<void>((res, rej) => { tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error); });
}
/** Validate the session lease at the actual IDB write boundary, after open(). */
export function withLease(valid: () => boolean) {
  return {
    putMany: (s: StoreName, a: string, r: Array<Record<string, unknown>>) => putMany(s, a, r, valid),
    metaSet: (a: string, k: string, v: unknown) => metaSet(a, k, v, valid),
    metaRemove: (a: string, k: string) => metaRemove(a, k, valid),
    removeById: (s: StoreName, a: string, id: string) => removeById(s, a, id, valid),
  };
}
