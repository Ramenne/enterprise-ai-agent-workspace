# SQL数据层 · 当前结构与治理

适用系统版本：2.7.0 · 文档修订：2026-10-17

## 当前组件
运行PostgreSQL；JSONB承载可扩展记录，pgvector承载512维简介向量。数据库服务与业务进程独立，但业务服务停止时，数据库在线不等于对外业务仍可使用。
文件本体不放进业务字段，继续由对象存储保存。多个模块可共享一个数据库服务，通过schema、数据库角色和公开函数区分职责；schema名本身不是自动安全隔离。

## 主要数据领域
|schema/领域|保存什么|
|---|---|
|authn|邮箱登录与认证会话等认证数据|
|authz|成员、客户端、凭据指纹、项目资格、管理范围与变更|
|vault2|凭据元数据、申请、授予、文件交付挑战/资格与审计；不存私钥明文|
|mem|材料/版本、属性、来源、对象位置、简介、索引、处理与使用事件|
|v8|项目、工作、回执、采用、上下文、交接、经验与治理候选|
|evidence/coord等|请求观察、操作状态及协同记录|

真实秘密通过OpenBao保管。运行身份与无登录的领域所有者分开，业务通过授权函数执行；Agent日常走MCP/API，不直接绕过授权修改表。

## 一致性
SQL事务保存本领域状态与回执；对象存储、发邮件、转写、云API等效果在事务外执行，通过原操作编号、状态查询和接续协调。
成功保存metadata不证明外部对象已经移动；邮件已排队不证明收件人已收到；response_prepared不证明人已经理解。
重试复用原标识，未知效果先查询，不以全局封包或全量测试作为每次工作的前置。

## 结构化字段与JSON
稳定身份、权限、版本及重要性等固定字段不能被任意JSON属性替代。业务扩展可进入JSONB，常用属性按使用证据再讨论提升或加索引。
目前字段治理接口记录对象字段出现、请求路径观察和范围内的使用情况；不是数据库自动给出所有字段/JSON键的真实使用排行榜。
不要求为每个新想法立刻迁移表结构；也不要求所有信息都塞进JSON而丢失约束。

## 规模与运行
数据库与核心服务可同机部署。不能把此前瞬时内存/硬盘余量当作未来峰值保证。
连接池、持久化磁盘、备份、恢复、角色租期和监控属于运行条件；多实例/高可用尚不能由换库本身自动获得。
SQL、对象存储、OpenBao的恢复要对应同一运行范围和实际权限状态，不只恢复文件正文。

## 成员工作事实与缓存分工
V8的board_tasks（定义/展示）、board_claims（真实成员认领与认领时约定快照）、board_receipts（原文声明/修正引用）、points_entries等账目表；board_commands用于效果去重，board_events是实际操作留痕，不是第二个任务库。原work_items/work_updates继续负责工程工作及过程。
`v8.member_work_read`只读组合现有表，不新增业务状态表。成员完成按claim_id归属，不能一人完成覆盖多人。原资料与版本由mem维护，V8和任务板保留引用及使用关系。
星宿SQLite的contexts/history、relations、work_facts、material_insights等是派生理解、关系判断或可重建缓存，不能回写覆盖任务事实。当前任务板来源类别board使用现有认领ID作为来源键，模型不可修改原声明、金额或成员权限。不同状态含义、缓存与历史快照不是简单的重复数据。

## 提案复用现有任务对象
成员提案与正式任务共用board_tasks与同一task_id，proposed/changes_requested/rejected状态表达发布前决定，原published/archived仍保留。proposed_by与publisher_id分别表达提议人与正式发布人，approved_from_revision与confirmed_revision保存实际确认版本。
board_task_history保存内容、报酬、理由和操作者的不可变版本快照；它是历史，不维护第二套当前任务状态。原board_commands保证效果去重。认领仍在board_claims，回执仍在board_receipts，资金仍在points_entries；批准不会写认领、积分或身份权限服务资格。

## 项目问题与建议的唯一维护方
v8.project_feedback保存项目关联、真实提交人、不可覆盖的原反馈和处理方当前声明；project_feedback_updates保存追加说明/更正和状态历史；project_feedback_commands恢复同一效果，三者不是三个独立状态维护器。原反馈与任务、工程和经验条目用途不同，不自动互相改状态或新建任务/账目。
反馈提交需要当前项目可读以及客户端基础写能力；状态处理复用项目work.commit实际权限。私有项目及reporter_and_handlers反馈仍按当前授权过滤；来源链接只是提交的参考，不宣称其正文已读取或自动授予附件权限。

## 任务级统一投影与并发约束
沿用 board_tasks/board_claims/board_receipts：claim 增加 participation_role（owner/collaborator，历史未厘清为unknown），任务增加 progress_revision 和 completion_receipt_id 指向现有完成回执，回执保留代记 submission_note。没有新建平行任务状态系统。
单个有效owner有唯一索引；任务锁、权限复核和触发器保证接取及完成原子性。完成依据锚点不可清除，不允许完成后新增参与或负责人状态回退；普通补充保留已完成。board_task_projection 共用于列表与成员工作，派生状态不成为独立可编辑事实。
历史角色不明确时保留unknown并按依据核对，不猜测负责人；账本、条款快照及固定资料身份保持。

历史版本与变更记录保存在正式发布档案；通过 POST /v2/manuals/read 提供本篇 id 和 version:"2.6.2" 可读取整理前正文。
