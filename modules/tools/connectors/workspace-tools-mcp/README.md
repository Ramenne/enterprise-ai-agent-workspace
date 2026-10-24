# TOOLS MCP 独立连接器

将支持本地 stdio MCP 的 Agent 直接连接到协作平台 TOOLS API。查询、知识入库、HTML 汇报和 Skill 导入都走 HTTPS，不打开网页、不点击按钮，也不依赖任务大厅进程。

## 安装和配置

需要 Python 3.10+ 和能访问 TOOLS、中枢及 PyPI 的网络。将发行 ZIP 解压到准备长期保留的文件夹；移动文件夹后须重新生成配置。

macOS / Linux：

```sh
sh install.sh
.venv/bin/tools-mcp login
```

Windows PowerShell：

```powershell
.\install.ps1
.\.venv\Scripts\tools-mcp.exe login
```

如果系统不允许运行脚本，可直接运行 `python -m venv .venv`、`.\.venv\Scripts\python.exe -m pip install .`、`.\.venv\Scripts\tools-mcp.exe config --upload-root "$PWD\uploads" --output client.local.json` 等安装命令，不必修改系统策略。

`login` 在本人终端使用现有中枢成员邮箱和验证码，创建名为“TOOLS MCP 独立连接器”的可撤销成员凭据；验证码不显示、不保存。既有中枢资格仍决定项目范围，不能创建成员或提升成员权限。登录凭据所需操作为 `mem.read`、`mem.upload`、`mem.write`、`v8.project.read`，直至本人撤销。凭据默认存放在 `~/.config/workspace-tools-mcp/credentials.json`，Unix 权限为 0600，配置模板和发行包不包含凭据。

已有本人身份权限服务 Bearer 凭据时，可用 `tools-mcp import-token` 隐藏输入；它会核对 TOOLS 返回的真实成员身份。不要把凭据写进聊天、命令参数或提交源码。自动化可通过进程环境变量 `TOOLS_MCP_TOKEN` 注入；跨用户部署每人使用自己的凭据文件，不能共用管理员凭据。

安装完成后生成的 `client.local.json` 含本机实际 Python 路径。将其中 `mcpServers.workspace-tools` 合并到目标 Agent 的 MCP 配置中，保留原有其他连接器，再重新加载该 Agent 的 MCP。此文件只有路径和选项，没有令牌。

通用配置结构：

```json
{
  "mcpServers": {
    "workspace-tools": {
      "command": "/安装目录/.venv/bin/python",
      "args": [
        "-m", "tools_mcp", "serve",
        "--credential-file", "/本人私有目录/credentials.json",
        "--upload-root", "/允许上传的目录"
      ]
    }
  }
}
```

Windows 的 command 使用 `.venv\\Scripts\\python.exe`。不同客户端的配置外层可能不同，应使用它自己的 MCP 配置入口填写同样的 command 和 args。仅支持远程 MCP URL、不能启动本地程序的客户端，不适用此 stdio 发行版；本包没有宣称部署公共 `/mcp` 网址。

验证连接：

```sh
.venv/bin/tools-mcp doctor
.venv/bin/tools-mcp config --upload-root "/明确允许上传的目录" --output client.local.json
```

也可以在 Agent 中调用 `tools_mcp_status`，确认真实成员和可用模块。

## 直接静默上传

安装器默认只允许读取发行目录下的 `uploads/`，把要上传的文件放进去即可。增加其他目录时用 `config --upload-root ...` 重新生成配置；可以重复指定多个目录。目录授权只决定本机文件能否被读取，线上写入权限仍以当前成员为准。没有配置目录时，仍可用知识、HTML 和 Skill 原生工具传入正文，但不提供本机文件上传工具。

例如将 `uploads/实践方法.md` 保存到知识库，先用 `projects_list` 取得当前成员的真实项目 ID，再调用：

```json
{
  "kind": "knowledge",
  "path": "/安装目录/uploads/实践方法.md",
  "projectId": "projects_list返回的真实项目ID",
  "title": "我的实践方法",
  "sourceName": "本人原创：某项目实践",
  "mcpRequestId": "practice-upload-20261020-01"
}
```

使用工具名 `tools_mcp_upload_file`。成功返回 `state=published`、`verification=readback_matched`、文档链接和真实上传者。上传后核对的是保存完整性，不会把知识状态自动改成“已验证”。知识文档对所有已登录中枢成员开放新增，来源说明或来源链接至少填写一项；本人可以修订本人文档，管理员沿用原维护权限。

### 1.0.1rc1 候选：知识元信息与修订

知识 JSON 的 `document`（或根对象）可提供当前 `knowledge_save` 的正文、标题、分类、摘要、tags、status、sourceName/sourceUrl、scope、limitations、evidence、reportHref/reportTitle、skillId/skillTitle。`tags` 按当前服务契约为逗号分隔字符串。文件之外的同名工具参数优先，明确的空字符串用于清空，不能回退成文件旧值。除正文外，这些字段也可与 Markdown 上传一起传入。

