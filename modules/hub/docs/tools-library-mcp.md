# TOOLS 接入现有企业 AI 协作平台 MCP

## 当前状态

这是现有packages/mcp-edge网关的接入改动，不是另一套MCP服务器。用户继续使用原 https://hufu.example.invalid/mcp 。tools.library进入hub.tools的tool-library功能组，hub.help返回入口契约，hub.invoke执行。当前源码候选已接线、测试；尚未通过公网网关调用验收，不宣称已发布。

## 调用

发现：`hub.tools({group:"tool-library"})`。

帮助：`hub.invoke({tool:"tools.library",arguments:{action:"help"}})`，返回当前成员可用的29项（本次观察）原生操作及实时JSON Schema，不保留跨成员目录缓存；数量随权限/功能改变。

调用：`hub.invoke({tool:"tools.library",arguments:{action:"call",operation:"skill_read",arguments:{id:"488e337c-d0b2-4e19-a51b-dadebbb85eb3"}}})`。知识使用knowledge_list/read/save；Skill使用skill_list/read/import/version_save等实际目录名称。写入在入口层提供稳定idempotency_key，未知效果用action=operation和同一键查询；不得换键重新新增。HTTP转发只使用当前身份，不读取管理员凭据；敏感账号/文件能力与未开放Agent操作不转交。

检索例：`{action:"knowledge_search",business_project:"员工客户端",category:"项目实践",query:"轮询",tags:["场景:实时消息"],limit:3}`。检索返回元信息候选，必须再读正文和限制。当前后端仍返回完整授权目录，本入口只提供有限筛选视图，未声称后端分页、持久变化游标或全库语义搜索。

## 知识组织

沿原存储和固定版本，category区分知识性质，业务项目/场景/平台及有效状态用标签；projectId只控制原件存放权限。同一知识只保存一份，后续按原id/revision修订。status表示证据程度，不代替有效性；不把整理过的历史要求当现产品已实现。

先以K03输入法、K29事件唤醒、K53文件确认点试入库。三条原正文与条件保持，使用research证据状态，K53明确保留后期助手报告与用户手机直发约定的冲突。三种实际问题已各自命中；欧印筛选排除了员工客户端条目。随后基于既有整理结果完成104条现行候选归位（本次新增101条、复用首批3条），4条旧V8流程保留历史区、不进入默认有效集。按员工客户端、V8、资料存储服务、企业 AI 协作平台、开发工具和通用方法等多项目标签关联同一主体；没有凭来源会话把全部知识标成员工客户端要求。其他作者资料未改名/搬移。接续映射保留稳定本地ID→云端ID/版本/内容摘要，不重采原会话。7种实际检索加排除/跨项目同ID检查通过，证据状态仍为research。内容已入库与Node程序已改造是两回事，后端程序本轮仍未修改。

## 验证与待接通

16项相关用例通过（15项远端首轮及新增1项写入响应不确定性用例），另通过真实yyy身份读取实时契约、知识目录和已上传Skill。候选模块经原生TOOLS API真实写入和读回三条知识，不等于已通过公网中枢入口写入验收。

现工程部署登记仅有hub2-hufu.service；公网/mcp由另一个mcp-edge网关承接。原core部署不等于发布此网关。已申请资源接通b5264154-4958-4828-a18f-0855b13b27b2，要求登记真实mcp-edge build/deploy/rollback/status/logs，不扩大整机权限。原工具项目申请5a326f02已批准，但真实Node知识库源码/数据库/生产发布通路仍待交付；现有tools-legacy入口连接拒绝问题沿5432cd59接续。

本轮源文件：tools-library.mjs、tools-library.test.mjs、gateway.mjs、disclosure.mjs。gateway只增加导入、目录注册、help与调用分支；其他工具保持原行为。
