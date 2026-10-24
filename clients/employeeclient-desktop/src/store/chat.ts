import {createRecoveryGate} from '@/platform/recoveryGate.mjs';
import {userError} from '../domain/userError.mjs';
import { defineStore } from 'pinia';
import { ref } from 'vue';
import { communication } from '@/api/endpoints';
import { ApiError, newIdempotencyKey } from '@/api/client';
import { metaGet, metaSet } from '@/session/db';
import type { AssigneeOption, ChatMessage, ChatSendBody } from '@/api/types';
import {mergeChatMessages,applyChatChanges} from '@/chat/projection';

interface Snapshot { messages: ChatMessage[]; cursor: number; schema?: number; quoteProjection?:number; changeCursor?: number | null; canLoadOlder?: boolean; }
interface Mutation { id: string; action: 'hide' | 'recall'; key: string; }
interface Pending { body: ChatSendBody; key: string; }
export const useChatStore = defineStore('chat', () => {
  const peer=ref('');
  const cacheKey=(name:string)=>peer.value?name+':direct:'+peer.value:name;
  const account = ref(''); const messages = ref<ChatMessage[]>([]); const members = ref<AssigneeOption[]>([]);
  const cursor = ref(0); const loading = ref(false); const sending = ref(false); const error = ref('');
  const memberLoading=ref(false),memberError=ref('');
  const restoring = ref(false); const initialized = ref(false); const canLoadOlder = ref(false); const pending = ref<Pending | null>(null);
  const mutationPending = ref<Mutation | null>(null), mutating = ref(false);
  let changeCursor: number | null = null;
  let verifyCachedQuotes=false;
  let hydration: Promise<void> = Promise.resolve();
  let memberFlight: Promise<void> | null = null;
  let membersLoaded = false,memberPending=false,memberEpoch=0;
  const currentMembers=(a:string,e:number)=>account.value===a&&memberEpoch===e;
  let refreshPending = false;
  const readRecovery=createRecoveryGate({wake:()=>{if(account.value)void refresh();}});
  function cancelReadRetry(){readRecovery.cancel();}
  let epoch = 0; let active: AbortController | null = null;
  function current(a: string, e: number) { return account.value === a && epoch === e; }
  function merge(rows: ChatMessage[]) {
    messages.value = mergeChatMessages([...messages.value,...rows]);
  }
  function setAccount(a: string, conversation=''): Promise<void> {
    if (account.value === a && peer.value===conversation) return hydration;
    const sameOwner=account.value===a,priorMembers=members.value,priorMembersLoaded=membersLoaded;
    cancelReadRetry();refreshPending = false; peer.value=conversation; epoch++; active?.abort(); active = null;
    if(!sameOwner){memberEpoch++;memberFlight=null;memberPending=false;memberLoading.value=false;memberError.value='';}
    membersLoaded = sameOwner&&priorMembersLoaded;account.value = a;
    messages.value = []; members.value = sameOwner?priorMembers:[]; cursor.value = 0; loading.value = false; sending.value = false;
    changeCursor = null; verifyCachedQuotes=false; mutationPending.value = null; mutating.value = false;
    error.value = ''; initialized.value = false; canLoadOlder.value = false; pending.value = null;
    restoring.value = !!a;
    if (!a) { hydration = Promise.resolve(); return hydration; }
    const e = epoch;
    hydration = (async () => {
    try {
      const [cached, draft, mutation, cachedMembers] = await Promise.all([metaGet<Snapshot>(a, cacheKey('chat_snapshot')), metaGet<Pending>(a, cacheKey('chat_pending')), metaGet<Mutation>(a, cacheKey('chat_mutation')),metaGet<AssigneeOption[]>(a,'chat_members')]);
      if (!current(a, e)) return;
      if (cached && Array.isArray(cached.messages)) {
        messages.value = cached.messages.filter(m => !!m.id && Number.isSafeInteger(m.seq));
        verifyCachedQuotes=cached.quoteProjection!==1&&messages.value.some(m=>!!m.reply_to);
        // Resume only snapshots with a contiguous read window and a change cursor.
        // Old snapshots are kept visible until their one-time migration fetch.
        const resumable = cached.schema === 3 && Number.isSafeInteger(cached.cursor) && cached.cursor >= 0 && Number.isSafeInteger(cached.changeCursor) && cached.changeCursor! >= 0;
        cursor.value = resumable ? cached.cursor : 0;
        changeCursor = resumable ? cached.changeCursor! : null;
        initialized.value = resumable;
        canLoadOlder.value = resumable ? !!cached.canLoadOlder : messages.value.length > 0;
      }
      pending.value = draft; mutationPending.value = mutation;if(!sameOwner&&Array.isArray(cachedMembers))members.value=cachedMembers;
    } catch { /* Cache failure never prevents the authoritative network fetch. */ }
    finally { if (current(a, e)) restoring.value = false; }
    })();
    return hydration;
  }
  async function save(a: string, e: number) {
    if (!current(a, e)) return;
    // Preserve every already-read page and its cursors across app restarts.
    await metaSet(a, cacheKey('chat_snapshot'), JSON.parse(JSON.stringify({ schema: 3, quoteProjection:verifyCachedQuotes?0:1,messages: messages.value, cursor: cursor.value, changeCursor, canLoadOlder: canLoadOlder.value }))).catch(() => undefined);
  }
  async function refresh(input: boolean | { changed?: boolean } = false) {
    const strict = typeof input === 'boolean' ? input : false;
    const options = typeof input === 'object' ? input : {};
    const owner = account.value, generation = epoch; await hydration;
    if (!current(owner, generation)) return;
    if (!account.value) return;
    if (loading.value) { if(options.changed)refreshPending = true; return; }
    if(!readRecovery.ready()){refreshPending=true;return;}
    refreshPending = false;
    const a = account.value, e = epoch; active = new AbortController(); loading.value = true; error.value = '';
    try {
      // The member directory must not delay or prevent history from appearing.
      void refreshMembers();
      // Independent streams share current authority in flight, without a TTL cache.
      let prefetchedChanges = initialized.value && changeCursor !== null ? communication.changes(changeCursor, active.signal,peer.value||undefined) : null;
      // Install a rejection handler immediately while the message request is pending.
      prefetchedChanges?.catch(()=>{});
      let more = true;
      while (more && current(a, e)) {
        const first = !initialized.value;
        const page = await communication.messages(first ? { peer:peer.value||undefined,limit: 50 } : { peer:peer.value||undefined,after: cursor.value, limit: 50 }, active.signal);
        if (!current(a, e)) return;
        if (!Array.isArray(page.messages) || !Number.isSafeInteger(page.next_cursor)) throw Error('消息返回格式异常');
        if (!first && page.has_more && page.next_cursor <= cursor.value) throw Error('消息游标未推进');
        // Start from a continuous server window: merging a stale prefix could leave
        // an unpageable gap. Keep only newer concurrently acknowledged sends.
        if (first) { const ids = new Set(page.messages.map(m => m.id)); messages.value = messages.value.filter(m => m.seq > page.next_cursor || ids.has(m.id)); }
        merge(page.messages);
        cursor.value = Math.max(cursor.value, page.next_cursor);
        if (Number.isSafeInteger(page.sync_cursor) && changeCursor === null) changeCursor = first ? page.sync_cursor! : 0;
        initialized.value = true;
        if (first) canLoadOlder.value = !!page.has_more_old;
        more = !first && page.has_more;
        await save(a, e);
      }
      if (changeCursor !== null) {
        let moreChanges = true;
        while (moreChanges && current(a, e)) {
          const changes: Awaited<ReturnType<typeof communication.changes>> = await (prefetchedChanges || communication.changes(changeCursor!, active.signal,peer.value||undefined));prefetchedChanges=null;
          if (!current(a, e)) return;
          if (!Number.isSafeInteger(changes.next_change_cursor) || changes.next_change_cursor < changeCursor! || (changes.has_more && changes.next_change_cursor <= changeCursor!)) throw Error('消息变更游标未推进');
          applyChanges(changes.changes.map(change => change.message));
          changeCursor = changes.next_change_cursor; moreChanges = changes.has_more; await save(a, e);
        }
      }
      // Older clients may already have consumed a recall cursor without updating
      // its quoted copy. Revalidate only cached referenced IDs once, keeping the
      // user's loaded pages and cursors intact; never rescan all old history.
      if(verifyCachedQuotes){
        const ids=[...new Set(messages.value.flatMap(m=>m.reply_to?[m.reply_to.id]:[]))];
        for(let start=0;start<ids.length;start+=4){
          const refs=await Promise.all(ids.slice(start,start+4).map(id=>communication.message(id,active!.signal)));
          if(!current(a,e))return;
          if(refs.some((r,index)=>r.message?.id!==ids[start+index]||(r.message.conversation_peer||'')!==peer.value))throw Error('引用原话返回不属于当前会话，请重试');
          applyChanges(refs.map(r=>r.message));
        }
        verifyCachedQuotes=false;await save(a,e);
      }
      readRecovery.completed();
    } catch (err) {
      if(current(a,e)){
        // A conversation refresh is not a failed user action. Keep the cache
        // and silently retry temporary transport/identity recovery in this scope.
        const temporary=err instanceof ApiError&&(err.status===0||err.status===401||err.status===429||err.status>=500);
        if(temporary){
          readRecovery.failed();
        }else if(!(err instanceof DOMException&&err.name==='AbortError'))error.value=err instanceof Error?err.message:'群消息暂未更新';
      }
      if(strict)throw err;
    }
    finally {
      if (current(a, e)) { loading.value = false; if (refreshPending&&!readRecovery.waiting) { refreshPending = false; await refresh(); } }
    }
  }
  async function refreshMembers(force = false, changed = false): Promise<void> {
    const owner = account.value, generation = memberEpoch; await hydration;
    if (!currentMembers(owner, generation) || !owner) return;
    if (memberFlight) {if(changed)memberPending=true;return memberFlight;}
    if (membersLoaded && !force) return;
    memberLoading.value=true;memberError.value='';
    const work = communication.members().then(async options => {
      if (currentMembers(owner, generation)) { membersLoaded = true;if(JSON.stringify(members.value)!==JSON.stringify(options.members)){members.value = options.members;await metaSet(owner,'chat_members',JSON.parse(JSON.stringify(options.members))).catch(()=>{});} }
    }).catch(e => {if(currentMembers(owner,generation)){memberError.value='成员状态暂未更新';if(e instanceof ApiError&&e.status===403)members.value=[];}}).finally(async () => { if (memberFlight === work) {memberFlight=null;memberLoading.value=false;if(memberPending){memberPending=false;await refreshMembers(true,true);}} });
    memberFlight = work;
    return work;
  }
  function applyChanges(rows: ChatMessage[]) {
    messages.value=applyChatChanges(messages.value,rows);
  }
  async function changeMessage(id?: string, action?: 'hide' | 'recall'): Promise<boolean> {
    const a = account.value, e = epoch; await hydration;
    if (!current(a, e) || !a || mutating.value) return false;
    if (mutationPending.value && id && (mutationPending.value.id !== id || mutationPending.value.action !== action)) {
      error.value = '请先确认上一次消息操作的结果'; return false;
    }
    if (!mutationPending.value) {
      if (!id || !action) return false;
      mutationPending.value = { id, action, key: newIdempotencyKey('chat-' + action) };
    }
    const operation = mutationPending.value; mutating.value = true; error.value = '';
    try {
      await metaSet(a, cacheKey('chat_mutation'), JSON.parse(JSON.stringify(operation)));
      if (!current(a, e)) return false;
      const receipt = await communication.changeMessage(operation.id, operation.action, operation.key);
      if (!current(a, e)) return false;
      if (receipt.message?.id !== operation.id) throw Error('消息操作回执不完整，请重试确认');
      applyChanges([receipt.message]);
      mutationPending.value = null;
      await metaSet(a, cacheKey('chat_mutation'), null).catch(() => undefined); await save(a, e);
      return true;
    } catch (err) {
      if (current(a, e)) {
        error.value = err instanceof Error ? err.message : '消息操作失败';
        if (err instanceof ApiError && [400,403,404,409,422].includes(err.status)) {
          mutationPending.value = null; await metaSet(a, cacheKey('chat_mutation'), null).catch(() => undefined);
        }
      }
      return false;
    } finally { if (current(a, e)) mutating.value = false; }
  }
  async function older() {
    const owner = account.value, generation = epoch; await hydration;
    if (!current(owner, generation)) return;
    if (loading.value || !messages.value.length || !canLoadOlder.value) return;
    const a = account.value, e = epoch; loading.value = true; error.value = ''; 
    try {
      const page = await communication.messages({ peer:peer.value||undefined,before: messages.value[0].seq, limit: 50 });
      if (!current(a, e)) return;
      merge(page.messages); canLoadOlder.value = !!page.has_more_old; await save(a, e);
    } catch (err) { if (current(a, e)) error.value = err instanceof Error ? err.message : '历史消息加载失败'; }
    finally {
      if (current(a, e)) { loading.value = false; if (refreshPending&&!readRecovery.waiting) { refreshPending = false; await refresh(); } }
    }
  }
  function acceptChange(a:string,conversation:string,message:ChatMessage){
    if(account.value!==a||peer.value!==conversation||!message?.id||(message.conversation_peer||'')!==conversation)return false;
    applyChanges([message]);void save(a,epoch);return true;
  }
  function acceptSent(a:string,conversation:string,message:ChatMessage){
    if(account.value!==a||peer.value!==conversation||!message?.id||message.author_username!==a||(message.conversation_peer||'')!==conversation)return false;
    merge([message]);void save(a,epoch);return true;
  }
  async function send(body?: ChatSendBody, operationKey?: string): Promise<ChatMessage | false> {
    const owner = account.value, generation = epoch; await hydration;
    if (!current(owner, generation)) return false;
    if (!account.value || sending.value) return false;
    const a = account.value, e = epoch;
    // An uncertain send must first be retried with the original immutable body and key.
    if (!pending.value) {
      if (!body) return false;
      pending.value = { body: JSON.parse(JSON.stringify({...body,...(peer.value?{recipient_username:peer.value}:{})})), key: operationKey || newIdempotencyKey('chat') };
    }
    const operation = pending.value; sending.value = true; error.value = '';
    try {
      await metaSet(a, cacheKey('chat_pending'), JSON.parse(JSON.stringify(operation)));
      if (!current(a, e)) return false;
      const receipt = await communication.send(operation.body, operation.key);
      if (!current(a, e)) return false;
      if (!receipt.message?.id) throw Error('发送回执不完整，请重试确认');
      merge([receipt.message]); pending.value = null;
      // Do not advance the read cursor to our own message: intervening messages must still be fetched.
      await metaSet(a, cacheKey('chat_pending'), null).catch(() => undefined); await save(a, e);
      return receipt.message;
    } catch (err) {
      if (current(a, e)) {
        error.value = userError(err, '发送未完成，内容已保留，请重试');
        if (err instanceof ApiError && [400, 403, 404, 413, 422].includes(err.status)) {
          pending.value = null; await metaSet(a, cacheKey('chat_pending'), null).catch(() => undefined);
        }
      }
      return false;
    }
    finally { if (current(a, e)) sending.value = false; }
  }
  function applyAvatar(actor:string,version:string){const row=members.value.find(m=>m.username===actor);if(row)row.avatar_version=version;}
  return { peer, account, messages, members, memberLoading,memberError,applyAvatar,cursor, loading, sending, error, restoring, initialized, canLoadOlder, pending, mutationPending, mutating, changeMessage, setAccount, refresh, refreshMembers, older, send, acceptSent,acceptChange };
});
