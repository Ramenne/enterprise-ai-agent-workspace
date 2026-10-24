# MCP/API接口参考

适用系统版本：2.10.0 · 文档修订：2026-10-21

MCP/API接口参考

接口以当前登记契约为准，已知工具可直接调用；未知能力用hub.tools按组查询，参数不明用hub.help({tool})读取实际契约，再用hub.invoke({tool,arguments})执行。直接API使用hub2_api，system为hufu/meng/v8，路径为公开/v2接口。

核心入口：身份hufu_whoami；按需上下文hufu_context/hub2_context；资料保存hub.document.save、固定读取mem.read_full/hub.document.open、查询mem.search/hub.materials.find；项目v8.project.search/read/create；工作v8.work.save/read/search、hub.work.resume；资源交付hufu.access.applications、POST /v2/vault/deliveries/list，实际资源由获得授权的主体直接使用。目录不是授权证明，主控一般不承接产品业务实现，用户明确要求时可执行。

工作接续：已有project_id/work_item_id直接读取；include_material_metadata、include_context、include_history为主动扩展。默认不下载完整work_policy，说明见GET /v2/work-items/judgment-policy，特定工作判断见POST /v2/work-items/judgment。入口保留必要协议身份核验并仅在同一请求内复用解析；领域服务仍执行当前资格、到期和最终事务检查，不把寻址或身份缓存当作授权。

业务字段、默认值和公开输出由实际领域维护，MCP/help使用同源发布描述；路径转换、条件分支和SQL校验保留各自边界，不要求所有入口强行采用一种模型。精确参数、响应、公开路由和失败恢复以hub.help或所属模块help为准；同一效果重试保留原幂等标识，不重复产生效果。返回固定引用和资料编号由平台生成，调用方复用现有引用，不手填低层字段。

## 当前成员工作与任务/积分入口
通过 `hub2_api` 的system:v8调用：
- GET `/v2/member-work/help`；POST `/v2/member-work/list`、`/v2/member-work/detail`、`/v2/member-work/activity`、`/v2/member-work/understanding`。字段、来源ref和分页见 `member-work`。
- GET `/v2/board/help`；POST `/v2/board/tasks/lookup`、`/v2/board/claims/record`、`/v2/board/receipts/save`、`/v2/board/receipts/query`。回执立即留存，无审核门槛。
- 积分账户、发放、现金支付记账、转换、兑现及更正均为现有 `/v2/points/...` 契约，完整名单由 `/v2/board/help`返回，操作含义见 `task-points`。
星宿已登记MCP能力使用 `xingxiu.query`、`xingxiu.request`、`xingxiu.request.status`；主管维护能力见 `xingxiu`。不要猜造xingxiu.team.snapshot等未登记工具。
新读取接口不拥有任务、回执或账目的写入权；引用旧事实，AI缓存与事实读取可独立使用。

## 成员主动提案
现有任务板新增公开POST `/v2/board/tasks/propose`、`/v2/board/tasks/decide`、`/v2/board/proposals/query`、`/v2/board/proposals/history`。通过既有hub2_api/system:v8调用，字段与条件要求由GET `/v2/board/help`及 `task-points`提供。效果写入带稳定幂等键，修改/主管决定带真实expected_revision。确认建议价格或明确现金/基础积分后，同意将原任务发布；不调用资源授权、不产生认领或账目。上述路径不是新增MCP工具名。

## 项目级问题与建议反馈
GET `/v2/project-feedback/help`；POST `/v2/project-feedback/submit`、`/v2/project-feedback/query`、`/v2/project-feedback/read`、`/v2/project-feedback/append`、`/v2/project-feedback/operations/query`。system:v8；提交最小project_id/text/idempotency_key；有实际项目读权限的成员使用具备基础写能力的本人客户端提交，处理状态需要实际项目work.commit权限与版本。详见 `project-feedback`。这不是experience.feedback，也不要求先建工作/任务。

## 任务状态统一接口
task-points-v3 扩展原 tasks/lookup：execution_state、owner_id 过滤，新增整体进度、owner/collaborators、个人声明、完成依据、允许操作、task_revision及过滤绑定游标。claims/record 增加 participation_role；协作者必须由实际主负责人或主管登记，原 task_hall 服务不获此角色权限。receipts/save 增加 in_progress、可选 expected_task_revision，主管代记需 note。完成返回实际生效状态，无重开或审核流程。
member-work-v2 增加 task_execution_state 过滤、列表 task_execution/participation_role 和详情统一状态。原 state、my_claim、成员 ref 与财务接口保持原义。具体参数与错误以实际 help 为准。

## TOOLS统一工具

`tools.library` 是当前真实工具名。`action=help` 返回本人实时操作与Schema；`call`按原契约调用，写入提供稳定idempotency_key；`operation`查原key的实际效果；`knowledge_search`按业务项目、分类、标签返回有限候选，读正文后判断适用。

模块、调用示例、知识正文空白处理、视频parse/job_status/download_manifest与本机落盘边界集中见 `mcp-guide` 的TOOLS章节。不能把media_parse的accepted或manifest的delivery_required当成下载完成；实际文件和音视频合并由调用端验证。公开操作清单以tools.library help为准，不另造tools.api.*入口或按模块名称猜接口。

## 当前绘画、视频、画廊与员工客户端接口

MCP：hub.work.resume（工作四块概况）、employeeclient（7种action）、visual组13工具、gallery组17工具。按mcp-guide展开目录和完整实时Schema，不把功能组或HTTP路径当工具名。visual.output.get可返回原生image内容；鉴权视频路径不是公开分享URL。
HTTP：https://hufu.example.invalid/api/h3-cloud 提供H3 capabilities/health、preview、jobs与结果；/krea2提供原生Krea图像任务，/unified/krea2为统一visual执行入口；具体请求与结果路径按当前能力说明。统一图像16倍数与原Krea HTTP的8倍数输入范围不同。
MiniMax音频基础地址为https://hufu.example.invalid/api/h3-cloud/audio%EF%BC%9AGET /capabilities、POST /health、GET /voices、POST /speech/preview、POST /music/preview、POST /speech/jobs、POST /music/jobs、GET /jobs/{uuid}、GET /jobs/{uuid}/audio。沿当前Bearer；生成额外带Idempotency-Key和明确生成/计费授权，原ID查询未知效果。尚无对应audio.* MCP工具，不编造工具名。
语音speech-2.8/2.6的hd/turbo、非流式MP3、最多3000字符；音乐music-3.0/2.6的接口可发现但当前账户实测410/base_resp2153，无音乐产物。M Plan语音短样成功并完整解码；音乐资格不能由语音成功推定。billing_source为m_plan或official_api并匹配实际Key类型，预算估价不是供应商硬封顶，网页声贝/订阅不可假定与API余额互通。新请求用当前实际授权配置，报告不含Key。
员工客户端HTTP为https://employeeclient.example.invalid/business/v1/integration%EF%BC%8CMCP employeeclient help返回其members/conversations/messages/message/send/send_file契约，查询不更改已读。工程read-only source_export与mcp-edge组件的固定路径见project-engineering。

历史版本与变更记录保存在正式发布档案；通过 POST /v2/manuals/read 提供本篇 id 和指定 version 可读取对应冻结正文。
