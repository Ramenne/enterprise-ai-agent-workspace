# V8 · 项目、工作与上下文接续

适用系统版本：2.10.0 · 文档修订：2026-10-21

## 默认行为

hub.work.resume已知project_id与work_item_id时直接读取工作，不先重复读取项目。默认返回概况、最新进展、未解决声明与近期固定成果，近期成果默认窗口3项并附当前元数据/读取参数；include_material_metadata:false可省略元数据，原始历史传include_history:true，上下文构建传include_context:true。以上扩展均按需。普通工作响应不附带完整work_policy；说明见GET /v2/work-items/judgment-policy。读取截断阶段不自动发第二次鉴权去展开判断；需要时调用POST /v2/work-items/judgment，project_id/work_item_id/expected_revision使用实际读取结果。不把缺少判断或元数据当成工作读取失败。接续组合由共享应用用例维护，工作事实及当前权限仍由V8负责；网页或MCP入口不另存一份工作状态。

## 定位
V8保存工作的业务事实、关系和可交接上下文。看板是呈现方式之一。资料存储服务保存原件，V8保存一项工作用了什么、形成什么判断及下一步。

## 项目与工作
项目分 personal/team/private 与 project/dialogue。个人和团队默认组织内可读；隐私是创建后由项目本人显式标记的保密范围。project/dialogue 表达持续性。主管才能创建团队或将公开个人项目提升为团队；本人控制隐私标记及解除。转换通过 project.convert 保持 ID 和历史，采用 expected_revision CAS。
每项工作有稳定UUID和可读short_no，可跨多个Agent/对话、多轮阶段推进。不要把一次对话必然当作新项目，也不要把所有数据治理混进一个已经完成的页面工作。
项目默认负责人、资格与具体工作动作看实际返回；可见性标签不自动赋予服务器权限。

## 阶段保存
work.open最小建立目标；work.save/commit追加阶段成果，包含summary、判断/依据、fixed outputs、状态、关联和可选上下文。
更新已有工作带expected_revision。related_assessment可为unassessed/partial，不把尚未判定关系当作阻止保存的原因。
成果引用直接复用工具返回的固定版本；当前MCP兼容size、project_id及显示元信息并归一处理，无需手工删字段或填写hash。既有工作可把work.read返回的work_item对象直接送到work.save，平台读取id/revision；也可显式传work_item_id和expected_revision。
完整报告与原文存资料存储服务，V8回执引用它们。completion_state的提交声明与主工作状态是否变更由write_mode、work_state、completion_applied分别说明；两者均不证明外部部署或全系统完成。

## 采用与关系
adoption_set指向固定文件版本并记录用途/依据。保存文件不等于业务已经采用；新版本也不自动替换旧采用。
相关工作有带依据的显式关联。缺失来源、间接关联或推测应标注；不要从“同项目”自动推出全图关系。

## 上下文与交接
实际接续入口：hub.work.resume({project_id:"已取得的项目UUID",work_item_id:"已取得的工作UUID"})。已知编号直接读取，默认不构建上下文；需要时再显式使用include_context:true、include_history:true或include_material_metadata:true。名称/编号别名与参数以当前help为准，不要求成员手填上下文UUID。
此入口默认提供简明continuation工作包：最新进展、有效判断、纠正、边界、待办、固定资料及实际读取参数。默认保留近期固定引用并补充有权元数据；需要更多元数据时按当前契约显式请求，资料经当前权限定位到其真实项目并返回属性、位置与版本变化提示。历史展开使用v8.work.read；新接入工具契约也支持include_history:true，不默认重复大段规范化文本。
metadata_coverage说明当前返回的资料元信息数量；某一来源不可读或元信息缺失时保留提示，继续可用工作。固定引用不自动升级成最新版本。本文不声称平台能够自动捕获所有客户端完整对话。
新建当前视图时继承当前可读历史里最新明确保存的阶段上下文，保留有效判断、纠正、必要固定引用与下一步；返回stage_context_origin说明采用的回执。没有阶段上下文时仍可读取原工作，Agent再补充，不伪造完整对话。
context.prepare保存目标、有效判断、异议、固定资料、未完成操作与下一步，source_coverage标明原文/附件/摘要/片段/未知。
materialize/read生成当前权限下的视图；历史manifest与当前可读视图分开。source_stale等变化提示给Agent判断影响，实际撤销的权限不继续泄露原文。
上下文可裁剪、分页、按节点分块。裁剪视图不是完整交接；读取回执不证明理解。
handoff.record/accept/read保存交接与继续处理情况，不能自动保证另一Agent已经接手执行。

