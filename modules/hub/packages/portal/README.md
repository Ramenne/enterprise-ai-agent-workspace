# Portal 2.0 原创维护树

source 来自 2026-10-06 实际 /srv/workspace 运行源码；不包含旧版本、消费者秘密、AES密钥、运行数据或 docs 文档库。服务只依赖 Node 内置模块；packages/portal/source 中普通源码、静态文件和子目录都可正常发布；17是当前文件数而非能力上限，新增模块无需修改可信控制器或逐文件审批。

Hufu 项目 fbe863aa-824f-4688-a24d-bc3398754704 现工程 API：read/write/commit 使用 packages/portal；build/deploy/rollback 参数严格为 {"component":"portal"}。效果提交带 idempotency_key，返回 operation_id 后查询原操作。{} 仍为 Hufu core。

构建由 hubeng-hufu 在原工程隔离空间检查 JS 语法并产出 dist/portal-artifact.json。固定控制器只接受当前干净提交的固定源码目录内普通文件，安装 /srv/workspace<commit>-<time>/，current 指向 release，固定 hub2-portal WorkingDirectory 切换；User/Group hub2hufu、Node ExecStart、端口和现身份链保持。

consumers.private.json、portal-session-key.private、docs 链接至固定 portal776 原持久位置；发布不读取其秘密内容。控制器未暴露主机、unit、root 命令参数，不以 root 执行成员源码。控制器安装本身为原生可信维护，不从成员提交执行安装脚本。只允许已经 active 的 Portal 发布，停止态明确拒绝启动；其他暂停产品、旧公网、服务、权限均不受影响。新 baize_hufu2/tools_hufu2 SSO 目标与 start 导航来自现源码原样保留。

新增普通源码与静态文件可直接进入 source、commit、build、deploy。发布拒绝路径越界、符号链接，以及 docs/private/env、.env、.private、node_modules、.git 和控制器 release.json 等保留项，固定运行配置和文档链接不变。新增外部依赖另按实际需要处理，目前仅依赖Node内置模块。
