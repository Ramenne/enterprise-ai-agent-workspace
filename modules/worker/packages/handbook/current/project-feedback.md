# 项目反馈 · 成员、Codex与产品接入参考

适用系统版本：2.7.0 · 文档修订：2026-10-17

## 最短使用路径
告诉Codex“给员工客户端反馈：这里有什么问题”或“向这个项目提出建议”，Agent沿用真实本人接入，未知项目时用 `v8.project.search` 查实际project_id。反馈不要求先建V8工作、任务、提案或验收标准。接口使用现有hub2_api，system为v8；以下路径不是新增MCP工具名。
POST `/v2/project-feedback/submit`最小body为project_id、text、稳定idempotency_key。title可省略并由正文生成，kind为problem/suggestion（默认problem）；可附evidence_links、source_channel（codex/product/api）、native_thread_id。来源渠道是客户端声明，实际reporter_id/client_id由当前身份产生，不能在body冒填提交人。
调用范式：hub.invoke {tool:"hub2_api",arguments:{system:"v8",method:"POST",path:"/v2/project-feedback/submit",body:{project_id:实际项目UUID,text:成员真实描述,idempotency_key:Agent生成并保留的标识,source_channel:"codex"}}}。
返回state:retained、feedback_id、项目与版本；这只证明原文入队，不代表已通知、接受或修复。之后复用该feedback_id查询或补充，避免重复提交同一问题。

## 查询、补充与处理
POST `/v2/project-feedback/query`：project_id必需，可按handling_state、kind、reporter_id筛选，cursor/limit分页，列表只返回元信息。POST `/v2/project-feedback/read`：project_id、feedback_id，原反馈正文及增量记录返回，after_seq/limit与next_seq续页。
POST `/v2/project-feedback/append`：project_id、feedback_id、text、idempotency_key，任何对该反馈当前可读的合法成员可补充信息；原文不被覆盖，更正用追加说明。需要改变处理状态时再提供handling_state和当前expected_revision，且调用方必须有该项目实际work.commit处理权限。
状态submitted/in_progress/needs_information/resolved/not_planned分别为已提交、处理中、待补充、处理方声明已解决、暂不采纳。每次状态说明保留原因文字和操作者；resolved不是产品修复验证或用户验收。成员仍可追加“问题还存在”等事实，处理方据此更正状态，不强制另开任务。
反馈与任务分开：需要安排实施时可选择引用feedback_id向任务板提案，仍按原任务维护方处理；不自动创建任务、认领、积分或资源权限，不强制任何反馈先转任务。

## 权限与范围
使用当前身份权限服务成员凭据。有项目读权限的成员，通过具备基础v8.work.commit写能力的本人客户端提交/补充；不额外要求项目工作写资格来提出问题。只读软件不能提交；处理状态需要当前实际项目work.commit资格和客户端能力。项目访问撤销后旧反馈和操作恢复也不能绕过。
visibility默认为project（当前项目可读成员可见），可选reporter_and_handlers（仅反馈者和当前处理方，仍需当前项目可读）。附件/证据链接可选，保存参考不自动读取原件或扩大权限；不要把标题列表当完整原文。提交不发邮件/聊天消息，不自动指定接收人或通知到达。
所有效果重试使用原idempotency_key；未知效果可查POST `/v2/project-feedback/operations/query` {project_id,idempotency_key}。状态并发冲突先读实际revision再处理，不换键重复效果。GET `/v2/project-feedback/help`提供当前字段契约。

## 员工客户端接入参考
当前实际员工客户端project_id为 `ad44cc0e-159e-4e0f-a5ca-73d3920240d9`。成员/Codex可以直接向该项目提交和查询中枢反馈。该项目身份用于定位反馈，不代表产品业务已验收。
员工客户端团队可参考“问题/建议、描述、可选截图/版本环境、提交成功后的编号、后续补充与处理记录”的交互；这是参考，不是强制模板。应用界面、登录身份、文件上传、请求接线、自身处理和发布由员工客户端团队完成。它可以仅借鉴设计，也可在实际选择的API范围内自行接入，不要求迁移自身反馈业务表。
本接口当前面向有中枢权限的成员，不是外部匿名收件箱；外部用户路径由产品自己的身份与受理方案负责。提交身份沿用本人；不以处理方凭据冒充所有反馈者。中枢只交付公共能力和参考，不代改员工客户端APP。

历史版本与变更记录保存在正式发布档案；通过 POST /v2/manuals/read 提供本篇 id 和 version:"2.6.2" 可读取整理前正文。
