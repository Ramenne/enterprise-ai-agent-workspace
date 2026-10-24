# 员工客户端公共 MCP 发现入口

单一`employeeclient`工具属于中枢默认tools/list，无需在每台电脑安装Skill。`hub.tools({group:"employeeclient"})`单列员工客户端消息与协作；`hub.resolve`对明确员工客户端消息/分享意图及工作群、文件传输助手的消息请求给出当前目录里的员工客户端候选，仅发现，不发送或补造参数。

AI收到“把结论发到员工客户端”时可直接选择employeeclient，首次通过action=help读取参数。默认target=assistant；用户明确要求员工客户端工作群才用target=group；指定同事从members获取真实username。查询不标已读，发送需用户该次授权、同一幂等键、真实message回执；未知结果沿原标识恢复，不换键重发。

成员身份和权限仍由原网关及员工客户端业务校验。本改动没有复制成员身份、绕过授权、读取所有用户消息或扩大附件限制。未接中枢的AI仍需接入本人MCP；缓存旧工具列表的客户端需刷新/重连。旧hub.invoke路径保持可用。

源码维护：disclosure.mjs负责默认列表和分组；intent-resolution.mjs负责已有工具的候选排序；employeeclient-tool.mjs负责工具说明与原业务转发，gateway.mjs调用公共排序函数。测试employeeclient-discovery.test.mjs和employeeclient-tool.test.mjs。只发布component=mcp-edge，不用Hufu core部署冒充本组件发布。
