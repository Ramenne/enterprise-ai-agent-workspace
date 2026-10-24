# V8工程维护

## 2026-10-22 阶段知识回顾接线

`knowledge-followup.ts`统一定义knowledgeWorkflow，由判断规则接口提供默认流程，work.save/commit成功后按阶段边界返回knowledge_followup。仅主状态已实际完成，或Agent在properties.knowledge_review明确声明phase_complete时返回；普通更新、冲突/失败、只声明完成但主状态未更新不触发。reviewed_no_new/persisted为Agent已审声明，可避免重复提示，不当作系统语义验真。

当前Agent默认识别实质阶段并执行，不要求用户另发沉淀指令。阶段内累计问题、纠正、尝试与后续结果；阶段收尾可复用/更新/新增/继续观察/零新增。元数据提示只含已保存阶段定位，不复制对话正文、不额外请求、不自动运行模型。未部署常驻提炼Agent。

阶段来源范围沿用项目现有跨对话清单、取材SQL、阅读/理解边界及知识云端映射；knowledgeWorkflow的source_scope指向Skill的references/incremental.md。当前对话仅为来源之一，已理解未变化部分不重取，只补新增/改写/未完成分析或必要旧上下文；范围或权限有缺口保留partial。情绪和纠正沿相关对话跟踪处理与后续结果，不直接当作根因或立即改知识。

唯一知识正文、版本与检索入口仍为现有中枢tools.library及工具库。context-to-knowledge稳定Skill ID 488e337c-d0b2-4e19-a51b-dadebbb85eb3现为v6，含references/phase-workflow.md；按实时skill_read取得完整包。原SQL取材、暂存及索引保留，不建第二知识入口。V8原experience及治理队列只在来源/采用反馈或补漏确有需要时使用，不强制重复登记、不以知识沉淀另造工作号。禁止留存的讨论不进入材料，阶段状态与知识保存状态分别说明。

## 2026-10-22 工作颗粒度与生命周期规则 v3

`apps/v8/src/work-judgment.ts`中的workJudgmentPolicy是GET /v2/work-items/judgment-policy的规则源。v3将工作定义为“一个具体用户行为闭环的一次明确交付”，补初始范围、完成证据、小优化合并、四种既有状态、等待用户验收、原承诺缺陷与交付后维护/优化的判定。研究写作用具体交付及使用目的表达闭环。

这是Agent/成员的语义判断指引，保留既有字段、四种decision、状态值、幂等与CAS，不新增机械阈值、必填门槛、自动状态转换或历史任务迁移。结束不删除原成果和关系；后续优化不倒推原任务永远未完成。普通步骤不重复整套检查。

共享Skill仍使用共享库中的稳定正文F-1009285、案例F-1009286及skill-catalog.json完整固定版本集合；不在V8另造共享库。共享目录可发现不表示其他客户端已自动安装。版本接口回读和共享原字节回读分别验证，实际部署事实见工程operation及本次V8工作回执。

## 2026-10-21 关联链路实现

`20261021-relation-candidate-current.sql`保留完整候选函数定义，统一active/corrected且未被同来源后继替代的直接关系口径，前置检查旧函数body MD5。实际安装值不匹配时停止并核对完整线上定义，不删除检查或重放旧迁移。

`20261021-relation-navigation.sql`将完整当前work_read保留为带日期的内部前身，只新增已授权读结果的导航装饰，不重写旧领域读取/回执/摘要逻辑。返回每条关系的from/to项目与工作编号（两端均有权时），并在history中交付当前有权的更正前身。每条深度32、全次最多256行/128KiB历史正文，超出或不可读明确partial，给有权源项目下的statement.read_chunk接续；未知/撤权不伪造完整历史。最终authz.assert_effect保持。

`relation-properties.ts`把同次已授权history用于当前关系折叠与完整性判断，并提供目标project_id/read参数。新元数据不来自客户端猜测；不建立第二份关系账本或自动推导传递边。

验证：`node --test tests/relation-properties.test.mjs`；在**全新隔离PostgreSQL**中依次运行fixture、原902中的related_candidates完整定义、两份新迁移、assertions。fixture使用合成鉴权端口，只证明SQL/状态边界，不能代替真实成员权限和生产写入验证，严禁在业务数据库执行fixture。2026-10-21已完成授权工程提交/Node24构建、受管迁移和正式部署，已有跨项目、corrected和active三条真实边及本次实施工作已只读回归；必要时回退代码并恢复被保留的原函数，不删除业务历史。

AI工作编号/关联判断Skill由`v8-work-link-judgment`提供，可按当前官方judgment-policy执行。Skill本地已安装，正文与两份配套文件已发布共享库并完整回读，目录F-1004236-005已CAS合并并回读；共享正文F-1009285-001。目录可发现不表示所有Agent已安装、自动采用或判断准确率已经提升。规则不要求每个普通步骤重复判断，不根据关键词自动建号/补边。

当前执行源码入口为 `apps/v8/src`，工程身份为hubeng-v8。项目、工作、上下文、采用与交接的事实由V8维护；任务板和积分账本也是V8内的独立业务模型，彼此不共用一个全局完成状态。

## 契约归属

`apps/v8/src/core-contracts.ts`是核心HTTP路由的业务输入、约束和默认值维护入口；server.ts执行流程和最终领域调用。修改契约后运行 `node scripts/generate-core-transport.mjs`，生成 `generated/mcp/v8-core.json`；构建会执行生成物一致性检查。

MCP消费该JSON发布物，不手写第二份核心业务字段和必填说明。发布副本带V8源路径和摘要，按相同字节同步到Hufu工程 `apps/mcp/src/domain-contracts/v8-core.json`。生成的传输描述不注入领域默认值；已有直接参数、payload、幂等和CAS继续保留。新规则只改领域源文件及相关执行逻辑，不在消费副本覆盖旧条款。

当前未纳入core-contracts的专题模块仍由各自源码维护，不以集中数量作为目标；后续移动时保留原校验和执行边界。

## 构建与运行

通过登记工程的read/write/commit/build/deploy/operation/status维护。构建编译TypeScript并复制实际MJS依赖，dist是生成物。部署沿固定core_release，只切换hub2-v8及其独立release；Hufu/Mem不会随之同步部署。

packages仅包含静态import闭包所需运行依赖。标有origin的共享模块按标明的权威维护方发布，不能在V8另改公共策略；例如failure-contract由Hufu维护。其他V8专属实现由本工程维护。

凭据由运行配置与Bao加载，源码、发布物和报告不含凭据值。权限只授权或撤权，撤权后按真实申请处理；部署不启动暂停的旧产品。当前权限、CAS、领域回执与outbox在同一事务闭合，来源和固定版本不因接续而替换。

公共变更游标输入来自Hufu packages/platform/src/change-contracts.ts；本工程副本及origin标识一起发布，构建检查副本摘要。各自事务、权限和游标结果仍由本领域维护。

鉴权HTTP传输由Hufu packages/platform/src/authorization-transport.mjs统一维护；Mem/V8使用带来源摘要的相同发布副本。普通decision与发现decision每次请求当前Hufu，不缓存允许结论、不自动重试。网络超时或无效授权响应属于可重试依赖故障，真实401/403保持；领域SQL仍执行最终授权与提交检查。

历史维护说明与初始化清单保存在Git历史及 `.hub/original-source-manifest.json`；reference/legacy仅供历史理解，不进入构建。
