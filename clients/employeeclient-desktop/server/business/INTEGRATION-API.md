# 员工客户端查询与发送接口

普通 HTTP API；部署于 `/business/v1/integration`。AI或其他获准程序沿用本人中枢 Bearer 凭据调用，不复制浏览器 Cookie。没有独立 MCP 服务，不要求增加本机连接配置。

|方法|路径（相对于上述根路径）|用途|
|---|---|---|
|GET|空路径|查询当前接口参数、认证和发送约定|
|GET|/members|可联系成员；username 就是真实 actor_id|
|GET|/conversations|会话及助手|
|GET|/messages|分页消息；target、q、before/after、limit|
|GET|/messages/:message_id|已发送消息/回执查询|
|POST|/messages|文字发送：body、可选target/reply_to_id|
|POST|/files/send|固定文件发送：material_id/version_id/sha256/name/mime，可选body/target|

认证：`Authorization: Bearer <当前本人凭据>`。写入另带稳定 `Idempotency-Key`；超时或未知结果保持原键和原内容重试，message 回执才表示已提交。默认 target=assistant；group/其他成员须明确选择。读取不标记已读。成员项目权限和客户端动作范围同时生效；服务端导出操作者。

文件复用现有存储与 AES-GCM 私聊附件、消息事务、通知 outbox 和跨端同步；发送不询问是否存储。目前该固定文件适配限制1字节至2MiB，传输头沿既有2KB预算；较大文件仍走桌面断点上传。拒绝任意URL、本地路径、Base64和内部密文源。

现有企业 AI 协作平台 MCP 内的小工具适配：`employeeclient`，action=help读取本接口契约，其余 action=members/conversations/messages/message/send/send_file。写入将 idempotency_key 转成上述HTTP头；不另存消息、不自动重试写入、不接收身份声明。源码位于Hufu的 packages/mcp-edge/source/employeeclient-tool.mjs；其上线状态单独报告，源码提交不等于当前MCP可调用。

此前 `/business/v1/mcp` 和 `/business/v1/ai` 专用协议入口已撤回，返回404。旧文档 AGENT-API.md 与旧专用MCP说明不再是当前接口。
