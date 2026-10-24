// src/api/types.ts —— 中枢共享服务端 V2 契约类型（严格对齐 03-代码文档/当前实现的真实响应形状）。
// 这些类型是客户端与服务端的稳定边界：字段名/枚举与后端 contract.mjs、routes-*.mjs、notify.mjs 一致，不臆造。

// ---------- 枚举（与后端 contract.mjs 单点一致） ----------
export type Scope = 'company' | 'personal';
export type IntakeKind = 'problem' | 'plan_idea';         // 仅 personal Issue 使用
export type IssueStatus = 'open' | 'resolved';
export type IssueSeverity = 'low' | 'mid' | 'high';
export type TaskMainState = 'incomplete' | 'paused' | 'cancelled' | 'completed';
export type TaskNode =
  | 'awaiting_plan_review' | 'awaiting_plan_revision' | 'awaiting_code'
  | 'awaiting_code_review' | 'awaiting_code_revision' | 'personal_open' | 'done' | 'cancelled';
export type TaskEntryType = 'plan_submission' | 'direct_code' | 'personal';   // 后端把 plan_approval 投影为 plan_submission
export type PlanStatus = 'pending_review' | 'changes_requested' | 'approved' | 'rejected' | 'cancelled';
export type CodeStatus = 'pending_review' | 'changes_requested' | 'approved' | 'rejected' | 'cancelled' | 'personal_completed';
export type DeliveryKind = 'code' | 'no_change';
export type RelationStatus = 'pending' | 'active' | 'replaced' | 'discarded';
export type ResolutionScope = 'partial' | 'complete';
export type ReviewDecision = 'approve' | 'request_changes' | 'reject' | 'cancel' | 'withdraw' | 'pause' | 'resume' | 'reassign' | 'complete';
export type NotificationKind =
  | 'review_pending' | 'review_result' | 'revision_required' | 'task_progress'
  | 'hub_update' | 'legacy_notice' | 'issue_progress' | 'issue_resolved' | 'issue_collab' | 'announcement' | 'device_alert' | 'chat_message' | 'announcement_reply';
export type NotificationPriority = 'normal' | 'urgent';
export type DevicePlatform = 'ios_web_push' | 'android_native';
export type DeviceStatus = 'active' | 'invalid' | 'unbound';
export type Visibility = 'company' | 'private';

// ---------- 身份 / 能力 ----------
export interface HufuLoginResult { token: string; refresh_token?: string; username: string; nickname?: string; dept?: string; role?: string; }
export interface IdentityUser { username: string; nickname: string; dept: string; role: string; }
export interface Bootstrap {
  ok: boolean;
  user: IdentityUser;
  is_main_control: boolean;
  counts: { my_company_tasks: number; my_personal_tasks: number; my_open_issues: number };
  note?: string;
}

// ---------- 业务对象投影 ----------
export interface Project {
  id: string; scope: Scope; name: string; direction: string; tier: string;
  parent_id: string | null; status: string; owner_username?: string; version: number;
  created_at: number; updated_at: number;
}
export interface Task {
  latest_worklog_id?: number | null;
  id: string; project_id: string; scope_at_creation: Scope; title: string;
  creator_username: string; assignee_username: string; entry_type: TaskEntryType;
  main_state: TaskMainState; current_node: TaskNode; current_action_owner: string;
  pause_reason: string; cancel_reason: string; version: number;
  created_at: number; updated_at: number; completed_at: number | null;
}
export interface Issue {
  latest_worklog_id?: number | null;
  id: string; title: string; detail: string; target: string; severity: IssueSeverity;
  status: IssueStatus; submitter_username: string; source_address: string; version: number;
  created_at: number; resolved_at: number | null;
  // personal 链补齐后由服务端返回（company Issue 恒为 company / 无 intake_kind）
  scope?: Scope; project_id?: string | null; intake_kind?: IntakeKind | ''; archived_at?: number | null;
}
export interface IssueSupplement { id: string; issue_id: string; submitter_username: string; content: string; source_address: string; created_at: number; }
export interface CodeVersion {
  id: string; task_id: string; version_no: number; address: string; integrity: string;
  delivery_kind: DeliveryKind; status: CodeStatus; note: string; submitter_username: string; created_at: number;
}
export interface Plan { id: string; submitter_username: string; title: string; status: PlanStatus; current_version: number; version: number; created_at: number; updated_at: number; }
export interface PlanVersion { id: string; plan_id: string; version_no: number; address: string; summary: string; submitter_username: string; created_at: number; }
export interface PlanItem { id: string; plan_id: string; title: string; proposed_project_id: string; proposed_assignee: string; approved_project_id: string; approved_assignee: string; task_id: string | null; created_at: number; }
export interface Review { id: string; object_type: 'plan' | 'code'; object_id: string; decision: ReviewDecision; reason: string; reviewer_username: string; object_version: number; created_at: number; }
export interface Activity {
  worklog_id?: number | null;
  id: string; visibility: Visibility; owner_username: string; project_id: string; task_id: string;
  object_type: string; object_id: string; action: string; summary: string; actor_username: string;
  source_address: string; idempotency_key: string; created_at: number;
}
export interface Artifact { id: string; title: string; addresses: string[]; withdrawn_at: number | null; withdrawn_reason: string; }
export interface IssueRelation {
  issue_id: string; task_id: string; relation_status: RelationStatus; resolution_scope: ResolutionScope; version: number;
  replacement_task_id?: string; replace_reason?: string; replaced_by?: string; replaced_at?: number | null; created_at?: number;
  issue?: Issue | null; task?: Task | null; task_state?: TaskMainState | ''; task_title?: string; task_assignee?: string;
}
export interface SourcePlanVersion { version_no: number; address: string; summary: string; submitter_username: string; created_at: number; }
export interface SourcePlan {
  plan_id: string; plan_title: string; plan_status: PlanStatus; item_id: string; item_title: string;
  plan_current_version: number | null; plan_submitter_username: string;
  versions: SourcePlanVersion[]; latest_address: string;
}
export interface CodeReviewView { id?: string; object_type?: 'plan' | 'code'; plan_id?: string; code_version_id?: string; version_no: number; decision: ReviewDecision; reason: string; reviewer: string; created_at: number; }
export type TaskHistoryPage = { kind: 'worklogs'; items: WorklogEntry[]; next_cursor: string | null } | { kind: 'activities'; items: Activity[]; next_cursor: string | null } | { kind: 'receipts'; items: (Receipt & { created_at: number })[]; next_cursor: string | null };

