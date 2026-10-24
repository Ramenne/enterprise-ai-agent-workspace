# H3独立组件部署

当前运行节点：Jiaxin。入口 https://hufu.example.invalid/api/h3-cloud ，服务 hub2-tools-h3-cloud.service ，127.0.0.1:18292，仅该前缀由nginx代理。

维护源码在工具工程 src/tools_h3_cloud.py 和 src/tools_h3_server.py；deployment/h3-cloud 保存服务、nginx、部署脚本和锁定依赖。以hubeng-tools执行Git；主管明确授权后可在Jiaxin用root运行本目录deploy.py，脚本检查源码已提交、原项目测试、依赖和ready，再更新独立服务与对应nginx前缀。此组件独立于旧python_compat全工具应用部署，不加载旧web包，不修改其他应用。

首次建立 /srv/workspace 后用 requirements.lock 安装依赖。版本文件在 releases/<commit>，current及previous记录当前和上一版；作业账本固定 /srv/workspace ，不随版本切换删除。无预置共享调用凭据。

回滚：核实previous指向的已知版本，将current原子切回previous并重启此服务；数据库和nginx同前缀无需清理。首次上线前nginx配置副本保存在 /srv/workspace

原部署54dcd652-fc04-491d-a296-b72062f65d57的旧主机SSH指纹不符，隧道未监听。此部署保留该失败历史，不关闭主机校验、不恢复未知旧应用。完整工具旧部署通道不在本次H3组件修复范围内。HTTP入口可用不等于新增专用MCP工具已注册。
