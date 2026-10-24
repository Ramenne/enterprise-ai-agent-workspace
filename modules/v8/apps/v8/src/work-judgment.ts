import {knowledgeWorkflow} from './knowledge-followup.js';
/** Work identity is an Agent judgment; append events and directed citations are separate facts. */
type ObjectValue = Record<string, unknown>;
const object = (v: unknown): v is ObjectValue => !!v && typeof v === 'object' && !Array.isArray(v);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const decisions = ['continuation', 'new_work', 'undetermined', 'correction'];
export const workJudgmentPolicy = {
  "version": "v8-work-identity-v3",
  "updated_at": "2026-10-22",
  "purpose": "以具体可交付目标组织工作，独立判断延续、新建、直接引用和固定资料采用；避免项目级无限归并与步骤级碎片化。",
  "unit": "一个工作对应一个具体用户行为闭环的一次明确交付：说明触发情境、用户动作、预期结果、本次覆盖范围和完成证据。研究、写作等工作以具体交付结果及其使用目的表达闭环。研究、实现、修复、测试、发布和交接可以是同一次交付的内部步骤。",
  "continuation": "仍在达到本次约定的同一结果时沿用原编号，包括必要取材、实现、修订、缺陷修复、重试和发布。对照原目标而非仅最近阶段摘要；完成后的优化或维护按lifecycle另判，不因同一用户最终目的就无限沿用。",
  "new_work": "新增用户用途，或同一闭环新增一项值得独立安排、交付和验收的明确能力或效果，可以新建；明确本次新增效果与完成条件。不是原结果的必要步骤，不因同项目、工作未完成或旧成果被采用而自动沿用。",
  "granularity": {
    "avoid_too_broad": "若沿用需要把目标不断扩成整个项目的长期愿景，范围过宽，应判断新的独立交付。",
    "avoid_too_fine": "若新工作只能解释为原目标中的一个步骤、一次提交或一个小问题，范围过细，应继续原工作。",
    "checks": [
      "本次用户行为闭环或具体交付结果是什么，覆盖到哪里？",
      "本次约定的完成条件和可用证据是什么？",
      "仍是原交付的必要步骤，还是新增用途、能力或明确效果？",
      "沿用是否无限扩大原目标，新建是否只是切出内部动作？"
    ],
    "not_boundaries": [
      "对话",
      "话题",
      "文件",
      "天数",
      "代码提交",
      "发布次数",
      "预设阶段"
    ],
    "reassessment": "建立、实质范围变化、结束或纠正时轻量判断相关部分；普通步骤不重复整套流程。已投入很多内容不是继续错误归属的理由。",
    "decision_owner": "Agent_or_member",
    "automatic_scoring": false,
    "initial_scope": "先明确触发情境、用户动作、结果、覆盖范围与证据，不能用“全面优化产品”作为无边界任务。",
    "internal_steps": "同一闭环的模块、接口、平台适配和必要验证默认是内部步骤；不按参与者数量、代码量或工期拆号。",
    "small_improvements": "按同一用户场景、同一次明确交付合并小优化，不一个按钮一个号，也不跨场景无限收集。",
    "candidate_only": "只有“还能更好”而没有具体预期效果时先留优化候选；资料保存、普通讨论不自动建立进行中任务。"
  },
  "relations": "工作边界和引用分开判断。实际直接采用、延续、修正、回应或实质影响才写related/properties.relations及具体依据；同项目、同编号、同主题、仅查阅、可能将来兼容均不构成关联。引用旧成果不要求沿用旧编号；新建也不自动引用全部历史。",
  "material_evidence": "basis.explanation说明实际用了什么、用于哪一步；basis.refs采用可用固定版本。缺失依据标待补，不能声称已经判定。资料真实派生沿资料存储服务来源/加工链，不用虚假加工代替关系。",
  "adoption": "资料采用指向固定版本并记录用途与依据；上传、保存、检索或阅读不等于实际采用。新版本不自动替换旧采用；工作引用和资料采用分别按真实使用登记。",
  "judgment_field": "properties.work_judgment",
  "judgment_shape": {
    "decision": [
      "continuation",
      "new_work",
      "undetermined",
      "correction"
    ],
    "reason": "简短说明具体结果与比较依据，不要求机械打分或额外填表",
    "compared_work_ids": "实际读过的候选工作，不自动形成关系"
  },
  "examples": [
    {
      "scenario": "同一文章的取材、初稿、修改和交付",
      "decision": "continuation",
      "reason": "仍交付同一篇文章"
    },
    {
      "scenario": "原接入后出现独立通知链架构重构及后台收件交付",
      "decision": "new_work",
      "reason": "有独立结果与验收；实际采用旧基线时另写引用"
    },
    {
      "scenario": "为原目标修复一个错误或重复上线迭代",
      "decision": "continuation",
      "reason": "未形成另一独立目标"
    },
    {
      "scenario": "仅查看同主题工作但没有直接采用",
      "relation": "not_established",
      "reason": "主题或阅读不是引用证据"
    },
    {
      "scenario": "文件传输助手已满足跨端查看下载，后续增加大文件断点续传",
      "decision": "new_work",
      "reason": "同一用户目的下的新增能力，有新的验收条件；原任务保持完成，实际沿用基线另登记关联。"
    },
    {
      "scenario": "交付时承诺可下载，立即验收却失败",
      "decision": "continuation",
      "reason": "原承诺尚未达到，纠正完成判断继续原号。"
    },
    {
      "scenario": "同次聊天输入区体验交付包含间距、高度、文案调整",
      "decision": "continuation",
      "reason": "共同完成同一场景的一次交付，不按按钮或文件碎拆。"
    },
    {
      "scenario": "开发完成，但约定的用户验收尚未完成",
      "state": "in_progress",
      "reason": "分开记录开发完成与验收待完成，不混称整体已完成。"
    }
  ],
  "incomplete": "缺判断可以保存但明确undetermined；缺关系依据可待补，不把目录可见、结构校验或保存成功当作已完成语义判断。",
  "correction": "归属错误保留原编号、原件与阶段历史，追加纠正；必要时新建并引用既有成果，后续沿新目标记录。不静默搬迁、重编号、批量重判历史，也不为新建把旧工作虚报完成。",
  "compatibility": "保留continuation/new_work/undetermined/correction、reason、compared_work_ids、既有关系/采用接口及open/in_progress/completed/cancelled状态；不新增必填字段、机械打分或自动状态转换，不改变权限、编号、幂等、CAS与历史记录。v3补充语义判断指引，不是模型训练或语义正确性保证。",
  "authority": "Agent_or_member_semantic_judgment;structural_consistency_checks_only;not_proof_of_semantic_correctness",
  "lifecycle": {
    "state_semantics": "编号表示工作身份，状态表示生命周期，关联表示实际采用；三者独立判断。沿用现有状态值，不增加自动迁移。",
    "states": {
      "open": "目标明确但尚未开始。",
      "in_progress": "实际推进，或约定的必要交付/验收仍未完成；等待时说明卡点及恢复条件。",
      "completed": "本次约定范围和完成条件达到，并有相称证据。",
      "cancelled": "明确决定不再实施，保留原因和已有成果；受阻、等待或暂停不等于取消。"
    },
    "completion_boundary": "完成条件以当时约定的交付为准，不因后来新增优化无限上调，也不得为结束而删减原承诺。行为交付不凭按钮、源码或构建成功代替闭环验证；仅源码交付不强加未约定上线。无需证明整个产品再无缺陷。",
    "acceptance": "Agent按约定条件与证据判断完成，不默认都等待用户确认。若明确约定用户验收且尚未完成，分别记录开发完成和验收待完成；必要验收未完成时整体仍为in_progress。一次完成可直接登记completed。",
    "early_defect": "刚交付即发现原承诺未达到，通常纠正完成判断并继续原编号，保留历史与纠正依据。",
    "later_maintenance": "交付使用后发现且需独立安排的维护修复，可新建关联任务并说明旧交付受到的影响；不能掩盖旧缺陷。时间长短不自动决定拆号或重开，仍比较原承诺与当前修复的交付边界。",
    "optimization": "原闭环完成后，新增能力或明确性能/体验提升，可新建优化任务，原任务保持完成；以新增效果及验收条件说明边界，不只凭大小标签。实际采用旧成果时独立登记关联。",
    "history": "结束不删除成果、来源或关联；保留原完成事实和后续纠正，不静默重编号、搬迁或批量重判。"
  }
,
  "knowledge_cycle": knowledgeWorkflow
};

