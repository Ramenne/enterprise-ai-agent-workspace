import { defineStore } from 'pinia';
import { ref } from 'vue';
import { captureApiLease } from '@/api/client';
import { metaByPrefix, metaSet, metaRemove } from '@/session/db';
import type { ChatMessage, ChatContext } from '@/api/types';
import type { ForwardAttachment } from '@/files/forward';
import { messageSnippet } from '@/chat/presentation';

export interface ComposerDraft {
  body: string; mentions: string[]; reply: ChatMessage | null; attachments: ForwardAttachment[];
  selectedContext: ChatContext | null; contextExplicit: boolean; updatedAt: number;
}
export function normalizeDraft(value: unknown): ComposerDraft | null {
  if (!value || typeof value !== 'object') return null;
  const d = value as ComposerDraft;
  if (typeof d.body !== 'string' || d.body.length > 4000 || !Array.isArray(d.mentions) ||
      !d.mentions.every(x => typeof x === 'string') || !Array.isArray(d.attachments) ||
      !d.attachments.every(x => x && typeof x.id === 'string' && typeof x.name === 'string' && typeof x.mime === 'string') ||
      (d.reply && (typeof d.reply.id !== 'string' || typeof d.reply.body !== 'string' || !Array.isArray(d.reply.attachments)))) return null;
  return JSON.parse(JSON.stringify({ body: d.body, mentions: d.mentions, reply: d.reply || null, attachments: d.attachments,
    selectedContext: d.selectedContext && typeof d.selectedContext.project_id === 'string' ? d.selectedContext : null,
    contextExplicit: d.contextExplicit === true, updatedAt: Number.isFinite(d.updatedAt) ? d.updatedAt : 0 }));
}
export function hasDraft(d: ComposerDraft): boolean {
  return Boolean(d.body.trim() || d.attachments.length || d.reply || d.selectedContext);
}
export function sameDraftContent(a: ComposerDraft, b: ComposerDraft): boolean {
  return JSON.stringify({...a,updatedAt:0}) === JSON.stringify({...b,updatedAt:0});
}
export function draftPreview(d: ComposerDraft): string {
  return messageSnippet(d) || (d.reply ? '引用：' + messageSnippet(d.reply) : '') ||
    (d.selectedContext ? '关联：' + (d.selectedContext.work_title || d.selectedContext.project_title) : '');
}

// Local editing state; the existing pending message/receipt remains the only
// sending authority. Writes are ordered per conversation and fenced at IDB.
export const useComposerDraftStore = defineStore('composer-drafts', () => {
  const account = ref(''), entries = ref<Record<string, ComposerDraft>>({}), errors = ref<Record<string, string>>({});
  let epoch = 0, loaded = false, flight: Promise<void> | null = null;
  const writes = new Map<string, Promise<void>>(), edited = new Set<string>(), committed = new Map<string, ComposerDraft>();
  function setAccount(owner: string) {
    if (account.value === owner) return;
    epoch++; account.value = owner; entries.value = {}; errors.value = {}; edited.clear(); committed.clear(); loaded = false; flight = null;
  }
  function load(owner: string): Promise<void> {
    setAccount(owner); if (!owner || loaded) return Promise.resolve(); if (flight) return flight;
    const n = epoch;
    const work = metaByPrefix<unknown>(owner, 'composer:').then(saved => {
      if (n !== epoch || owner !== account.value) return;
      for (const [peer, value] of Object.entries(saved)) {
        if (edited.has(peer)) continue;
        const d = normalizeDraft(value);
        if (d && hasDraft(d)) { entries.value[peer] = d; committed.set(peer, d); }
        else if (!d) errors.value[peer] = '本机草稿无法读取，请保留当前输入后重试。';
      }
      loaded = true;
    }).finally(() => { if (flight === work) flight = null; });
    flight = work; return work;
  }
  function isSaved(peer: string, value: ComposerDraft): boolean {
    const saved = committed.get(peer);
    return !errors.value[peer] && (saved ? sameDraftContent(value, saved) : !hasDraft(value));
  }
  async function save(owner: string, peer: string, value: ComposerDraft): Promise<void> {
    const lease = captureApiLease(), n = epoch;
    if (!owner || owner !== account.value || owner !== lease.account || !lease.valid()) return;
    const draft = normalizeDraft(value); if (!draft) throw Error('草稿内容无法保存');
    // A clear must still follow an in-flight write, even if no previous durable
    // record existed. Optimistic entries alone cannot prove persistence.
    const key = JSON.stringify([owner, peer]);
    if (!writes.has(key) && isSaved(peer, draft)) return;
    const prior = entries.value[peer]; if (prior && sameDraftContent(prior, draft)) draft.updatedAt = prior.updatedAt;
    edited.add(peer); if (hasDraft(draft)) entries.value[peer] = draft; else delete entries.value[peer];
    const valid = () => n === epoch && owner === account.value && lease.valid();
    const work = (writes.get(key) || Promise.resolve()).catch(() => {}).then(async () => {
      if (!valid()) return;
      try {
        if (hasDraft(draft)) await metaSet(owner, 'composer:' + peer, draft, valid);
        else await metaRemove(owner, 'composer:' + peer, valid);
        if (valid()) { if (hasDraft(draft)) committed.set(peer, draft); else committed.delete(peer); delete errors.value[peer]; }
      } catch (e) { if (valid()) errors.value[peer] = '草稿尚未保存到本机，请保留当前输入并重试。'; throw e; }
    });
    writes.set(key, work);
    try { await work; } finally { if (writes.get(key) === work) writes.delete(key); }
  }
  return { account, entries, errors, setAccount, load, save, isSaved };
});
