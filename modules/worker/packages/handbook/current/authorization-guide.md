# 身份权限服务 · 申请规范与交付对象绑定

适用系统版本：2.7.0 · 文档修订：2026-10-17

先确认当前已有资格，已授权直接工作。缺失范围才申请；主管可在真实管理范围主动授权。权限生命周期为授权、撤权，到期后按当前需求重新申请，不冻结或解冻。

|目标|通道|授权实际对象|
|---|---|---|
|项目资料与工作|project/business|既有项目工作资格|
|源码、构建、部署|engineering|项目登记的工程工作区与服务|
|数据库访问|database|指定表和动作|
|资源操作|resource|已登记真实资源及动作|
|领取文件、密钥或配置|delivery|申请人专属具体交付 item_id|

统一入口读取 `GET /v2/authorization/help`；使用 `hufu.access.overview` 查看当前资格，catalog/prepare 发现对应项目与通道，apply 提交实际用途与范围，applications/decide 查询审批，change 撤权。HTTP 经 hub2_api 调用，真实字段从当前帮助读取。

项目与工程使用同一 project_id，工作号和项目名不能冒充实际项目ID。not_registered 表示尚未登记目标能力，不是主管拒绝；先由管理人登记，不反复提交。批准项目资格后同一成员不同有效 MCP 共享资格，不逐资料、工作或客户端重做申请。

## 敏感文件交付

申请→applications→candidates(application_id)；没有合适文件时 register(application_id) 登记申请人专属文件；得到真实 item_id 后 decide 批准；批准后 list→challenge(item_id)→verify(challenge_id,code)→同身份 download。

application_id 标识申请，item_id 标识文件，不可互换；register 只是受控准备，不能冒充批准。批准缺少 item_id 返回 recipient_delivery_required；先登记实际对象，不伪造编号。交付只允许领取文件，不新授服务器或项目权限。完整合同见 vault-delivery。

普通申请和查询沿当前 MCP；管理动作需要真实管理身份，必要确认有效期内复用；高敏领取必须真实本人邮箱验证码。invalid_input 按帮助修正字段，unknown 查询原申请/操作，批准后回读实际资格或可领取项，不把受理当生效。

历史版本与变更记录保存在正式发布档案；通过 POST /v2/manuals/read 提供本篇 id 和 version:"2.6.2" 可读取整理前正文。
