# 任务板与积分 · 成员操作和主管账目

适用系统版本：2.7.0 · 文档修订：2026-10-17

## 成员任务
实体任务板标题是查找入口，通过system:v8的POST `/v2/board/tasks/lookup` 提供title，可附project_name；同名返回候选时选择实际task_id，不猜测合并。任务包含具体内容、方向及已知资料，不强制制定验收标准。主管发布接口为 `/v2/board/tasks/publish`，修改已有任务带真实expected_revision。
线下领取有效，成员可用 `/v2/board/claims/record`记录；正文回执POST `/v2/board/receipts/save` 提供task_id或title/project_name和text，可附真实result_refs、declared_state。没有线上认领时该接口可补记本人关联，不制造假线下领取证明。声明为completed/partial/blocked/in_progress；每项任务一位主负责人，可有协作者；声明仍分别归各自claim_id，个人完成与整体完成分开。
保存回执立即留存，不需要主管确认、终端检查或AI理解完成。`/v2/board/receipts/query`可按任务、成员、日期查询，next_cursor原样续页；普通成员本人，主管可指定成员。原文保持；更正用supersedes_id关联原回执，不删除旧声明。published/archived是任务展示状态，不能当成员完成状态。

## 账户与账目
GET `/v2/board/help`返回完整路径/字段；POST `/v2/points/account`默认本人，主管可指定member_id。金额输入为整数分；100分=1积分=1元主管个人债务，现金与积分分别记账。账户显示余额、保留金额、现金应付/已付、转换/兑现请求和分页条目，不作为当前任务状态。
负责人完成回执按接取时已确认条款自动记基础积分和现金应付；主管沿原入口追加质量奖励和记录真实付款，质量加分是明确金额，不自动乘150%或设固定倍数上限。约定10元任务可体现10元现金与10积分，但无约定的任务不能由系统自动补价。每日预算仅参数，当前未确定核算口径，不自动按200元封顶。
成员可自愿申请将未付现金或实际已返现金等额转换为积分；已返现金需主管确认真实收回，转换不再乘质量系数。兑现达成约定后的到期为七天；延期由主管提出、成员对同金额/日期确认，拒绝或延期不消除债务。支付入口是实际支付后的记账，必须actual_payment_confirmed，不执行银行转账。更正使用账目纠正入口，保留原记录。
所有效果写入使用稳定idempotency_key；未知效果通过 `/v2/board/operations/query`查原标识，不换键重复发放。普通成员不可冒充主管发积分，独立服务不可冒充成员；采用当前身份权限服务真实凭据与现有权限。

## 与其他能力的关系
任务板拥有定义、认领和成员声明；V8工程状态、星宿理解及积分账目不反向覆盖这些事实。成员工作读取见 `member-work`，理解维护见 `xingxiu`。现有API仍可独立使用，不新增固定审批流程。

## 成员主动提出任务
成员可通过POST `/v2/board/tasks/propose`提出应该做的事情，初次提供title、description，可附direction、project_id/project_name、materials、suggested_cash_cents、suggested_points_cents和note；效果带稳定idempotency_key。建议金额仍以整数分输入，不设固定倍率、预算或领取数量政策。未确定建议报酬时可先提出，主管同意前必须明确确认现金和基础积分。
提案直接保存在现有board_tasks，state为proposed；proposed_by由真实身份生成，不能在body冒填；未发布时publisher_id为空。提案不进入可领取列表，不产生认领、积分或资源权限。成员自己的提案可查，主管可查看组织范围。
主管POST `/v2/board/tasks/decide`提供task_id、expected_revision、decision（approve/request_changes/reject）及idempotency_key。调整或不同意须reason，理由保留。同意时可直接确认所读版本的建议报酬（confirm_suggested_terms:true），或明确cash_cents、base_points_cents；可同时修改title、description、direction或materials，实际确认内容与报酬作为新版本保存。
要求调整后为changes_requested；不同意为rejected。成员通过原propose路径携带本人的task_id和实际expected_revision修改并重提，历史不删除。主管不得绕过真实版本冲突确认陈旧内容；未知效果按原幂等键查询，成功同意不能换键再造任务。
同意后同一task_id直接变为published，返回proposal_id与task_id相同，不要求主管再手工发布另一项任务。publisher_id记录主管，approved_from_revision指出所确认的提案版本，confirmed_revision指出确认后的版本。提议人和领取人分别记录，同意不自动认领、发积分或授予工程/数据库权限。
提案状态与历史：POST `/v2/board/proposals/query`可按member_id/state/cursor/limit查询；普通成员本人，主管可指定成员。POST `/v2/board/proposals/history`提供task_id，可按after_revision/limit读取原内容、建议与确认报酬、理由及操作者，next_revision续页。历史快照不能改写当前状态。
已发布任务继续用原认领、执行、回执和积分账本通路。后续调整已发布任务仍由原主管publish入口维护并保留版本；领取时的条款快照不被后来的报价覆盖。任务创建决定是业务决定，不是身份权限服务资源申请；完成回执仍立即留存，无审核门槛。原直接发布入口也继续服务主管自行发现的任务。公开契约以GET `/v2/board/help`的task-points-v3为准。