export class WorkJudgmentError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.code = code; }
}
function explanation(v: unknown): boolean {
  if (typeof v === 'string') return v.trim().length > 0;
  if (Array.isArray(v)) return v.some(explanation);
  return object(v) && Object.values(v).some(explanation);
}
/** No creation, goal matching, automatic links or extra authority is inferred here. */
export function assessWorkJudgment(body: ObjectValue): ObjectValue {
  const props = object(body['properties']) ? body['properties'] : {};
  const input = props['work_judgment'];
  if (input !== undefined && !object(input)) throw new WorkJudgmentError('invalid_work_judgment');
  const declared = object(input) ? input : {};
  const decision = declared['decision'] ?? 'undetermined';
  if (typeof decision !== 'string' || !decisions.includes(decision)) throw new WorkJudgmentError('invalid_work_judgment_decision');
  const reason = declared['reason'] ?? null;
  if (reason !== null && (typeof reason !== 'string' || reason.length > 4000)) throw new WorkJudgmentError('invalid_work_judgment_reason');
  const compared = declared['compared_work_ids'] ?? [];
  if (!Array.isArray(compared) || compared.length > 50 || compared.some(id => typeof id !== 'string' || !uuid.test(id)))
    throw new WorkJudgmentError('invalid_compared_work_ids');
  const workId = body['work_item_id'];
  if (decision === 'new_work' && typeof workId === 'string' && compared.includes(workId))
    throw new WorkJudgmentError('new_work_target_is_existing_candidate');
  const warnings: string[] = [];
  let assessed = decision;
  if (decision !== 'undetermined' && !explanation(reason)) {
    warnings.push('work_judgment_reason_missing'); assessed = 'undetermined';
  }
  if (['continuation', 'correction'].includes(String(decision)) && !workId) {
    warnings.push('existing_work_required_for_declared_decision'); assessed = 'undetermined';
  }
  if (input === undefined) warnings.push('work_boundary_not_assessed');
  const links = Array.isArray(body['related']) ? body['related'] : [];
  let incompleteLinks = false;
  for (const link of links) {
    if (!object(link)) continue; // Existing relation schema owns malformed input validation.
    if (workId && link['work_item_id'] === workId) throw new WorkJudgmentError('self_relation_not_allowed');
    if (link['state'] === 'withdrawn') continue;
    if (!object(link['basis']) || !explanation(link['basis']['explanation'])) incompleteLinks = true;
  }
  if (incompleteLinks) warnings.push('relationship_basis_pending');
  return {
    policy_version: workJudgmentPolicy.version, decision: assessed,
    ...(assessed !== decision ? { declared_decision: decision } : {}),
    reason, compared_work_ids: compared, warnings,
    relationship_basis_status: incompleteLinks ? 'pending' : links.length ? 'declared_basis_present' : 'no_relationship_submitted',
  };
}
/** Validate only; keep exact submitted bytes/semantics for existing idempotency hashes. */
export function normalizeWorkJudgment(body: ObjectValue): ObjectValue {
  assessWorkJudgment(body);
  return body;
}