修订先读取原条目，只修改需要变化的内容，然后提交完整知识文档的上述全部字段（未使用字段也显式为空），防止省略字段被服务默认值清空。须提供原条目 `id` 与目录当前 `revision`，两者缺一即拒绝；可放在知识 JSON 或工具参数中。例如增加 `"id":"原条目ID","revision":2`，并给这次修订新的 `mcpRequestId`。同一次修订重试保持原请求标识和原参数；409 冲突后先读当前版本再判断如何合并，不能改成新增。它不会按标题自动猜测同一知识。

保存后使用返回的固定版本核对正文、全部已提交元信息、存放项目及修订身份。字段未保留会返回 `saved_verification_pending`，代表可能已保存，不能重建副本；保留原请求标识核对。未知 JSON 字段拒绝上传，避免新知识模型被旧客户端静默裁剪；不要将整个 `knowledge_read` 响应（含 item/version/versions）当作文档正文。

本候选只修复接入保真。业务项目、知识性质和有效性尚无专用后端过滤字段；需要暂用既有分类/标签表达，不能声称后端已支持分页、变化游标或语义采集接续。知识与 Skill 的内容组织仍由 Agent 按方法处理，请求日志只负责传输恢复。

文件类型和限制：

| kind | 文件 | 限额与行为 |
|---|---|---|
| knowledge | UTF-8 `.md`、`.txt`、含 `document.body` 或 `body` 的 `.json` | 1 MiB；还需满足原库完整文档大小限制；须来源 |
| html | UTF-8 `.html`、`.htm` | 2 MiB；保存到指定项目的汇报目录，核对原件 SHA-256 |
| skill | `SKILL.md` 或 `.zip` | 5 MiB；由原 Skill 库检查结构，读回包哈希；不安装、不执行 |

PDF、Word 等先由 Agent 的文档工具提取正文，再调用 `knowledge_save` 或上传转换后的 Markdown。不要把二进制附件当成知识正文。

如果 Agent 已经读取了文档，也可直接调用原生 `knowledge_save` / `html_save` / `skill_import`，不需要上传目录。原生工具字段来自实际 `/capabilities`，写入工具增加了 `mcpRequestId`。账号密码、受保护备注、授权修改和大包原件不会暴露给模型。

## 重试和权限

同一业务请求始终使用同一个 `mcpRequestId` 和完整原参数，新的独立业务使用新的标识。连接器将其映射为当前成员隔离的 API 幂等键；相同标识但不同内容会被拒绝，不会悄悄覆盖。

- `tools_mcp_request_status`：查询原写入回执。
- `tools_mcp_retry`：读取本机记录的原参数继续核对，不重新读取可能变化的本机文件。
- 网络超时、`pending` 或 `saved_verification_pending` 都不能宣称完整上传成功。`saved_verification_pending` 表示保存已确认，额外读回尚未核对；再次调用原上传请求可继续读回，或用原生读取工具核对。

本机私有 `state/requests.sqlite3` 保存请求正文和结果，以便跨进程恢复；不保存认证凭据，Unix 文件权限为 0600。不要把 state/ 或 credentials.json 打进分享包。不要在原请求仍待核对时清除恢复记录。

`serve --read-only` 可限制此连接器只读。权限在每轮调用重新读取，成员被撤销或降权后不能继续写入；不能通过工具参数伪造上传者。Skill 包内脚本、文档内容和素材网页只是资料，不构成额外授权。

六个模块按已发布 API 动态发现：知识、HTML、Skill、账号非敏感资料、素材解析与清单、硬件已发布采购功能。素材清单不等于本地下载成功；硬件记录接口不会下单或付款。星宿及任务大厅回执不属于本包，不会冒用任务大厅内部身份。

退出：

```sh
.venv/bin/tools-mcp logout
```

由本连接器创建的凭据会先在身份权限服务撤销，再删除本地凭据文件。导入的外部凭据只移除本地副本，原凭据由本人在身份权限服务管理；`logout --local-only` 也只移除本地副本。恢复记录继续保留。

## 实现与开发验证

标准 MCP stdio，官方 Python SDK 2.3.0，纯 HTTPS API 调用。stdout 仅输出 MCP 协议，凭据不进入工具返回。没有 Computer Use、浏览器自动化或任务大厅运行时依赖。

```sh
.venv/bin/python -m pip install -e . pytest pytest-asyncio
.venv/bin/python -m pytest
```

协议依据：[MCP stdio 规范](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)、[官方 Python SDK](https://github.com/modelcontextprotocol/python-sdk)。发行验证记录另附，隔离测试不冒充其他真实成员的线上验收。
