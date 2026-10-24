import { computed, onScopeDispose, ref, watch, type Ref } from 'vue';
import {userError} from '@/domain/userError.mjs';
import { communication } from '@/api/endpoints';
import type { ChatFilter, ChatMessage } from '@/api/types';
import {mergeChatMessages} from './projection';
import {restoreViewWindow,type ViewRange} from './viewResume';

// A filtered server window is independent from the all-message sync/cache cursor.
export function useChatQuery(account: Ref<string>, filter: Ref<ChatFilter>) {
  const messages = ref<ChatMessage[]>([]), loading = ref(false), error = ref(''), hasOlder = ref(false),hasNewer=ref(false);
  const active = computed(() => Object.entries(filter.value).some(([key,value])=>key!=='peer'&&Boolean(value)));
  let refreshPending = false;
  let generation = 0, controller: AbortController | null = null;
  async function fetchPage(older = false, reset = false, changed = false, newer = false) {
    if (!active.value || !account.value) return;
    if (loading.value && !reset) { if(changed)refreshPending=true;return; }
    if(!older&&!newer&&!reset&&hasNewer.value&&messages.value.length){await restoreWindow({oldest:messages.value[0].seq,newest:messages.value.at(-1)!.seq,count:messages.value.length}).catch(()=>{});return;}
    refreshPending=false;
    controller?.abort(); controller = new AbortController();
    const signal = controller.signal, version = ++generation, owner = account.value;
    const valid = () => generation === version && account.value === owner && !signal.aborted;
    const boundary = older ? messages.value[0]?.seq : newer?messages.value.at(-1)?.seq:undefined;
    const preserveUntil = !older && !newer && !reset ? messages.value[0]?.seq : undefined;
    const rows: ChatMessage[] = []; let before = boundary, more = true;
    loading.value = true; error.value = '';
    try {
      do {
        const page = await communication.messages({ ...filter.value, ...(newer?{after:boundary}:{before}), limit: 50 }, signal);
        if (!valid()) return;
        rows.push(...page.messages); more = !!(newer?page.has_more:page.has_more_old);
        const next = page.oldest_cursor;
        if (!newer&&more && (!next || before !== undefined && next >= before)) throw Error('历史消息分页未推进');
        before = next;
      } while (!older && !newer && preserveUntil !== undefined && more && before !== undefined && before > preserveUntil);
      const ids=new Set(rows.map(row=>row.id));
      messages.value=mergeChatMessages([...messages.value,...rows]).filter(row=>older||newer||ids.has(row.id));
      if(newer)hasNewer.value=more;else{hasOlder.value=more;if(!older)hasNewer.value=false;}
    } catch (cause) { if(valid()){error.value=userError(cause);if([401,403].includes((cause as any)?.status)){messages.value=[];hasOlder.value=false;hasNewer.value=false;}} }
    finally { if (valid()) { loading.value = false; if(refreshPending){refreshPending=false;await fetchPage();} } }
  }
  async function restoreWindow(saved:ViewRange,outer?:AbortSignal){
    controller?.abort();const own=new AbortController();controller=own;const version=++generation,owner=account.value,conditions=JSON.parse(JSON.stringify(filter.value));refreshPending=false;loading.value=true;error.value='';
    const signal=outer?AbortSignal.any([outer,own.signal]):own.signal;
    const valid=()=>generation===version&&account.value===owner&&!signal.aborted;
    try{const result=await restoreViewWindow(communication,conditions,saved,signal);if(!valid())return;
      const ids=new Set(result.messages.map(m=>m.id));messages.value=mergeChatMessages([...messages.value,...result.messages]).filter(m=>ids.has(m.id));hasOlder.value=result.hasOlder;hasNewer.value=result.hasNewer;
    }catch(e){if(valid()){error.value=userError(e);if([401,403].includes((e as any)?.status)){messages.value=[];hasOlder.value=false;hasNewer.value=false;}}throw e;}
    finally{if(generation===version){loading.value=false;if(refreshPending){refreshPending=false;void fetchPage();}}}
  }
  watch([account, filter], () => {
    refreshPending=false;generation++; controller?.abort(); loading.value = false; messages.value = [];hasNewer.value=false; error.value = ''; hasOlder.value = false;
    void fetchPage(false, true);
  }, { deep: true, immediate: true });
  onScopeDispose(() => { generation++; controller?.abort(); });
  return { messages, loading, error, hasOlder,hasNewer,restoreWindow,active, refresh: (changed = false) => fetchPage(false,false,changed), older: () => fetchPage(true),newer:()=>fetchPage(false,false,false,true) };
}