## 经验与治理
experience.publish存经验主张、固定依据和适用条件；feedback存再用、反例、纠正或不适用，不自动把经验判成真。
治理候选接口inbox/claim/resolve，可发现已完成工作、经验反馈/修订和重要简介维护候选，认领后写判断或延期/修订链接。
候选池不等于常驻Agent已经自动运行，也不阻止普通工作。认领租期与已完成态的复盘有利于第三视角检查，但智能评价仍需实际Agent或人执行。

## 常用API
/v2/projects/search、read、convert；/v2/work-items/open、save、read、search、history/page；/v2/adoptions、/v2/contexts/prepare、/v2/handoffs、/v2/experiences、/v2/governance/inbox、claim、resolve。
具体字段由hub.help和当前工具列表提供；大记录使用statement_read_chunk和context_view_page，不以摘要替代完整事实。

## 当前阶段与编号

work.read.current_summary 表示最新有权阶段；work.search 的当前阶段字段优先，初始 brief/summary 不等于最新进展，注意返回的语义、时间和 coverage。W前缀、#前缀和旧数字可在工作查询入口定位，保留原稳定身份；工具返回的 work_item.id/revision 可用于追加。阶段回执属于软协作流程，不要求写前具备全量说明、所有来源或已评定关系。

## 工作归属、直接关联与判断

当前政策：`v8-work-identity-v2`，可用 `hub2_api({system:"v8",method:"GET",path:"/v2/work-items/judgment-policy"})` 读取。该政策按需通过独立说明接口读取，工作读写不附带完整政策；它不授予权限。

保存前先读取候选工作并比较目标。同一写作或交付目标的取材、提纲、初稿、修订、测试、交接可继续原编号；话题、对话或文件变化不自动要求新编号。目标或独立交付实质分离时才建立新工作。

### 工作粒度与引用的明确边界

一个工作对应一个能说清结果和完成条件的具体目标；研究、讨论、实施、修复、测试、发布和交接可为它的连续步骤。

当前动作仍在完成原来的同一个具体结果时沿用原编号，包括必要取材、修订、普通缺陷修复、重试和反复更新。对话、文件、日期、提交或发布变化不自动建立新工作。

新要求形成可以独立说明、交付和检验的结果，且不只是原结果的下一步时新建；先读候选并比较具体目标。共用产品、源码或原工作仍未完成不足以证明应沿用旧编号；重构、上线等标签也不自动决定新建。

工作边界和引用分开判断。实际直接采用、延续、修正、回应或实质影响才写related/properties.relations及具体依据；同项目、同编号、同主题、仅查阅、可能将来兼容均不构成关联。引用旧成果不要求沿用旧编号；新建也不自动引用全部历史。

资料采用指向固定版本并记录用途与依据；上传、保存、检索或阅读不等于实际采用。新版本不自动替换旧采用；工作引用和资料采用分别按真实使用登记。

归属错误保留原编号、原件与阶段历史，追加纠正；必要时新建并引用既有成果，后续沿新目标记录。不静默搬迁、重编号、批量重判历史，也不为新建把旧工作虚报完成。

尺度检查：这次要形成的具体结果是什么？；它仍是原结果的必要步骤，还是可独立交付和判断是否做成的另一结果？；沿用是否把目标扩大成整个项目；新建是否只是切出一个中间动作？。不要把整个产品长期归在一个编号，也不要按文件、步骤、一天或一次提交拆号。判断由Agent或本人负责，系统不做语义自动评分。

用 `properties.work_judgment` 保存 `decision`（`continuation|new_work|undetermined|correction`）、`reason` 和实际读过的 `compared_work_ids`。追加已有工作带当前 `expected_revision`。缺判断可保存但明确未判断；声明新工作却向已比较旧工作追加会被拒绝。归属错误保留编号、原件和历史，追加纠正，不静默搬迁、拆分或重编号。

工作归属与实际关联分开判断：追加阶段不是关联；同一项目、编号、归档、主题相近或仅查阅也不是依据。实际直接采用、延续、修正、回应或实质影响才通过 `related` 或 `properties.relations` 写入既有有向关系账本，提供 `basis.explanation`，可带实际工作读取回执和固定资料引用；继续同一工作与引用另一工作可以同时成立。真实文件派生使用资料存储服务来源/加工链。

