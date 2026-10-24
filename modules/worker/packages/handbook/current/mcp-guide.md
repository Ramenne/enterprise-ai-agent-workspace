# MCP与API · 实际调用说明

适用系统版本：2.7.0 · 文档修订：2026-10-17

## 默认行为

已知工具与参数可直接调用，无需每次发现目录、重读说明或重新建立管理上下文。原生凭据在纯转发路径由操作所属服务直接验证；涉及网关自身状态与所有者判断时保留必要身份识别。旧身份桥只用于旧接入。普通工作响应不再附带整份work_policy，需说明时GET /v2/work-items/judgment-policy。

## 接入和渐进发现

入口 `https://hufu.example.invalid/mcp`；确认 `hufu_whoami`、`hufu_context`，优先读 `handbook`，再从 `function-index` 或 `GET /v2/manuals/catalog` 按任务选择说明书。通过 `hub2_api` 读取：`{system:"hufu",method:"POST",path:"/v2/manuals/read",body:{id:"handbook"}}`。

`hub.tools({})` 查看功能组，`hub.tools({group:"materials"})` 展开功能组，`hub.help({tool:"hub.document.save"})` 读取契约，`hub.invoke({tool,arguments})` 调用。旧别名 `hub_help` 等以当前客户端实际工具列表为准，已知契约直接调用，参数不明确时按需读取帮助。直接 API 使用 `hub2_api`，system 为 hufu、meng 或 v8；公开调用不使用 /internal。

## 身份和权限

同一成员不同有效 MCP 使用当前账号已批准项目资格，普通个人项目、工作及资料不重复申请客户端动作。专项资源与管理动作检查实际资格、范围、期限和供应商条件；服务身份保留其自身动作与资源限制。目录、历史软件动作数组和说明书不授予权限。拒绝时按 error_code 定位实际缺口，不切换项目 MCP 或借用他人身份。

## 正确格式和固定引用

工作阶段保存优先复用 `v8.work.read` 返回的 `work_item` 对象：可作为 `v8.work.save` 的 `work_item` 输入，平台使用 id/revision；也可显式填写 work_item_id、expected_revision。固定引用直接复用工具返回的对象，兼容 size、项目/显示元信息，平台归一后执行；不要求成员手填 hash。工作编号查找可用 W前缀、#前缀或旧数字，返回真实工作身份；文件新显示格式以实际查号工具为准。

兼容处理只做可确定的别名、冗余内部字段和类型转换。目标不一致、删除对象或覆盖版本不能猜测；按当前错误显示差异与下一步。合法旧格式的 request_hash/phase 等内部冗余由平台重算，不当作客户端授权证据。

## 效果和恢复

写入重试沿用服务返回的 operation_id/resume_id/幂等标识，unknown/pending 先查询原操作，revision_conflict 回读后接续。forbidden 不盲目重试；503 区分服务未就绪、外部依赖和内部实现故障。HTTP 200 不代表业务成功，检查 state、fixed_ref、receipt 和原操作真实结果。

正文、历史和搜索结果按 next_cursor/next_offset 接续；目录、简介、摘要和裁剪视图不冒充完整原文。固定引用保留原版本，当前授权可变；源当前失权不得泄露正文。保存成果成功但工作回执失败时保留准确引用和待提交内容，不重复上传。

## 成员工作查询与实体任务板
成员查询按需求选择 `member-work` 或 `task-points` 手册，使用现有 `hub2_api`：
```json
{"system":"v8","method":"POST","path":"/v2/member-work/list","body":{"limit":30}}
```
通过 `hub.invoke` 时外层为 `{tool:"hub2_api",arguments:上述对象}`。成员工作四个读取路径不是四个新的MCP工具名；契约读GET `/v2/member-work/help`，任务/积分契约读GET `/v2/board/help`。
复用列表给出的ref和next_cursor，不手造另一套业务编号。body的字段和来源ID按该模块手册；不能把任务ID当认领ID，也不能仅凭同名选择任务。理解空缺或后台不可用不代表成员没有工作。普通 `v8.work.save` 默认不生成短期上下文，需时显式请求；追加声明与主工作实际状态分别看work_state/completion_applied。

历史版本与变更记录保存在正式发布档案；通过 POST /v2/manuals/read 提供本篇 id 和 version:"2.6.2" 可读取整理前正文。