// ---------- Task 完整上下文（GET /me/tasks/:id） ----------
export interface WorklogEntry { id: number; action: string; ts: number; }
export interface TaskContext {
  related_worklogs?: WorklogEntry[];
  related_worklogs_next_cursor?: string | null;
  task: Task; project: Project | null; source_plan: SourcePlan | null;
  linked_issues: Issue[]; issue_relations: IssueRelation[]; code_versions: CodeVersion[];
  reviews: CodeReviewView[]; revision_required: CodeReviewView | null; latest_review: CodeReviewView | null;
  allowed_actions: string[]; code_version_actions: Record<string, string[]>; recent_activities: Activity[];
  artifact: Artifact | null;
}

// ---------- Issue 详情 ----------
export interface MeIssueDetail { issue: Issue; supplements: IssueSupplement[]; linked_tasks: Task[]; relations: IssueRelation[]; allowed_actions: string[]; handling_events?: HandlingEvent[]; }
export interface CompanyIssueDetail {
  issue: Issue; submitter: { username: string; nickname: string; dept: string };
  supplements: IssueSupplement[]; relations: IssueRelation[]; linked_tasks: Task[];
  linked_plans: { id: string; title: string; status: PlanStatus; current_version: number; submitter_username: string }[];
  recent_activities: Activity[]; allowed_actions: string[]; handling_events?: HandlingEvent[];
}
export interface HandlingEvent { id: string; issue_id: string; actor_username: string; resolution_scope: ResolutionScope; note: string; activity_id: string; receipt_id: string; created_at: number; }

// ---------- 通知域 ----------
export interface Notification {
  worklog_id?: number | null;
  id: string; kind: NotificationKind; object_type: string; object_id: string;
  title: string; summary: string; deep_link: string; priority: NotificationPriority;
  actor_username: string; actor_nickname?: string; snapshot: Record<string, unknown>;
  version: number; update_version: number; change_seq: number;
  read_at: number | null; acked_at: number | null; hidden_at: number | null; pinned_at: number | null;
  snooze_until: number | null; last_urged_at: number | null; expires_at: number | null;
  created_at: number; updated_at: number; persistent_float: boolean;
}
export interface MessageBadgeSnapshot {count:number;version:number;computed_at:number}
export interface NotificationPage { message_badge?:MessageBadgeSnapshot; notifications: Notification[]; next_cursor: string; has_more: boolean; sync_version: number | null; unread_count: number; }
export interface DeviceInfo { installation_id: string; platform: DevicePlatform; status: DeviceStatus; last_auth_sync_at: number; created_at: number; updated_at: number; }
export interface AnnouncementAudienceMember {
  username: string;
  name?: string;
  read_at: number | null;
  online?: boolean;
  last_seen_at?: number | string | null;
}
export interface Announcement {
  id: string; title: string; priority: NotificationPriority; body: string;
  publisher_username: string; publisher_name?: string; expires_at: number | null; created_at: number;
  notification_id: string | null; read_at: number | null; acked_at: number | null;
  recipient_count?: number; read_count?: number; unread_count?: number;
  audience?: AnnouncementAudienceMember[];
}