function currentJudgment(result: ObjectValue): ObjectValue | null {
  const work = result['work_item'];
  if (!object(work) || !Array.isArray(result['updates'])) return null;
  const current = result['updates'].find(u => object(u) && u['work_revision'] === work['revision']);
  if (!object(current) || !object(current['statement']) || !object(current['statement']['properties'])) return null;
  const value = current['statement']['properties']['work_judgment'];
  if(!object(value))return null;
  try{return assessWorkJudgment({...current['statement'],work_item_id:current['statement']['work_item_id']??work['id']});}
  catch{return {policy_version:workJudgmentPolicy.version,decision:'undetermined',reason:null,warnings:['historical_judgment_requires_review']};}
}
export function attachWorkJudgment(result: ObjectValue, name: string, input?: ObjectValue, expanded?:ObjectValue): ObjectValue {
  if (!['work_open','work_save','work_commit','work_read','work_search','work_history'].includes(name)) return result;
  const judgment = ['work_save','work_commit'].includes(name) && input ? assessWorkJudgment(input) : currentJudgment(expanded??result);
  const saved = ['saved','committed'].includes(String(result['state']));
  const out: ObjectValue = { ...result, work_judgment: {
    ...(judgment ?? { policy_version:workJudgmentPolicy.version, decision:'undetermined', reason:null }),
    evidence: ['work_save','work_commit'].includes(name) ? saved ? 'saved_stage_input' : 'not_confirmed_saved' : judgment ? 'current_authorized_stage' : 'not_returned_use_work_read_or_assess',
    relationship_semantics: 'independent_direct_ledger;appending_is_not_a_relation',
    help_path:'/v2/work-items/judgment-policy',
    ...(expanded&&object(expanded['judgment_projection'])?{reason_truncated:expanded['judgment_projection']['reason_truncated'],source_statement_id:expanded['judgment_projection']['statement_id'],source_statement_sha256:expanded['judgment_projection']['statement_sha256'],source_work_revision:expanded['judgment_projection']['work_revision'],expansion:{path:'/v2/statements/read-chunk',arguments:{project_id:object(result['work_item'])?result['work_item']['project_id']:null,kind:'work_update',statement_id:expanded['judgment_projection']['statement_id']}}}:{}),
  } };
  // A continuation consumer that selects work_item still receives the same policy/state.
  if (object(result['work_item'])) {
    const props = object(result['work_item']['properties']) ? result['work_item']['properties'] : {};
    out['work_item'] = { ...result['work_item'], properties: { ...props, work_judgment: out['work_judgment'] } };
  }
  return out;
}
