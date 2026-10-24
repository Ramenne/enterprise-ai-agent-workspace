# 普通模型密钥 · 明文领取与使用

适用系统版本：2.7.0 · 文档修订：2026-10-17

普通模型、ASR 等外接 API 密钥，经具体条目授权后可领取原始明文。领取不会轮换供应商密钥，不生成替代密钥，也不要求通过中枢代理执行模型调用。目录、审批、领取与使用分别以实际回执判断。

## 先选择通路

|需要什么|通路|成功时得到什么|
|普通外接 API 密钥原值|本手册；`hufu.vault.reveal`|JSON `value` 中的原始明文|
|按敏感文件方式交付的配置或附件|`vault-delivery`；`/v2/vault/deliveries/help`|按该通路完成本人验证后的文件|
|调用已有中枢 ASR 服务|`integrations`；`mem.asr.prepare/start/status/poll`|作业状态、固定结果及恢复引用；无需领取供应商密钥|

按条目的实际 `execution_channel_only` 和交付模式选择。服务器、DNS、COS 管理条目保留各自执行边界。普通模型原值领取不套用敏感文件的 `item_id → challenge → verify → download` 流程。外部产品可按已授权原值配置直接调用供应商；中枢 ASR 服务是另一种接入选择。

## 最短领取步骤

1. 用自己的身份权限服务接入配置调用 `hufu_whoami`，确认成员和客户端。身份权限服务接入 token 用于向身份权限服务认证，不能当作供应商 API 密钥。
2. 用 `hufu.vault.list` 查条目，记录稳定 `entry_id` 或 `name`、交付模式及 `has_current_grant`。目录可见不代表能领取。
3. 有当前具体条目 grant 就直接领取；没有时用 `hufu.vault.apply` 提交具体条目、用途和期限，主管通过 `hufu.vault.decide` 审批。参数先按 `hub.help` 查询。已有申请沿原编号处理，不重复建单。
4. 批准后，用获批成员及符合 grant 客户端限制的当前接入配置调用下列入口。有效 grant 期间，不逐次重新申请。
5. 读取成功 JSON 的 `value`，仅送入获准后台的私有配置或内存；再用供应商接口验证。普通报告、Git 和错误日志不保留原值。

现有 MCP 的调用示例（参数名不是密钥值）：

```json
{
  "tool": "hufu.vault.reveal",
  "arguments": {"key": "model.bailian.beijing.asr"}
}
```

通过 `hub_invoke` 调用上述规范工具名；也可把 `key` 替换为 `entry_id`。直接 HTTP 为：

```http
POST https://hufu.example.invalid/v2/vault/reveal
Authorization: Bearer <本人当前身份权限服务接入token>
Content-Type: application/json

{"key":"model.bailian.beijing.asr"}
```

当前契约可查 `GET /v2/vault/reveal/help`，或 `hub_help({tool:"hufu.vault.reveal"})`。示例条目是定位方式，不授予任何读权。

## 主管的审批与交付检查

资源包批准不会自动创建所有具体 Vault 条目 grant。申请要求明文时，主管须核对该条目、接收成员、客户端限制、用途和有效期，沿现有具体条目申请或已登记交付通路落实授权。不得使用主管成功领取代替申请人验收。

给申请人的非秘密回执应包括：原申请编号、条目名或 ID、当前 grant 或实际交付记录、获准接收身份和客户端限制、有效期、领取入口、`value` 的含义，以及尚未验证的事项。供应商调用需要的非秘密 endpoint、region、model 等配置也应明确提供；配置缺失不能仅回复“已批准”。

分别记录四个结果：已批准；具体领取授权或私有配置已交付；申请人本人已取到；供应商实际调用已通过。没有真实证据的阶段标待验证。不要用额外 V8 工作登记作为普通密钥每次领取的前置条件，不代签他人申请，不使用他人的个人 token 冒充验收。

## 领取失败怎么排查

`/v2/vault/reveal` 返回 403 时，先保留 `request_id`、`error_code`、条目名以及本人 `whoami` 的 actor/client；不要粘贴密钥或接入 token。

依次核对：是否用了正确条目和正式 reveal 入口；是否存在未撤销、未过期的具体条目 grant；是否是获批接收成员；当前客户端是否符合 grant 限制；当前凭据和客户端是否有效。普通项目资格跨客户端的规则不能替代具体密钥 grant 的客户端约束。

若只有资源包“已批准”而无条目 grant，由主管补齐原交付缺口，不要求申请人重新采购或反复解释需求。若当前 grant 完整仍被拒绝，按请求编号排查服务规则或发布故障，不靠重建账号、重发 token、轮换供应商密钥来猜测修复。

区分错误发生的位置：身份权限服务 reveal 的 403 是领取认证/授权问题；供应商的 401/403 是供应商调用认证/授权问题；中枢 ASR 读取其他身份创建的作业被拒绝是作业归属问题。不能把一种错误当作另一种通路不可用的证据。

历史版本与变更记录保存在正式发布档案；通过 POST /v2/manuals/read 提供本篇 id 和 version:"2.6.2" 可读取整理前正文。
