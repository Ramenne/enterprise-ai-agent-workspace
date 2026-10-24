# 资料存储服务当前维护归属

Mem主HTTP运行源码维护在本工程source/，工程构建复制到dist/。独立语义与URL导入适配器的工程源由Hufu docs/architecture/independent-services.json定位，它们经Mem公开接口访问领域事实。未在当前索引登记的旧Mem副本及dist生成物不是修改入口。SQL事实、版本、权限、租约、CAS和提供商操作由资料存储服务领域维护；上层应用引用领域结果。

## 输入契约

source/apps/mem/src/的core、agent、description、processing、navigation、legacy、effect、upload、external-model、equivalence、vector、governance和search各自的contracts模块分别维护对应业务输入，相应HTTP处理器导入同一声明。effect-contracts集中固定目标操作的移动、补偿、对象校验与GC输入，同时保留GC路径、动作和权限类别。input-contracts.mjs只是发布索引，不另写字段。

scripts/generate-input-contracts.mjs从实际Zod定义生成generated/mcp/mem-input.json，每条契约保留所属源及摘要，消费端使用相同字节。普通投影不补默认值；legacy-domain-defaults-v1保留旧资料入口已有嵌套默认值，维持历史请求指纹。不要从Hufu树内旧Mem基线复制业务规则。

JSON Schema表示可发布的结构约束；跨字段refine、当前权限、目标版本及外部效果条件仍由领域执行，不能因帮助中没有表达就删除。两类disclosure和ASR start保留HTTP实际分支选择，发布各分支的结构定义；MCP只组合可展示字段，不把展示对象用于领域执行校验。搜索原始字符串必须到领域先trim后检查长度，发布投影不提前裁剪或归一化。上传path中的operation_id与body各有原合同，MCP只承担必要参数搬运。独立semantic/url服务不能套用Mem主HTTP契约。

验证按受影响范围选择：tests/input-contracts.test.mjs检查普通输入，tests/legacy-contract-owner.test.mjs检查历史归一化，tests/effect-contracts.test.mjs检查固定目标、GC确认、CAS输入、补偿子键和原处理器调用。原提取基线只证明当时迁移，不限制经授权的规则演进。

上传控制、归档发布及GC候选范围由source/apps/mem/src/upload-contracts.mjs维护。HTTP正文与params.id分别校验；MCP发布将同一正文与operation_id组合，现有入口再搬到路径。组合发布对象不是HTTP正文；适配器检查顺序、旧attempt/fencing_token接续、提供商状态和最终权限不由发布投影改变。

公共变更游标输入来自Hufu packages/platform/src/change-contracts.ts；本工程副本及origin标识一起发布，构建检查副本摘要。各自事务、权限和游标结果仍由本领域维护。

## 构建与恢复

.hub/build.sh核验发布物与源一致，.hub/build.mjs一次复制维护树并检查指定模块。构建、部署和业务验证分别报告，不把生成dist作为另一个修改入口。

原操作键、journal、固定版本和恢复参数保持；未知外部效果查询原操作。共享failure-contract及authorization-transport由Hufu packages/platform/src维护，Mem使用带来源摘要的发布副本。授权不缓存允许结果或自动重试；网络/无效响应503与真实401/403分别表达，领域SQL负责最终授权和提交。

storage-restart.test.mjs用真实提供商/流程/journal代码与持久合成SQL/COS对端检查跨进程恢复，不代替实际数据库并发、GC租约和生产对象验证。只执行与本轮改动有关的必要检查。

历史实现与阶段证据保存在本工程Git历史及中枢工作 #1000123 的固定引用中。