## 统一任务执行状态与负责人
GET /v2/board/help 当前为 task-points-v3。POST /v2/board/tasks/lookup 一次返回 publication_state、execution_state、owner、collaborators、participant_progress、progress_basis、can_claim/claim_block_reason、allowed_actions、task_revision、coverage 和 data_quality。原 state 仍是发布状态，my_claim 仍是当前调用者认领；它为空不能推断无人接取。
execution_state 为 waiting/claimed/in_progress/partial/blocked/completed；未发布且未接取为 not_applicable，历史角色不明确为 unknown 并标记 needs_reconciliation。claimed 表示已登记但未反馈进度，不能推断已经开始。可用 execution_state 或 owner_id 过滤；total_count 与授权范围和过滤一致。next_cursor 原样带回且保持过滤，支持新的 v3 游标，旧 UUID 仅兼容旧过滤调用。
普通任务一位主负责人，可有协作者。主负责人空缺时普通 claim 操作登记 owner；添加协作者用原 /v2/board/claims/record，提供 task_id、member_id、participation_role:"collaborator"、idempotency_key，由主负责人或主管明确登记，不能第二人接取时自动当协作者。原task_hall服务授权不增加角色登记权。
正文回执继续使用原接口，declared_state 增加 in_progress。主负责人 completed 才使整体 completed，协作者 completed 仅表示个人部分完成。主管代记另一成员回执须提供 note 原因，实际 submitted_by、member_id 和 submission_note 分别保留。原task_hall可在既有 named-member 范围内代记，仍不获得主管或资金权限。
完成操作返回 completion_applied 和真实 execution_state。expected_task_revision 可选，用于防止覆盖所读进度版本；原 expected_revision 继续仅表达发布内容版本。完成锚定实际负责人回执，后续补充不重开：负责人补充回执仍用 completed，不允许退回部分完成、进行中或待接取；没有重开接口。完成不等于工程完成、产品验收或现金已付；已确认报酬按原领取快照自动入账，缺少报酬时保留回执并返回待补约定。
接取与回执在任务锁下最终鉴权并由数据库约束保证唯一负责人。同人重复接取返回原claim，不新增副作用；同键相同请求返回原结果及适用的 current_task（最新任务状态），客户端优先看 current_task。不同人争取同一负责人返回409 owner_already_assigned；新成员接取已完成任务返回409 task_completed。结果未知查原幂等标识，不换键重复提交。
线下领取仍有效，缺线上关联时可在一次回执中补记，但不能抢占另一负责人。唯一历史认领依实际记录映射；历史多人角色不明确保留原件并禁止猜测接取。所有项目范围、原文和当前成员权限继续检查。

## 简短回执、基础结算和后续奖励

2026-10-16

成员端 Agent 完成任务后，在原回执里写实际结果、可查看成果、尚未完成或未确认的事，以及有用经验。没有新经验可以直接说明；没有遗留就省略。报告、视频、截图和测试结果按实际需要提供，不要求全套材料，不自评分。

继续用 /v2/board/receipts/save 的 text 和 result_refs。过程记录明确 declared_state 为 in_progress、partial 或 blocked；完成才用 completed。为兼容旧客户端，省略状态仍按原规则视作完成，新调用应明确传入。

负责人完成后，沿现有机制按认领时已确认的现金、基础积分快照自动结算。现金只形成应付，实际支付后由主管用 /v2/points/cash/pay 记账。未定报酬的任务完成回执照常保存，返回 pending_reward，主管根据真实约定补齐；程序不猜金额、不追发历史余额。

主管评价质量和长期价值后，在原 /v2/points/awards/post 提供 claim_id、receipt_id、quality_points_cents、理由与稳定 idempotency_key；只追加奖励时省略 base_points_cents 和 cash_cents。该金额是本次新增积分：基础10积分，最终希望15积分，本次填500。后续新奖励可另立决定，同一次请求重试沿原标识，不重复基础结算。

