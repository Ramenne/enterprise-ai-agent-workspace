/** Phase handoff for the current Agent; no extra reads, model calls or knowledge ledger. */
type Value = Record<string, unknown>;
const object = (v: unknown): v is Value => !!v && typeof v === 'object' && !Array.isArray(v);
export const knowledgeWorkflow = {
  version: 'v8-phase-knowledge-v2',
  default_behavior: '当前Agent默认按实质阶段回顾与复用，不等待用户专门要求；不是每消息或每次纠正入库。',
  entrypoint: {tool: 'tools.library', arguments: {action: 'help'}},
  skill_discovery: {tool: 'tools.library', arguments: {action: 'call', operation: 'skill_list', arguments: {query: 'context-to-knowledge'}}},
  skill_read: {tool: 'tools.library', arguments: {action: 'call', operation: 'skill_read', arguments: {id: '488e337c-d0b2-4e19-a51b-dadebbb85eb3'}}},
  source_scope: {
    mode: 'resume_existing_cross_dialogue_checkpoint',
    skill_reference: 'references/incremental.md',
    rule: '恢复现有阶段相关来源清单、取材/阅读/理解边界及云端知识映射；当前对话只是来源之一。已理解未变化来源复用，只补增量、未完成分析和必要上下文；缺口保留partial，不重建采集入口。',
  },
  steps: [
    '开始或接续时按当前问题knowledge_search，knowledge_read后判断采用；有关联Skill时再读对应正文。',
    '阶段内沿获准的相关对话跟踪问题/情绪反馈、情境、尝试和后续结果；情绪不直接当根因，不逐条纠正即改知识。',
    '实质里程碑、交接或完成时，整体回顾问题—处理—反馈；判断复用、更新、新增、继续观察或零新增。',
    '正文与版本统一走tools.library的knowledge_save/read；先查同源旧条目，更新带revision，重试保原idempotency_key。',
    '优先合入同一阶段保存；已有reviewed_no_new或persisted声明时不重复回顾，待观察保留下一边界。'
  ],
  stage_marker: '可由Agent在properties.knowledge_review记录phase、phase_complete、status；ready/observing/reviewed_no_new/persisted为声明，不是系统验真或新增必填字段。',
  storage: '现有工具库为唯一知识正文/版本/检索入口；原SQL取材、暂存与索引保留在底层，不当第二知识入口；V8只保留来源和关系。',
  optional_legacy: 'experience及治理队列按实际跨次反馈/补漏需要使用，不每条知识重复登记或强制认领；不因知识需要另造工作号。',
  execution: '当前Agent读取Skill、判断并执行；此响应不会运行模型、轮询或抓取全部对话。权限和禁止留存范围始终生效。',
};
export function attachKnowledgeFollowup(result: Value, name: string, input: Value): Value {
  if (!['work_save', 'work_commit'].includes(name) || !['saved', 'committed'].includes(String(result['state']))) return result;
  const props = object(input['properties']) ? input['properties'] : {};
  const review = object(props['knowledge_review']) ? props['knowledge_review'] : {};
  // These are caller declarations, not proof of correctness or a security boundary.
  if (['persisted', 'reviewed_no_new'].includes(String(review['status']))) return result;
  const completed = result['completion_applied'] === true && result['work_state'] === 'completed';
  const phase = review['phase_complete'] === true;
  if (!completed && !phase) return result;
  const work = object(result['work_item']) ? result['work_item'] : {};
  const workId = result['work_item_id'] ?? work['id'];
  if (typeof input['project_id'] !== 'string' || typeof workId !== 'string') return result;
  return {...result, knowledge_followup: {
    schema: 'v8.phase-knowledge-followup.v1', state: 'phase_review_ready',
    reason: phase ? 'agent_declared_phase_boundary' : 'applied_work_completion',
    source: {project_id: input['project_id'], work_item_id: workId,
      stage_update_id: result['update_id'] ?? null,
      phase: typeof review['phase'] === 'string' ? review['phase'].slice(0, 240) : null},
    workflow: knowledgeWorkflow,
    coverage: 'authorized_saved_stage_metadata_only;resume_existing_cross_dialogue_checkpoint;unknown_scope_remains_partial;not_full_dialogue_capture',
    outcome: 'Agent may persist, update, keep observing, or produce no new knowledge; storage success is not semantic validation',
  }};
}
