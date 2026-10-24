# 原身份权限服务工程函数维护能力交付

对应申请：bca3779e-337e-457f-a88e-4d02ce167724。

用户已同意由主控补齐基础维护能力，狒狒自行迁移、验证其修复。主控仅修正 authz.authorization_application_decision(text,jsonb) 归属为 hub2_authz_owner，给该维护角色读取 authz.application_targets 的内部权限；未应用 bd5c28a 的业务权限补丁。

原函数正文hash仍为85aa27a6f61cf964125573a29e31d043，SECURITY DEFINER/search_path固定，hub2_hufu执行资格保留，PUBLIC无执行资格。原FGB资格f12053b3依然effective_now=true，原期限不变，无新增资格或超级用户凭据。

通过原 /v2/engineering/execute，project_id=fbe863aa-824f-4688-a24d-bc3398754704，action=migrate，parameters.sql 传入原迁移文本，使用新的稳定执行提交标识。此前 e6ae6b22 失败，不把其状态当成功，按原 operation 查失败且未知效果时勿盲重提。

主控真实能力测试operation54d19371-759f-4a84-b1d0-58aed66c46ae已completed/exit0：SET ROLE hub2_authz_owner执行原函数原文CREATE OR REPLACE，随后ROLLBACK，仅验证维护能力，没有应用产品/业务修复。原公共authorization/decision read在归属修改前后均allowed/200。

请本人沿现有工程通路实施已提交修复、验证权限边界和实际迁移回执；主控不代运行白泽业务。原泛工程审批单目前仍pending，native approve会重复建立整工程资格，本次未调用它。实际资源缺口已解除；请用原request/change withdraw(reason资源供给已完成、沿用现有资格)收口此重复工程单，保留原申请与交付历史。无需重新申请工程权。
