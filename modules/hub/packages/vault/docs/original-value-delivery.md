# 获批外接密钥：原值明文交付

普通模型/API/服务密钥可以直接供外接软件使用。领取的是 Vault 中已登记的原值；MCP 是调用通路，不会因领取更换密钥，也不强制使用代理、临时令牌或子密钥。

1. `hufu.vault.list` 查询真实条目和 `value_delivery`。目录可见不代表已有领取授权。
2. 没有授权时调用 `hufu.vault.apply`，明确条目、接收软件、用途和期限。主管以 `hufu.vault.decide` 批准原申请。
3. 获准成员与软件调用 `hufu.vault.reveal({key:实际条目名})`，返回 `value` 和 `value_delivery.mode=original_plaintext`。可以将原值写入获准软件的私有配置，或经获准交付通路提供明文。普通报告、日志与 Git 不保存秘密。
4. 领取前后都检查当前条目授权，撤销或过期后拒绝继续领取；已领取副本不能自动召回。

阿里云 ASR 当前原密钥条目为 `model.bailian.beijing.asr`。它复用当前 ASR 供应商原值，目录初始化不改供应商密钥、不自动授权其他成员。现有 `model.opencode`、`model.opencode.goat` 等已登记模型条目沿同一领取通路；名称以实际目录为准，不猜测“Command Code”对应哪个条目。

查询当前合同：`hub2_api({system:"hufu",method:"GET",path:"/v2/vault/reveal/help"})`。

`/v2/vault/secret/initialize` 是新条目的初次登记，不覆盖已有值。`/v2/vault/secret/rotate` 是独立、明确的管理动作，普通领取不会调用它。现有服务器、DNS、COS管理条目的专属交付方式沿实际登记范围，不因模型密钥规则自动改变。
