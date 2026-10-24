# 企业 AI 协作平台 · 功能索引

适用系统版本：2.10.0 · 文档修订：2026-10-21

已知接口直接调用；需要定位能力时用hub.tools按组查找，字段不明确时读取完整契约。工具目录与下列手册提供导航，实际权限由服务检查。

|目标|完整规则|
|---|---|
|理解整体对象与协作方式|handbook|
|首次接入、Agent长期指令|start-guide、agent-preset|
|MCP/API调用与失败接续|mcp-guide、api-reference|
|TOOLS六模块、知识/Skill/HTML、视频解析与本机下载|mcp-guide（tools.library）、api-reference、integrations|
|按工作编号看概况/最新进展/问题/成果|mcp-guide、v8-guide（hub.work.resume）|
|Krea2绘画、Civitai LoRA、H3视频和训练计划|mcp-guide（visual组）、api-reference|
|画廊提示词片段、自动回库、点评与来源追溯|mcp-guide（gallery组）、integrations|
|MiniMax语音与音乐接口及资格限制|api-reference（音频HTTP，非audio工具）|
|员工客户端成员/会话/消息与授权发送|mcp-guide（employeeclient）、integrations|
|只读Git历史/源码导出、MCP独立发布|project-engineering、source-coverage|
|身份、项目资格、隐私与管理|hufu-guide、project-authorization、authorization-guide|
|项目工程与个人测试机|project-engineering、agent-engineering-approval|
|数据库权限与结构|database-permissions、sql-data|
|普通密钥与敏感配置交付|vault-plaintext、vault-delivery|
|资料存取、搜索、归档和清理|material-storage|
|重要性评定与人工特级|material-classification|
|项目、工作、采用、上下文与经验|v8-guide|
|任务、提案、回执、积分和现金账目|task-points|
|成员工作清单、活动和理解|member-work、xingxiu|
|项目问题与建议|project-feedback|
|产品接入与职责|integrations、service-boundary|
|资源、运行、备份与恢复|operations|
|资产迁移与当前工程发现|service-migration|
|源码位置与当前覆盖的查法|source-coverage|
|当前发布及发布方法|release-notes、release-policy|

手册通过hub2_api调用system:hufu的POST /v2/manuals/read，body为{id:"上表手册ID"}；目录使用GET /v2/manuals/catalog。
同一规则在专题维护；本索引只负责定位，不维护副本制度。

历史版本与变更记录保存在正式发布档案；通过 POST /v2/manuals/read 提供本篇 id 和指定 version 可读取对应冻结正文。