`v8.work.read` 保留已返回阶段里的判断；截断阶段不再自动追加鉴权请求展开判断，需要时调用下述专用接口。缺少判断保持未返回，不用旧判断冒充当前判断。完整报告与原文仍按需展开。

实际接口：`POST /v2/work-items/judgment`，参数 `project_id`、`work_item_id`、`expected_revision`，沿用本人 `v8.work.read` 资格，只返回指定当前阶段的有权判断字段。语义判断由Agent或成员承担，结构校验不是自动理解保证。

隐私项目不会因主管身份或旧资格而可见；本人之外的读取须通过 hufu.project.privacy.apply/requests/decide/revoke 完成 owner 与 supervisor 两个实际角色的授权。授权队列不包含项目内容。参见 project-authorization 的现行规则。

## 成员任务与工程工作的边界
任务板的published/archived是展示状态，board_receipts的completed/partial/blocked是成员按认领提交的声明，work_items的状态属于工程工作。三个含义分别维护；AI理解或工程完成不自动改成员声明，也不触发任务结算；结算以任务主负责人的完成回执与已确认认领条款为准。成员原回执无需主管审核或终端验收；工程记录的创建者/提交者不能自动当作任务领取人。
同一任务可明确关联已有工程工作。成员工作清单以认领为主项展示linked_work，不再次列出同一关联工程；保留原V8记录和历史，不把相似正文或必要历史快照当重复而删除。未领取的任务仍按标题查询；不强制每张任务卡建立V8工作。
工作保存默认context:false，显式context:true或上下文配置继续可用。已有工作不带expected_revision时只追加阶段，返回write_mode:append_only、work_state及completion_applied:false；completion_claim是提交声明，不能当作主状态已变更。带真实expected_revision进行CAS时可更新工作主状态。成果完全相同的关联写入去重，历史更新记录保持。
新成员读取层见 `member-work`；任务/积分见 `task-points`；派生理解见 `xingxiu`。现有工程写入口继续承担工作维护。

## 任务创建的业务决定
任务板的发布前状态proposed/changes_requested/rejected用于成员提案与主管决定；同意直接将同一任务变为published。过程详见 `task-points`。它不是独立工程状态，不自动建立V8工作、工程资格、认领或报酬。完成回执不走此决定流程，仍立即留存；V8工程状态的已有含义保留。

## 项目反馈事实
原项目ID可用于问题/建议提交和查询；V8项目反馈模块维护原文及增量处理记录。它不复用经验反馈的experience_id，不强制创建V8工程工作，不自动改任务或项目状态。需实施时可选择关联任务/工程记录，处理方声明已解决不证明外部产品已修复或用户验收。原文保留，更正或补充通过append；详见 `project-feedback`。

## 任务整体执行与工程状态
任务板整体进度由主负责人有效回执及完成锚点表达。V8工程状态、任务整体进度和协作者个人完成分别保留，不自动互相更新。明确引用 work_item_id 可接续工程，不能按同名合并。任务完成后无重开；负责人完成时依已确认认领条款自动结算基础积分与现金应付，实际付款和产品验收分别记录。详情见 task-points；成员只读汇总见 member-work。

## 关联定位、更正与前身历史

关系详情给出from/to真实project_id、short_no及可直接读取的v8.work.read参数，跨项目关联沿返回的所属项目读取，不能沿宿主项目猜对方UUID。related_candidates把corrected与active作为当前有效直接关系；同来源更正边替代前身，withdrawn仍为撤回。
授权读取可返回关系前身history，保持原工作正文及当前摘要；深度最多32，全次256行/128KiB，不可读、循环或超限明确partial。前身历史不是自动传递关系，不批量补边、合并或重编号。正式业务部署eb9a93c及工作#1000341/F-1009200-002是此项依据。
按编号直查hub.work.resume({work_no:"0237"})的四块概况见mcp-guide；旧work.search仍支持兼容搜索，结构候选展开有界100、按当前阶段稳定排序并修复大整数编号溢出，不代表所有旧搜索性能问题已消失。
共享v8-work-link-judgment方法Skill已发布F-1009285-001、案例F-1009286-001、元信息F-1009287-001，目录F-1004236-005。编号沿用/新建和实际采用分开判断，优先比较原目标；共享可读不等于所有Agent已安装或语义准确率提升。

历史版本与变更记录保存在正式发布档案；通过 POST /v2/manuals/read 提供本篇 id 和指定 version 可读取对应冻结正文。