// ---------- 写回执 ----------
export interface Receipt { message_badge?:MessageBadgeSnapshot;
  ok: boolean; receipt_id: string; object_type: string; object_id: string; object_version: number;
  status: string; activity_ids: string[]; review_ids: string[]; created_task_ids: string[]; dedup?: boolean;
  [k: string]: unknown;
}

// ---------- 错误 ----------
export type ErrorCode =
  | 'unauthenticated' | 'forbidden_scope' | 'role_not_allowed' | 'not_found' | 'invalid_transition'
  | 'project_required' | 'project_scope_mismatch' | 'assignee_not_found' | 'assignee_role_invalid'
  | 'source_unverified' | 'upstream_unavailable' | 'version_conflict' | 'idempotency_conflict' | 'validation_failed'
  | 'invalid_issue_task_replacement' | 'replacement_task_required'
  | 'provider_unavailable' | 'device_invalid' | 'device_limit_exceeded' | 'network' | 'session_recovering' | 'unknown';

// ---------- 主控审核队列 ----------
export interface ControlQueues { queues: { plans: number; code: number } }
export interface ControlPlanDetail { plan: Plan; versions: PlanVersion[]; items: (PlanItem & { task: Task | null; issue_relations: IssueRelation[] })[]; issues: Issue[]; reviews: Review[]; allowed_actions: string[] }
export interface AssigneeOption { avatar_version?: string | null; username: string; nickname: string; dept: string; role: string; online?: boolean; last_seen_at?: number | string | null; last_auth_sync_at?: number | string | null }

// 已核对生产 /personal-projects/:id/storage-context；路径与文件版本均由服务端返回。
export interface PersonalStorageContext {
  project_id: string; space: 'personal'; path: string; directory: string;
  status: 'synced' | 'pending' | 'failed'; pending: number; failed: number; synced: number;
  last_error: string | null;
  files: Array<{ kind: string; path: string; file_id: string; ver: number; address: string;
    source?: { file_id: string; ver: number; sha256: string; size: number; space: string; path: string } }>;
}
export interface PersonalStorageFile {
  file_id: string; path: string; ver: number; sha256: string; size: number;
  kind: string; address: string; removed_at?: number | null;
  source?: { file_id: string; ver: number; sha256: string; size: number; space: string; path: string };
}
export interface PersonalStorageDiscovery {
  state: 'unavailable' | 'synced' | 'syncing' | 'failed';
  projects: Array<{ project_id: string; status?: string; files?: number; state?: string; cursor?: string; watermark?: string; last_error?: string }>;
}

// 公司沟通：消息归 V8，附件原件归资料存储服务。
export interface ChatAttachment {
 record_attachment_ids?:string[]; id: string; name: string; size: number; mime: string; file_id: string; ver: number; sha256: string; address: string; purpose?: import('@/chat/mediaKind').ChatMediaPurpose; duration_ms?: number; }
export interface ChatContext { short_no?: number; project_id: string; project_title: string; work_item_id: string | null; work_title: string | null; }
export interface ChatFilter { kind?: 'media' | 'files' | 'links' | 'voice'; author?:string; peer?:string; created_from?: number; created_until?: number; project_id?: string; work_item_id?: string; related?: 'mentions' | 'replies'; q?: string; }
export interface ChatMessage {
  project_id?: string | null; work_item_id?: string | null; context?: ChatContext | null;
  conversation_peer?: string; id: string; seq: number; body: string; author_username: string; author_name: string;
  change_version?: number; recall_deadline_at?: number; hidden?: boolean; recalled?: boolean; allowed_actions?: Array<'hide' | 'recall'>;
  mention_usernames: string[]; reply_to: Pick<ChatMessage, 'id' | 'body' | 'author_username' | 'author_name' | 'hidden' | 'recalled' | 'change_version' | 'context' | 'project_id' | 'work_item_id'> & { attachments?: ChatAttachment[] } | null;
  attachments: ChatAttachment[]; created_at: number;
}
export interface ChatMessagePage { sync_cursor?: number; messages: ChatMessage[]; next_cursor: number; has_more: boolean; has_more_old?: boolean; oldest_cursor?: number; }
export interface AnnouncementReply { id: string; seq: number; body: string; author_username: string; author_name: string; created_at: number; }
export interface ChatSendBody { record_attachment_ids?:string[]; recipient_username?: string; project_id?: string | null; work_item_id?: string | null; body: string; mention_usernames: string[]; reply_to_id?: string; attachment_ids: string[]; }

export interface ChatChangePage { changes: Array<{ change_seq: number; message: ChatMessage }>; next_change_cursor: number; has_more: boolean; }