/v2/board/receipts/query 同时返回该认领的账目汇总，主管可以从成果看到基础积分、追加积分、当前积分债务及现金应付/已付。多份回执展示同一认领的当前账目，不能逐回执重复求和。基础和质量字段为发放累计；debt_cents 与 cash_due_cents/cash_paid_cents 为含兑换、更正等效果的当前净额，完整明细仍用原账户接口。

Agent 核对已有相关领域文档，有新认识才合并。经验条数、文字长度和知识库保存成功都不构成基础结算条件。系统保存事实和账目，主管或其他视角依据成果评价质量。

## 回执整理 Skill：完整指令与模板

成员端 Agent 通过 MCP 读取本节即可采用，无需先在本机安装 Skill。先取格式和说明，再填原回执；提交成功和填写错误的响应也会提供填写指引及本节读取入口。Skill 用来整理事实与经验，不替执行者评分，不改变结算金额。

### SKILL.md

```text
---
name: project-experience-distiller
description: 从实际工作和用户纠正中提炼下次能用的经验，填写简短任务回执；合并已有领域知识，保留必要日期。用于任务收尾、项目复盘和经验整理，不给执行者自评分。
---

# 项目经验沉淀

帮助下一个项目少犯同样的错。读者应直接看见遇到过的问题和下次的具体做法。

## 从实际工作里找经验

沿用户指定范围，读取相关成果、最新工作记录、用户纠正和已有经验。按线索补读，不默认扫描全部历史。旧标题和摘要只用来定位，不能代替最新事实。

挑出会改变下一次行动的认识：探索后找到的有效办法、失败原因、纠正后的工作方法、旧做法的适用条件发生变化。仅仅“完成了某项工作”留在回执里；没有新认识就无需新增经验。

核对纠正发生的语境和后续修订。用户约定按约定表达，历史报告按历史材料表达；未经验证的猜测不能写成已经奏效的方法。根因未知时保留未知。

## 直接写出有用的经验

每条用一个具体的行动标题，加一段话说清：**遇到什么问题，为什么需要改变，下次怎样做。** 必要时说明怎样检查结果。参考 [经验写法](references/experience-template.md)。

- 保留真正起作用的技术细节：环境、配置、操作顺序或检查方法；不要简化成“注意性能”“做好验证”等口号。
- 项目专用做法写清适用范围，不从一次纠正推出所有项目的永久规则。
- 日期用简短角注。工具或模型版本会影响结论时一并注明；未知不猜，重新编辑不刷新实际验证日期。
- 正文去掉关联栏、业务编号、版本编号清单、查阅数量和处理分类。不要求成员填写来源关系表。必要的原始依据留在现有工作记录中；能帮助理解的成果可直接链接。
- 交付时先展示提炼出的经验，再用一句话说明材料缺口；不以“已核对、已关联、已归档”代替经验内容。

## 合并到少量已有文档

打开相关领域的已有主文比较内容。相同经验不重复添加；有新条件就补充原条目；新事实推翻旧认识就修订原条目，简短说明变更日期和原因。有冲突尚未核清时保留不确定性。

不同项目的同类经验维护在同一领域文档，不为每个项目或发现新建 Skill。没有合适文档时先交付本次整理稿，不自行扩建知识库。文档不可读时如实说明，不声称已完成查重。

## 写入任务回执

使用 [简短回执模板](references/task-receipt-template.md)，说明做成了什么、还有什么未完成或未确认，附可查看的成果；有经验就直接写在其中。不要另加一张经验登记表。执行者提供事实和材料，质量由主管或其他视角判断。

历史整理不冒充本轮执行，不因此重新完成任务或发放奖励。按用户授权维护 Skill 和经验文档，不扩大为修改产品、积分或全局规则。保存时沿用既有文档并检查当前版本，避免覆盖他人修改；工具确认成功后再报告已保存。凭据不进入经验。

本 Skill 基于 Claudeception 适配，保留 MIT 许可；见 [来源与适配](references/sources-and-adaptation.md)。
```

### references/task-receipt-template.md

