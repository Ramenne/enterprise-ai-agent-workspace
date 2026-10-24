# 身份权限服务 · 敏感文件交付

适用系统版本：2.7.0 · 文档修订：2026-10-17

本页只说明敏感文件交付。普通模型、ASR等API密钥原值明文领取请读 `vault-plaintext`，使用 `hufu.vault.reveal`；不要求走本页验证码下载流程。已有中枢ASR服务调用另见 `integrations`。

文件交付让指定成员取得已准备的私有配置或资料。可采用主管直接交付，或成员申请后审批两条通路。文件领取接口本身不新建服务器、工程、云账户或项目资格；包内可包含已获授权且已配置可用的SSH私钥、原云API配置等资源。秘密只进入授权私有交付配置，不保存在普通日志、报告或 Git。

当前合同：`hub2_api({system:"hufu",method:"GET",path:"/v2/vault/deliveries/help"})`；以下 POST 路径均以 /v2/vault/deliveries 为前缀。

|步骤|路径后缀|当前帮助披露字段|
|---|---|---|
|成员申请|apply|title，purpose?，requested_expires_at?，idempotency_key|
|查申请|applications|view:mine/pending/reviewed，limit?，cursor?|
|查实际候选|candidates|application_id|
|登记专属文件|register|title，recipient_id，filename，content_base64，expires_at，scope?，application_id?，idempotency_key|
|主管决定|decide|application_id，expected_revision，decision:approve/reject，approve必需item_id，expires_at?，reason?|
|本人可领取项|list|无必填字段|
|本人发码|challenge|item_id|
|验证|verify|challenge_id，code|
|停止未来领取|close|item_id，reason?|

申请后审批通路：批准前用 candidates 查找或 register(application_id) 准备真实申请人专属对象。application_id 与 item_id 不互换；绑定申请的文件登记成功不等于申请获批，缺 item_id 不能批准。绑定申请未批准时不能发码、下载。

主管直接交付通路：真实主管通过 register 指定 recipient_id，准备已授权的私有文件，不填 application_id。返回 registered 后，该成员可从本人 list 查询领取项，不需要再提交 apply 或要求一次重复 decide。其他成员不能领取这个文件。主管身份、当前软件能力与范围仍由服务实际校验；不能以正文声明代替授权。

普通申请和查询无需额外 OTP；主管审批沿真实管理资格，有效同主体、软件、凭据与范围确认可复用。项目限定的管理确认不能据此审批全局个人交付。高敏领取必须本人绑定邮箱真实验证码，不索取邮箱密码，不伪造号码。

verify 成功后依实际返回访问 `GET /v2/vault/deliveries/download/<delivery_id>`，使用同一授权身份，将二进制附件保存本人私有文件。领取票据的范围和期限以实际返回为准。close 停止新领取并保留历史，不能召回已交付值。

查询原申请和 operation 时沿原幂等标识；unknown 不重复产生文件或发放效果。审批决定、当前可领取项、取回成功和外部部署分别记录。完整秘密附件不作为一般阶段原文留存。

## 已交付成员如何领取

1. 用自己的中枢身份调用 `hub2_api({system:"hufu",method:"POST",path:"/v2/vault/deliveries/list",body:{}})`，查询本人当前可领取项。
2. 对选定 item_id 调用 challenge，用本人绑定邮箱验证码完成 verify。不要在普通报告中记录验证码。
3. 使用同一身份访问 verify 返回的下载路径，将附件保存到本人私有目录。

成员不需要冒用主管身份、建立新的应用身份，或把已授权整机操作改成MCP受控发布。领取服务器配置后，可以直接SSH管理并用其原云API配置操作已授权资源；开发和业务部署由所属团队完成。

文件的领取截止时间、邮箱验证票据有效期和包内资源权限有效期是三种不同期限。领取窗口到期不自动撤销包内SSH或原云API权限；资源撤权需按实际资源管理实施。close只能停止未来文件领取，不能召回已经下载的私钥或原值。

当前已完成六人的个人开发服务器配置直接交付。实际资源核验与领取授权已经完成，成员是否下载应按实际记录另行确认。版本发布和本人更新提醒仍属待实现机制，不能把私有文件登记成功说成成员已收到发布通知。

历史版本与变更记录保存在正式发布档案；通过 POST /v2/manuals/read 提供本篇 id 和 version:"2.6.2" 可读取整理前正文。
