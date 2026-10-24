# AI代办工程申请与审批

适用系统版本：2.8.0 · 文档修订：2026-10-18

成员和主管 Agent 通过本人 MCP 操作，项目资格属于成员账号；不同有效 MCP 共享既有批准资格。

成员 Agent 先 GET /v2/engineering/help，再 POST /v2/engineering/projects，确认实际 project_id、资源、current_access 和期限。已有资格直接施工，缺失资格通过 apply 提交目标和真实期限，保留 request_id/revision/幂等标识；审批后回读当前资格，继续原连接。

主管 Agent 在真实管理范围内既可读取 requests 并通过 decide 审批，也可通过 grant 主动授权具体 principal_id 和项目，无需伪造申请。两者产生实际项目资格，不能从一次批准推定全组织全部开通。需要委派或撤权时读当前帮助；权限不冻结、解冻或恢复旧资格。

管理确认不足时真实主管本人 challenge→verify；有效同主体、软件、凭据和范围的确认可复用，普通施工不重复发码。验证码不能增加原角色，真实 OTP 未取得时如实说明并继续其他已授权工作。

关键路径均为 POST /v2/engineering/ 下的 projects、apply、requests、request、decide、grant、execute；当前字段以 help 为准。项目与工程沿同一 project_id，工作另有稳定身份；全项目授权不扩成整机、父账户或其他项目范围。

审批受理、资格生效、源码提交、部署完成和业务使用分别回读。503 根据实际 error_code 判断服务、执行器、资源或授权问题，不要求成员切换项目专用 MCP 或重复申请已批准资格。

历史版本与变更记录保存在正式发布档案；通过 POST /v2/manuals/read 提供本篇 id 和指定 version 可读取对应冻结正文。
