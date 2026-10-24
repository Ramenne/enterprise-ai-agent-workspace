# 成员工作 · 唯一维护方与稳定查询

适用系统版本：2.10.0 · 文档修订：2026-10-21

成员工作查询接口说明｜已部署member-work-v2
基础地址：https://hufu.example.invalid/hub2-preview/v8
认证：当前身份权限服务成员Bearer，沿用本人客户端权限；普通成员本人，主管可指定成员，不开放任意服务冒充成员。
可通过已登记MCP hub2_api转发（hub.invoke）：{tool:"hub2_api",arguments:{system:"v8",method:"POST",path:"/v2/member-work/list",body:{member_id:"实际成员UUID",limit:30}}}。接口名不是新增MCP工具名。
GET /v2/member-work/help 返回当前契约和维护方。
POST /v2/member-work/list：member_id可省略为本人，project_id/state/cursor/limit/include_history可选；limit1..100。state为源状态筛选：board completed/partial/blocked/in_progress/no_receipt；V8 open/in_progress/completed/cancelled。默认不显示明确测试/历史迁移/归档工程及归档任务卡；include_history=true读取授权历史。
POST /v2/member-work/detail：{ref}，board ref.id是现有claim ID（不是task ID）；v8 ref.id是现有work ID且需project_id。board回执原文为latest_receipt，工程声明位于engineering；两者不能互相覆盖。未领取的任务内容仍用原有/v2/board/tasks/lookup。
POST /v2/member-work/activity：{ref,cursor?,limit?}；board含认领和原始回执/更正，v8复用工作updates授权分页。next_cursor为不透明值，下页原样带回并保持过滤条件。linked_work的工程活动用其ref另查。
POST /v2/member-work/understanding：{ref?,member_id?,project_id?,limit?}；理解来源星宿，返回freshness、来源版本、来源引用和understanding_state。无理解为pending_or_not_enrolled，不能解释为没有工作；后台不可用可返回503 partial，事实仍走list/detail。
所有工作引用保留来源ID，例：{source:"board",id:"认领UUID",task_id:"任务UUID"}；{source:"v8",id:"工程UUID",project_id:"项目UUID"}。列表已经给出可直接用于后续查询的ref。
列表覆盖与observed_at一并返回。源声明/AI判断、source_revision与源updated_at、registered_author/claimant分开解释。分页和历史不声称全员实际活动覆盖；原权限撤销不能通过缓存绕过。
维护方：修改任务内容用board/tasks/publish；登记认领用board/claims/record；回执用board/receipts/save且无需审核；工程记录用已有work接口；资金仅points接口；理解请求沿用xingxiu.request。查询层没有事实写入口。

## 提议人和领取人分别查询
尚未同意的提案仍是任务板同一任务对象，成员用 `/v2/board/proposals/query`查看提案进度及主管理由，用 `/v2/board/proposals/history`查版本；它不是领取任务，不冒充claimant加入在手任务清单。同意直接发布同一task_id，真正认领后才进入原成员工作查询。详情见 `task-points`。

## 整体任务与个人声明统一读取
当前 GET /v2/member-work/help 为 member-work-v2。board 列表项保留 declared_state 表达成员个人声明，新增 participation_role、task_execution_state 与 task_execution（同任务板的状态、负责人、各成员进度、依据和允许操作）。详情 task 也附相同投影。协作者 completed 不能当整项 completed，V8 engineering_state 继续独立。
list 可按 task_execution_state 过滤整项任务，原 state 仍筛个人声明或工程状态。next_cursor 原样续页，保持过滤条件，新的 mw2 游标绑定过滤；不将游标视为跨页冻结快照。ref 的 ID 及历史含义不变。
任务、角色与回执仍由原 board 写接口维护，查询层不拥有第二套状态表或写入口。当前项目权限作用于读取和理解来源；没有理解或无回执不代表无人工作。

## 已知编号的快速接续

已知工作编号直接hub.work.resume({work_no:"0237"})，默认四块为概况、最新阶段、未解决声明及近期固定成果；include_history:true再展开历史。不需要先遍历全部成员工作。仍需全量盘点时沿本模块list的next_cursor完整分页，并按ref读取来源。
最新声明、当前主状态、任务板主负责人/协作者、产品验收和账目是不同事实。新查询没有把它们自动合并，也没有将统一工作流程策划案自动实施。

历史版本与变更记录保存在正式发布档案；通过 POST /v2/manuals/read 提供本篇 id 和指定 version 可读取对应冻结正文。
