# 项目工程分区 · 成员与 Agent 使用说明

适用系统版本：2.10.0 · 文档修订：2026-10-21

主控负责公共基础能力、授权与资源交付；用户明确委托产品建设、修改、迁移、部署或验收时，按该次范围执行。职责约定不替代实际技术权限。完整规则见 `service-boundary`。

## 发现与资格

先 `GET /v2/engineering/help`，再 `POST /v2/engineering/projects` 读取实际资源、本人 current_access 与期限。已有整个项目资格直接施工，不逐源码、Git、服务或普通命令重复申请；同一成员不同有效 MCP 共享资格。

缺失资格可由成员 apply 申请，经真实主管 decide；主管也可通过 grant 主动授权实际成员，无需伪造申请。撤权与到期阻止新操作，新增需求重新申请，不冻结或解冻。目录登记不发权，未登记工作区先由管理人登记。

管理确认不足时真实主管本人走 management/challenge→verify，有效同主体、软件、凭据与范围确认可复用。普通 read/write/commit/build/deploy 不逐条验证码，秘密由受控后台使用，不要求领取父密钥或SSH私钥。

## 施工和部署

经 hub2_api 调用 `POST /v2/engineering/execute`，body 为 project_id、action、parameters，效果调用保留幂等标识。当前动作包括 list/read/status/logs/git_status/operation、write/commit/build/command/migrate/service/deploy/rollback/runtime，以最新 help 为准。

从当前权威源码工作区修改、提交、构建，查询原 operation 后部署，回读实际状态。生成物不是日常源码维护入口；登记工程区或授予资格不等于服务已启动。工程执行范围由登记工作区、运行单元、数据库和当前资源资格限定，不产生整机或其他项目访问权。

保存提交、构建/部署 operation、实际结果与固定成果，沿已有工作追加阶段。测试、源码、上线和业务使用分别报告。运行环境和业务记录分别管理，迁移方案不自动授权停服。

## 查看安全运行与发布观察

已部署 `POST /v2/engineering/observations {project_id}`，通过 `hub2_api` 的 system:hufu 调用。当前真实项目读资格即可读取登记服务的运行状态、原部署事实与观测时间，不要求工程grant；结果返回前再次检查项目读权限。未登记或未观测项明确unknown，不能把缺少工程资格推定成服务停止。

该入口只接受project_id，不执行文件读取、日志、Git或命令，不返回工作区、artifact_path、凭据或任意stdout。完整工程read/write/build/deploy沿原授权入口，观察资格不能用于这些动作。按登记的runtime_origin读取目标unit；远端固定status未能观察时返回unknown与unknown_reason，不把本机not-found/inactive当作远端状态。正式公网入口和登记unit分别标明来源，不由一个目标推定整个产品状态。

## 个人开发测试服务器的独立使用
成员使用已分配个人测试机的直接SSH及真实root/完整sudo ALL权限自行安装依赖、数据库和服务、开发、测试与发布测试版本。不得以MCP受控发布、固定启动脚本、目录/命令白名单、强制命令或service_id作为此类开发前置。上述已登记中枢工程通路仍适用于选择使用的项目；不能将其限制套到个人测试机。
主控一般交付资源与连接配置，用户明确授权产品工作时可执行，所需域名向主控申请。具体人员/节点、采购预算和既有业务接管仍按真实资源处理；不冒称已交付，不自动停服或迁移现有服务。需要将成果集成进中枢时再按用户方向处理。

## 严格只读源码与独立MCP发布

工程execute的action=read支持kind=git_history、git_file、source_export，revision为HEAD或真实commit，git_file另传path；历史用limit，导出按offset取65536字节Base64 ZIP页并固定返回commit与SHA。只导出获准已提交的普通源码，保护路径和符号链接排除；该resource.read通路不运行command、不授写入/构建/部署权限。先按实时engineering/help读取准确字段。
Hufu工程新增固定component:"mcp-edge"，支持build/deploy/rollback/status/logs，源packages/mcp-edge/source，实际目标hub2-mcp-edge.service、ready端口8939；默认core发布与此组件分别选择。独立发布保留固定运行目录/契约发布物，构建与回退只作用于选择的组件，不能拿整仓HEAD或core服务状态推定MCP构件。
长期until_revoked工程资格与短时执行许可分别记录；普通操作由当前有效长期资格签发有界许可，撤权/失效仍阻止新执行，不把内部许可截止时间误当成员资格到期。只读、完整工程与管理委派是不同授权，不为只读请求默认批准写入。
当前tools默认deploy仍指向另一旧业务服务，不能用它冒充绘画tools-h3-cloud组件发布；AutoDL60秒队列源码提交不等于已部署。

历史版本与变更记录保存在正式发布档案；通过 POST /v2/manuals/read 提供本篇 id 和指定 version 可读取对应冻结正文。
