import {searchSchemas,searchLimits} from './search-contracts.mjs';
import {infrastructureFailure} from '../../../packages/platform/src/failure-contract.mjs';
/** One ordinary query, ordered fallbacks, same-caller authorization at every stage. */
const normalize = value => String(value ?? '').normalize('NFKC').toLowerCase().trim();
const basename = path => String(path ?? '').split('/').at(-1);
const isDenied = e => infrastructureFailure(e)?.code === 'forbidden' || e?.code === 'forbidden' || e?.status === 403;
const fixed = item => Object.fromEntries(['material_id','version_id','sha256'].map(k => [k,item.fixed_ref?.[k] ?? item[k]]));
export function contains(actual, expected) {
  if (Array.isArray(expected)) return Array.isArray(actual) && expected.every(v => actual.some(a => contains(a,v)));
  if (expected && typeof expected === 'object') return actual && typeof actual === 'object' && Object.entries(expected).every(([k,v]) => contains(actual[k],v));
  return Object.is(actual,expected);
}
export function terms(text) {
  const out = new Set();
  for (const run of normalize(text).match(/\p{Script=Han}+|[\p{Letter}\p{Number}]+/gu) ?? []) {
    if (/^\p{Script=Han}+$/u.test(run)) {
      const a=[...run]; for(let i=0;i+1<a.length;i++) out.add(a[i]+a[i+1]);
    } else if(run.length>1) out.add(run);
  }
  return [...out];
}
/** Lucene-style BM25 length normalization plus standard weighted reciprocal-rank fusion. */
export function rankCandidates(items, query) {
  const q=terms(query); const texts=items.map(i=>terms((i.logical_path??'')+' '+(i.description?.text??'')));
  const average=texts.reduce((n,a)=>n+a.length,0)/Math.max(texts.length,1)||1;
  const df=new Map(q.map(t=>[t,texts.filter(a=>a.includes(t)).length]));
  const lexical=items.map((item,index)=>{
    const title=normalize(basename(item.logical_path)); const body=new Set(texts[index]);
    const score=q.reduce((n,t)=>{
      if(!body.has(t))return n;const tf=title.includes(t)?2:1;
      const idf=Math.log(1+(items.length-(df.get(t)??0)+0.5)/((df.get(t)??0)+0.5));
      return n+idf*(tf*2.2)/(tf+1.2*(0.25+0.75*texts[index].length/average));
    },0);
    return {index,score};
  }).sort((a,b)=>b.score-a.score||a.index-b.index);
  const lexicalRank=new Map(lexical.filter(x=>x.score>0).map((x,i)=>[x.index,i+1]));
  return items.map((item,index)=>{
    const lr=lexicalRank.get(index);const sr=item.semantic_rank;
    const score=(sr?2/(60+sr):0)+(lr?1/(60+lr):0);
    return {...item,ranking:{score,semantic_rank:sr??null,lexical_rank:lr??null,rank_constant:60,weights:{semantic:2,lexical:1},recipe:'weighted-rrf-bm25-v1'}};
  }).sort((a,b)=>b.ranking.score-a.ranking.score||(b.similarity??-1)-(a.similarity??-1)||String(a.material_id).localeCompare(String(b.material_id)));
}
export{semanticBroker}from'./semantic-transport.mjs';
export function createStagedSearch({call,semantic,findNumber}) {
  return async (token,source,input)=>{
    const {project_id}=input; const query=input.query??input.name??'';
    const properties=input.properties??{};const bound=Math.min(input.candidate_limit??50,100);
    const limit=input.limit??10;const trail=[];const cache=new Map();
    async function enrich(raw,semanticRank,allowHistorical=false) {
      const ref=fixed(raw);if(!ref.material_id||!ref.version_id||!ref.sha256)return null;
      const key=ref.material_id+':'+ref.version_id; if(cache.has(key))return {...cache.get(key),...(raw.description?{description:raw.description}:{}),...(semanticRank?{semantic_rank:semanticRank,similarity:raw.similarity}: {})};
      let head;
      try{head=await call(token,source,'material_head','mem.read',{project_id,material_id:ref.material_id});}
      catch(e){if(isDenied(e))return null;throw e;}
      // A candidate that moved or changed head is never silently rebound to new bytes.
      if((!allowHistorical&&(head.fixed_ref?.version_id!==ref.version_id||head.fixed_ref?.sha256!==ref.sha256))||!contains(head.properties??{},properties))return null;
      const placements=head.placements??[];const path=placements[0]?.logical_path??raw.logical_path;
      let created_at=null;
      if(input.version_created_after||input.version_created_before){
        const history=await call(token,source,'material_history','mem.read',{project_id,material_id:ref.material_id,limit:100});
        created_at=history.items?.find(x=>x.version_id===ref.version_id)?.created_at??null;
        if(!created_at||(input.version_created_after&&Date.parse(created_at)<Date.parse(input.version_created_after))||(input.version_created_before&&Date.parse(created_at)>Date.parse(input.version_created_before)))return null;
      }
      let description=raw.description;
      // Attribute stages do not read descriptions or invoke the vector model.
      description??=null;
      if(description?.text?.length>2048)description={...description,text:description.text.slice(0,2048),text_coverage:'search_preview_truncated'};
      const out={...ref,fixed_ref:{...(allowHistorical?raw.fixed_ref??raw:head.fixed_ref),...ref,project_id},logical_path:path,properties:head.properties??{},description,version_created_at:created_at,...(semanticRank?{semantic_rank:semanticRank,similarity:raw.similarity}:{})};
      cache.set(key,out);return out;
    }
    async function enrichAll(items) {
      const out=[];for(let i=0;i<items.length;i+=5){const rows=await Promise.all(items.slice(i,i+5).map((x,j)=>enrich(x,x.semantic_rank)));out.push(...rows.filter(Boolean));}return out;
    }
    async function revalidate(items,allowHistorical=false) {
      const final=[];
      for(const item of items){
        if(final.length>=limit)break;
        try{
          const head=await call(token,source,'material_head','mem.read',{project_id,material_id:item.material_id});
          if((allowHistorical||(head.fixed_ref?.version_id===item.version_id&&head.fixed_ref?.sha256===item.sha256))&&contains(head.properties??{},properties)){
            final.push({...item,properties:head.properties??{},logical_path:head.placements?.[0]?.logical_path??item.logical_path});
          }
        }catch(e){if(!isDenied(e))throw e;}
      }
      return final;
    }
    const finish=(items,stage,resolution,extra={})=>({state:'searched',resolution,located_by:resolution==='located'?stage:null,items:items.slice(0,limit),returned_count:Math.min(items.length,limit),stages:trail,coverage:{scope:'current_authorized_current_heads',candidate_limit:bound,complete:false,semantics:'bounded_search_not_full_enumeration',body_read:false},...extra});
    if(input.number){
      const r=await findNumber(token,source,input.number);let items=[];
      if(r.fixed_ref&&r.fixed_ref.project_id===project_id){const row=await enrich(r.fixed_ref,undefined,true);if(row)items=[row];}
      trail.push({stage:'fixed_attributes',state:items.length?'located':'not_found',candidate_count:items.length,proof:items.length?'explicit_stable_number':null});
      // Never substitute a fuzzy result for an explicit stable identity.
      items=await revalidate(items,true);return finish(items,'fixed_attributes',items.length?'located':'not_found');
    }
    const fixedResult=query?await call(token,source,'search_materials','mem.read',{project_id,query,properties,limit:bound,token_text:terms(query).join(' ')}):{items:[]};
    let fixedItems=await enrichAll(fixedResult.items??[]);
    const exactName=input.name??query;
    const exact=fixedItems.filter(x=>normalize(x.logical_path)===normalize(exactName)||normalize(basename(x.logical_path))===normalize(exactName));
    const uniqueExact=exact.length===1&&(fixedResult.items?.length??0)<bound;
    trail.push({stage:'fixed_attributes',state:uniqueExact?'located':fixedItems.length?'ambiguous':'not_found',candidate_count:fixedItems.length,proof:uniqueExact?'unique_exact_name_in_bounded_nontruncated_result':null});
    if(uniqueExact){const final=await revalidate(exact);return finish(final,'fixed_attributes',final.length?'located':'not_found');}
    let attributeItems=[];
    if(Object.keys(properties).length){
      const r=await call(token,source,'search_materials','mem.read',{project_id,properties,limit:bound,token_text:''});
      attributeItems=await enrichAll(r.items??[]);
      // Pure explicit constraints can locate uniquely; a free-text question still needs semantic discrimination.
      const unique=attributeItems.length===1&&!query&&(r.items?.length??0)<bound;
      trail.push({stage:'extended_attributes',state:unique?'located':attributeItems.length?'ambiguous':'not_found',candidate_count:attributeItems.length,proof:unique?'unique_explicit_attribute_constraints':null});
      if(unique){const final=await revalidate(attributeItems);return finish(final,'extended_attributes',final.length?'located':'not_found');}
    }else trail.push({stage:'extended_attributes',state:'skipped_no_constraints',candidate_count:0});
    if(!query){const final=await revalidate(attributeItems);return finish(final,'extended_attributes',final.length?'needs_selection':'not_found');}
    if(input.semantic===false){
      trail.push({stage:'description_vector',state:'disabled_by_caller',candidate_count:0});
      const union=new Map();for(const item of [...fixedItems,...attributeItems])union.set(item.material_id+':'+item.version_id,item);
      const lexical=rankCandidates([...union.values()],query).map(item=>({...item,match:{mode:'lexical',basis:'authorized_metadata_or_text_index'}}));
      const final=await revalidate(lexical);
      return finish(final,'fixed_attributes',final.length?'needs_selection':'not_found',{semantic_state:'disabled_by_caller',ranking_recipe:'bm25_lexical_only',next_step:'refine_metadata_conditions_or_explicitly_enable_semantic;bounded_search_not_full_enumeration'});
    }
    const semanticResult=await semantic(token,source,{project_id,text:query,top_k:bound,mode:'exact',include_historical:false});
    const raw=semanticResult.receipt?.items??[];
    const semanticItems=await enrichAll(raw.map((x,i)=>({...x,semantic_rank:i+1})));
    trail.push({stage:'description_vector',state:semanticResult.state==='queried_candidates'?'searched':'unavailable',candidate_count:semanticItems.length,...(semanticResult.error_code?{error_code:semanticResult.error_code}:{})});
    const union=new Map();for(const item of [...fixedItems,...attributeItems,...semanticItems]){const k=item.material_id+':'+item.version_id;union.set(k,{...union.get(k),...item});}
    const exactIds=new Set(exact.map(x=>x.material_id));
    const ordered=rankCandidates([...union.values()],query).sort((a,b)=>Number(exactIds.has(b.material_id))-Number(exactIds.has(a.material_id))||b.ranking.score-a.ranking.score);
    // The SQL guard is re-run just before delivery; no cached permission outcome is accepted.
    const final=await revalidate(ordered);
    return finish(final,'description_vector',final.length?'needs_selection':'not_found',{ranking_recipe:'weighted-rrf-bm25-v1',semantic_state:semanticResult.state});
  };
}
export function registerStagedSearch(app,{z,bearer,sourceFromRequest,DomainError,call,semantic,findNumber}) {
  app.get('/v2/materials/search-help',async()=>({version:'staged-search-v2',ordinary_tool:'mem.search',ordinary_path:'/v2/materials/search',advanced_path:'/v2/materials/retrieve',order:['fixed_attributes','extended_attributes','description_vector'],stop:'explicit_number_or_unique_exact_name_or_unique_explicit_properties_without_free_text;otherwise_continue_or_return_needs_selection',required:['project_id'],optional:['query','name','number','properties','limit','candidate_limit','version_created_after','version_created_before','semantic'],properties_example:{attributes:{material_kind:'系统使用说明'}},time_semantics:'current_or_explicit_fixed_version_created_at;hard_inclusive_filter_at_all_stages',limits:searchLimits,ranking:'weighted-rrf-bm25-v1;BM25_k1=1.2_b=0.75_title_boost=2;RRF_c=60_semantic_weight=2_lexical_weight=1;not_a_neural_reranker',coverage:'bounded_candidates;not_full_enumeration;no_original_bodies',description_policy:'/v2/materials/description-policy'}));
  const {ordinary,advanced}=searchSchemas;
  const search=createStagedSearch({call,semantic,findNumber});
  for(const [path,schema] of [['/v2/materials/search',ordinary],['/v2/materials/retrieve',advanced]])app.post(path,async request=>{
    const parsed=schema.safeParse(request.body);if(!parsed.success)throw new DomainError('invalid_input');
    // Compatibility: list/filter-only calls retain the original bounded metadata behaviour.
    if(path.endsWith('/search')&&!parsed.data.query)return call(bearer(request),sourceFromRequest(request),'search_materials','mem.read',{...parsed.data,token_text:''});
    const input=parsed.data;
    if(input.query&&/^(?:F-[0-9]+(?:-[0-9]+)?|#?[0-9]+)$/.test(input.query))input.number=input.query;
    return search(bearer(request),sourceFromRequest(request),input);
  });
}
