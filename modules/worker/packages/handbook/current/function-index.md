# 企业 AI 协作平台 · 功能索引

适用系统版本：2.7.0 · 文档修订：2026-10-17

已知接口直接调用；需要定位能力时用hub.tools按组查找，字段不明确时读取完整契约。工具目录与下列手册提供导航，实际权限由服务检查。

|目标|完整规则|
|---|---|
|理解整体对象与协作方式|handbook|
|首次接入、Agent长期指令|start-guide、agent-preset|
|MCP/API调用与失败接续|mcp-guide、api-reference|
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

历史版本与变更记录保存在正式发布档案；通过 POST /v2/manuals/read 提供本篇 id 和 version:"2.6.2" 可读取整理前正文。
