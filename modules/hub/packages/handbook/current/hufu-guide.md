# 身份权限服务 · 身份、权限和凭据

适用系统版本：2.10.0 · 文档修订：2026-10-21

## 默认行为
入口保留协议、会话和主体归属所需的身份核验；同一请求可以复用已解析身份，减少重复/whoami往返。请求结束后不复用该结果，领域读取、提交和外部效果前仍检查当前资格。服务端从实际凭据导出actor，不接受调用方借字段指定身份。
权限按完整资源判断，明确区分组织、项目、文件、发现查询与产品代办。仅获指定文件的有效授权不会被额外的整项目权限要求误拒绝，也不因此扩大为整项目可读。项目版本核对、来源闭合、到期撤权和事务保护继续有效。

## 本人接入

沿用本人 MCP 或从身份权限服务“身份与软件”取得配置。当前主要登录路径为本人邮箱验证码：/v2/auth/email-otp/send-verification-otp、/v2/auth/sign-in/email-otp。只需要邮箱和验证码，不索取邮箱密码。秘密存受控配置，不进入普通对话、日志或 Git。

hufu_whoami/hufu_context 返回真实成员、软件和范围。普通成员接入后在本人范围创建项目、保存资料、建立和接续工作；同一成员不同有效 MCP 共享已批准项目资格，不逐客户端再申请。历史软件动作或范围元信息不是普通成员资格的唯一依据。服务主体和专项动作仍按其实际能力边界校验。

## 当前权限规则

身份、项目资格、管理委派、工程资源、数据库/云目标和敏感文件领取分别判断。项目与工程沿同一 project_id；项目资料可写不代表整机或父账号权限。目录登记不发权，资料已保存不代表已采用，文件获准领取不代表已部署。

缺实际资格时使用身份权限服务统一申请通道；主管在真实管理范围既可处理成员申请，也可主动授权。已授权整项目不再按源码、工作、每项普通动作重复申请。资格撤权或到期后阻止新操作；与正在提交的事务按实际锁和最终检查确定先后，不能用入口旧结论绕过。产品代办在要求双身份的通路同时核验真实成员和服务授权，不以服务身份冒充成员。新增需求重新申请，不冻结、解冻或恢复旧资格。历史操作和成果保留。

管理确认不足时由真实主管本人邮箱验证码建立管理上下文，有效同主体、软件、凭据与范围下可复用。验证码不增加原本不存在的角色或项目资格，不伪造 OTP；普通申请、查询和已授权工程操作无需逐条验证码。

## 按任务读取

- 授权类型与对象：authorization-guide、project-authorization；GET /v2/authorization/help。
- 工程项目资格、施工和主动授权：project-engineering、agent-engineering-approval；GET /v2/engineering/help。
- 数据库表和动作：database-permissions、sql-data。
- 普通模型/API原值明文密钥：vault-plaintext；hufu.vault.list/apply/decide/grants/reveal，GET /v2/vault/reveal/help。资源包批准后须核对具体条目grant；grant限定客户端时以获批客户端领取。
- 高敏文件交付：vault-delivery；GET /v2/vault/deliveries/help。

原 Vault 凭据渠道和敏感文件交付均按真实接口执行，不宣称全部历史申请已合并。高敏领取走本人 challenge→verify→同身份 download，审批前必须绑定真实 item_id。关闭领取不会召回已交付值；供应商密钥或外部权限撤销需在对应来源实际生效。

## 凭据限定与错误接续

POST /v2/credentials/create 使用同一 Idempotency-Key 及原JSON请求接续。规范范围字段为 resource_selector：

```json
{"resource_selector":{"version":1,"kind":"projects","project_ids":["已返回的真实项目UUID"]}}
```

project_ids 数组简写现可确定补齐为该selector；两种形式同时提供须为同一UUID集合，不合并或覆盖冲突。空值、非法UUID和未知安全限定字段明确拒绝，无害旧元信息保持兼容。不要将资格过滤或目录发现当成授权。

服务器保原请求digest/HMAC/逻辑key及历史receipt；返回current_effective_scope_filters来自当前客户端限定。旧发行结果与请求限定不匹配时，返回scope_confirmation_required和原CID/receipt，抑制key交付。先查并在真实管理权限下修正该原对象，不换key影子重发。

MCP输入不合法会提供validation_errors的字段路径与要求；按实际help修改相关字段，不回显或留存密钥/验证码。

## 门户与长期资格的显示边界

身份权限服务主要界面保留AI/Codex接入、文件浏览查询、身份与软件。员工客户端下载在电脑展示扫码二维码，手机保留直接下载；账号管理由原页面入口打开现有服务，不以iframe绕过对方限制、不在URL传凭据。当前独立账号工具位置由TOOLS自身目录维护，历史service.example.invalid不作为永久当前服务地址。
工程until_revoked表示成员资格直至撤销；目录/执行许可仍显示各自有限时间，实际每次执行核对当前资格。批准、实际资源交付、开始执行和上线不是同一状态；查询申请应同时查看权限来源与协作收件箱，不能只查一条队列。

历史版本与变更记录保存在正式发布档案；通过 POST /v2/manuals/read 提供本篇 id 和指定 version 可读取对应冻结正文。