```text
# 简短任务回执

任务名称 · 日期

**实际结果**：做成了什么，当前能够怎样使用。附最能说明结果的成果，例如报告、演示视频、截图或测试结果，按任务需要选择。

**还没完成或没确认的事**：直接写具体问题。没有就省略；读历史报告不能写成刚刚实测通过。

**这次留下的经验**：有用的经验直接写“遇到的问题和下次做法”，参考 [经验写法](experience-template.md)。没有新认识可以写“本次没有需要补充的经验”。同类经验由 Agent 核对并维护已有领域文档，成员不用另填表。

简单任务几句话即可；不要加关联栏、编号清单、处理分类或自评分。回执提供他人判断所需的事实，不能用“优秀”“全面完成”等自我结论替代成果。
```

### references/experience-template.md

```text
# 一条经验怎样写

**标题直接说下次该怎么做。**

用一段话说明实际遇到的问题，以及下次采取什么行动、为什么。需要复现时保留关键环境、配置或检查步骤；内容复杂可以展开，不强制限定字数或字段。

末尾只加有意义的角注，例如：

> 适用：资料上传与迁入。经验形成：2026-10-03；本轮仅整理历史记录。

技术结论受版本影响时补充实际验证环境与日期。没有验证就说明；文字改写不代表重新验证。日期久远提醒核查，不直接判定失效。

## 示例

**文件先保存，理解和分类随后补。**

如果上传必须等 AI 写好摘要、判断重要性才算完成，分析失败就会挡住文件留存。先保证原文件保存并能取用，再补摘要和分类；尚未理解的内容如实保留。这样分析失败时，原始成果仍可用。

这是表达示例；实际整理时，必须从当前项目记录确认问题和做法，不能把示例直接当作本项目经历。

## 合并时

已有条目讲清相同做法，就不再添加。只多出一个条件，就补在原条目中。后续事实改变做法时，修改对应段落并留下简短日期说明。不要把这些维护动作变成报告中的分类表。
```

### references/sources-and-adaptation.md

```text
# 来源与适配说明

本包为 Claudeception 的中文定向适配，保留其 MIT 许可，见包内 [LICENSE](../LICENSE)。

上游：[blader/Claudeception](https://github.com/blader/Claudeception)

- 基准文件：[SKILL.md](https://github.com/blader/Claudeception/blob/62dbb91d1183a866b5cf40079265c825b2695843/SKILL.md)
- 基准提交：`62dbb91d1183a866b5cf40079265c825b2695843`
- 上游文件声明版本：3.0.0；作者：Claude Code。
- 本包适配版本：1.2.0；整理日期：2026-10-16（America/New_York）。

## 保留的上游方法

从实际发现提炼可复用知识；明确触发条件、解决方法与验证；先检索已有内容再决定更新、合并或新增；没有值得保留的知识可以不新增；保留版本日期与弃用说明。

## 按本次需求调整

- 输出优先进入少量已有领域核心文档，允许章节变体和定点修订，不默认每个发现生成新 Skill。
- 读取用户纠正时保留语境、适用边界与后续修订，区分项目约定和实证结论。
- 日期改为简短角注，只保留影响使用的形成或实际验证日期；文字整理不刷新验证日期。
- 交付事实与经验依据，不提供执行者项目质量自评；未知和无新增均可如实记录。
- 不安装 Claude Code hooks，不引入框架或特定知识库依赖；当前工具和权限决定实际留存方式。
- 用户只要求整理时交付成果；明确要求更新既有库时按授权维护，不自行扩大到全局指令、产品或财务。
- 经验直接写入简短任务回执，正文去掉关联栏、编号清单、处理分类和查阅统计；直接展示原问题与下次的具体做法，不另造经验填写单。

调研时另参考了 [pskoett/self-improvement 的维护说明](https://github.com/pskoett/pskoett-ai-skills/blob/5a836dc7163da6799fe34ed4283da6d7f0358f14/skills/self-improvement/references/context-maintenance.md) 和 [phnx-labs/learn 的筛选方法](https://github.com/phnx-labs/.agents/blob/66ae4f8d3c6ca831304ad2f7f06d4972b209962e/skills/learn/SKILL.md)。本包未复制这两个项目的文件或脚本，也未引入其固定晋升阈值、CLI、Linear或发布流程。它们是方法对照来源，不是本包运行依赖。

本包未附中枢私人原文或项目凭据。历史案例仍由原项目按实际权限保存，不能将其中的具体职责和部署要求自动推广到所有项目。
```

### LICENSE

```text
MIT License

Copyright (c) 2024 Claude Code

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

历史版本与变更记录保存在正式发布档案；通过 POST /v2/manuals/read 提供本篇 id 和 version:"2.6.2" 可读取整理前正文。
