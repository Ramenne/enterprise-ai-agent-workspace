# MCP入口的维护归属

本目录维护协议、工具路由、信封和兼容参数转换。身份在每次协议入口核验；读取和更新仍由所属领域执行当前权限与事务检查。应用组合意图由 `packages/mcp-edge/source/application/` 维护，不放进MCP协议处理器。

## 参数与帮助

V8当前已发布业务输入的唯一维护文件是V8工程 `apps/v8/src/core-contracts.ts`。V8的 `scripts/generate-core-transport.mjs`生成输入JSON Schema；本目录 `src/domain-contracts/v8-core.json`是该发布物的原样副本，origin给出领域工程、源路径、源摘要与生成方式。不要在消费副本另改业务规则。

更新流程：在V8修改契约，生成并校验发布物，再将相同字节发布到本目录。MCP按现有工具路由匹配领域契约，字段及帮助中的最小输入一并生成，不再在schemas.ts或capability-data.json手写这组定义。传输投影不注入默认值；默认值仍由V8执行，避免外层参数与兼容payload冲突。SDK外层字段保持可选，领域必需项由实际领域调用校验。

Mem的资料、文本草稿、简介、加工、导航和旧资料引用输入由Mem工程source/apps/mem/src/各*-contracts.mjs维护，input-contracts.mjs是发布索引。Mem scripts/generate-input-contracts.mjs生成mem-input.json；本目录保留原样消费副本。每条输入带实际源模块及摘要，公开帮助据此指向对应领域。MCP按服务及路径选择发布物，不把独立semantic/url服务误配到Mem主HTTP。

旧资料引用的import/resolve同样从Mem发布物读取，已不再导入Hufu树内的旧Mem实现。legacy-domain-defaults-v1仅保留既有嵌套默认值，使原请求指纹及旧键回放不变；其定义仍由Mem维护，其余发布投影不新增默认值。

Hufu项目隐私参数由apps/hufu/src/project-privacy-contracts.ts定义，HTTP处理器与MCP直接导入同一对象；帮助最小字段由同一契约生成。

固定目标操作（移动、补偿、对象校验、GC）由Mem effect-contracts.mjs发布，处理器与入口共用结构定义；跨字段refine和当前权限/版本判断仍在领域执行。JSON Schema只发布可表达的结构约束，不是完整授权或效果保证。

独立语义与URL导入适配器由本工程登记维护，当前源、构建及运行对应集中在docs/architecture/independent-services.json。URL的HTTP与MCP共用apps/mem/src/url-import-contracts.ts；语义服务的实际Python校验与结构发布共用packages/semantic-service/source/input_contracts.py，build-source.mjs --publish-contract生成MCP副本，--check-contract检查一致性。投影不补默认值，source_context仍由MCP协议信封承接，实际UTF-8/模型预算及HTTP兼容UUID表达由领域检查。这两类发布按各自endpoint_key匹配，不套用Mem主HTTP契约；内容、版本、CAS与最终权限仍归Mem。

其余适配描述仍沿当前行为，后续按实际领域维护方收拢。它们不因“未生成”自动成为冗余；兼容别名、路径参数和协议字段仍可由入口维护。

验证这组契约：先运行 `node tests/build-domain-contract-input.mjs`，再运行 `node --test tests/domain-contract-input.test.mjs`。跨工程发布时核对V8生成物与本目录副本字节相同，并通过真实帮助及调用验证；编译产物放在dist，不直接维护。

## 结果和状态

入口传递领域结果，不自行判定任务完成或外部效果成功。部分成功、固定引用、原操作号、幂等键和恢复参数保持。输出白名单由所属领域维护；共享基础错误语义由 `packages/platform/src/failure-contract.mjs`维护，历史兼容不覆盖当前规则。

鉴权HTTP传输由Hufu packages/platform/src/authorization-transport.mjs统一维护；Mem/V8使用带来源摘要的相同发布副本。普通decision与发现decision每次都请求当前Hufu，不缓存允许结论、不自动重试。网络超时或无效授权响应属于可重试依赖故障，真实401/403保持；领域SQL仍执行最终授权与提交检查。

历史说明与实现可通过本工程Git历史及中枢工作 #1000123的固定记录查询。
