# 身份权限服务 · 数据库权限分发

适用系统版本：2.8.0 · 文档修订：2026-10-18

## 统一归属

数据库对象发现、权限申请、审批、有效权限查询、撤权和授权审计全部由身份权限服务主管。数据库执行服务是身份权限服务组件，数据和授权记录仍按各自职责保存。资料存储服务、V8不另建平行授权系统；PostgreSQL角色和GRANT/REVOKE是身份权限服务决定的执行结果。

MCP地址：`https://hufu.example.invalid/mcp`。使用 `hub.tools(query:"database.")` 发现该功能组；通过 `hub.invoke` 调用 `database.*`。也可用 `hub2_api`，`system:"hufu"`，路径 `/v2/database-access/`。以下接口均已上线。

| MCP工具 | 功能 |
|---|---|
| `database.help` | 实际参数与边界说明 |
| `database.objects` | 列出指定项目的数据域及实际表名 |
| `database.apply` | 为当前本人申请具体表与动作 |
| `database.requests` | 本人的申请，或管理员的待审批申请 |
| `database.decide` | 当前管理人批准或拒绝申请 |
| `database.permissions` | 本人授权；`view:managed` 查看当前管理范围的成员授权 |
| `database.revoke` | 撤销具体授权 |
| `database.inspect` | 读取已获准表的字段、约束、索引、RLS规则 |
| `database.query` | 查询已获准表的数据 |
| `database.mutate` | 新增、修改或删除获准记录 |

## 申请和审批

1. 确认当前MCP身份，查找项目并调用 `database.objects` 获取真实表名。
2. 申请对象包含 `schema`、`table`、`actions`：`inspect/select/insert/update/delete`。用途和期限需明确；同一提交沿用 `idempotency_key`。
3. 只查结构可申请 `inspect`。直接读取或修改表内数据，须明确 `data_scope:"whole_table"`。这代表整张表的数据权限，不能误称只查看本人资料。普通私人行范围读取继续走资料存储服务/V8的业务接口。
4. 管理Agent读取 `database.requests(view:"pending")`，向本人说明实际范围，依本人决定调用 `database.decide`，携带 `request_id`、`expected_revision`、`decision`。本版本批准原申请范围；需要缩小范围时拒绝或让申请者修订后重新申请，不在批准文字中暗示已改变技术权限。
5. 管理验证不足时，复用身份权限服务 `/v2/engineering/management/challenge` 和 `/verify`，邮箱验证码确认真实管理主体。可指定项目，也可在已有管理范围内作一次确认。普通已获准查询/修改不重复验证码。
6. 批准后生成独立数据库受限角色，不授予服务器、owner、工程部署或转授权权限。不需要给Agent数据库主密钥。

资料存储服务项目：`2a2817e6-2f04-42ff-a97b-56417c451af8`，数据域 `mem`。
V8项目：`4e14ec27-e8b0-4d2e-a106-489c25efc29d`，数据域 `v8`。

申请示例（替换为 objects 返回的真实表）：

```json
{
  "project_id": "<项目编号>",
  "objects": [{"schema":"mem","table":"<表名>","actions":["inspect"],"data_scope":"structure_only"}],
  "purpose":"核对字段、约束、索引和权限结构",
  "requested_until":"<带时区的未来时间，最多30天>",
  "idempotency_key":"<本次申请的稳定提交标识>"
}
```

## 查询与修改

查询接受 `project_id/schema/table`，可加 `columns`、`where`、`order_by`、`limit`、`offset`。每页最多200行；结果不是固定完整快照。过滤为数组，例如 `[{"column":"id","op":"eq","value":123}]`；支持 eq/ne/lt/lte/gt/gte/in/is_null。不接受任意SQL或用户指定数据库角色。

修改接受 `action:"insert|update|delete"`，新增/修改提供 `values`；修改和删除要求非空 `where`；携带稳定 `idempotency_key`。返回真实影响行数，重复提交相同请求返回已有结果。返回值不包含被修改行的正文。UPDATE/DELETE条件涉及的字段可能同时需要SELECT权限，申请时一并明确。

历史版本、原件身份、来源及固定成果等不可变记录不提供直接表写入；`database.objects` 返回 `direct_write:false` 时沿用业务接口维护。其他可直接写表仍受现有数据库约束和授权限制。

## 调整、撤权与到期

管理人可用 `database.permissions(view:"managed",project_id:...)` 查真实授权，再调用 `database.revoke(permission_id:...)`。权限拓展或替换通过新申请/审批；需要收窄时先撤销旧授权，再批准新的范围。已有宽权限不会因新增一份窄权限而自动消失。

每次操作实时校验成员/软件、项目、授权状态、批准来源、期限及对象身份。到期立即拒绝新操作，后台每30秒清理过期的物理角色。正在执行的事务最多8秒查询预算；撤权可能等待其结束，并不回滚此前已完成操作。

## 本版本边界

- 支持数据库具体表的结构检查和增删查改授权。
- ALTER/DROP等表结构维护及进一步管理委派，仍走独立工程/管理通路，未在此包装成普通表权限。
- 直接数据授权为明确批准的整表范围；未提供新的逐行/逐列权限编辑器。
- 对单表检查，返回相关列、约束、索引和RLS规则；任意函数源码导出、跨表联查及任意SQL执行暂不包含。
- 新表和删除后重建的表不会自动继承原具体表授权。
- 身份验证沿用身份权限服务当前流程，只有实际验证成功才记录OTP登录。

历史版本与变更记录保存在正式发布档案；通过 POST /v2/manuals/read 提供本篇 id 和指定 version 可读取对应冻结正文。
