# SQLite受控后端 · 2026-10-06

## 当前落地

- `zm-xiaochen` `/srv/workspace`、`sqlite_runner.py` 已安装；runtime loopback 的 `database_sqlite` 固定分派已接入。SQL在项目服务OS用户 `baize` 下运行，固定只挂 `/opt/baize/data/baize.db` 所在目录及专用操作收据目录。成员不取得DB文件、路径选择、shell或sudo。
- `zm-jiaxin` engineering_executor 已加入 `database_sqlite` 分派及 `sqlite_route.py`，只使用既有 xiaochen tunnel/固定服务认证。主集成已协调重启，当前分派生效。
- SQL827/828及14张表真实CREATE指纹目录已安装到中央PG。新表/函数归属现有 `hub2_authz_owner`；旧before_sqlite函数保留原ACL并精确允许内部owner调用。后端角色仅得到所需原申请/许可/效果表操作权限，无PUBLIC或成员直接表权限。目录登记不授予成员权限。现有 database_requests/permissions/effects 承接申请、主管确认、到期、撤销、操作编号和结果状态。
- 当前Hufu工作区已新增 `packages/sqlite-database-access/src/http.mjs`、声明与 `apps/hufu/src/start.ts` 的独立 import/install。主集成已提交、构建并部署版本 `0e859d7`，公开执行链已通过。

## 接口及权限

真实Bearer调用：

- `POST /v2/database-access/sqlite/inspect`：`{project_id,schema:"sqlite_baize",table}`。
- `POST /v2/database-access/sqlite/execute`：`{project_id,schema:"sqlite_baize",sql,parameters?,idempotency_key?}`。写入必须有操作编号；支持正常单条SQL及参数。
- `GET /v2/database-access/sqlite/help`：当前调用说明。

现有数据库目录/申请/待办/决定/撤销路径沿原框架使用。结构需inspect或select资格，insert-only不包含结构读。数据审批必须明确 `whole_table`（表内全部数据），不是个人行范围。软件过滤、原审批者当前管理来源、当前actor/client及期限持续有效。

允许申请整表数据的实际表只有 `capture_layout_preferences`、`daily_runs`、`processing_jobs`；其维护状态/错误文本也属于审批的数据范围。禁止修改 hufu_user_id/user_id/resource_owner/grantee 等归属字段。其余11表包含原始录音、逐字稿、会话、汇总、旧授权/控制资料，仅结构检查，个人资料访问继续原业务owner/中央业务grant通路。项目read或manager不会代替个人owner同意。

## 执行及审计边界

- SQLite authorizer逐表/动作检查真实SQL，包括触发器与级联；未授权的关联表拒绝。成员不能PRAGMA、ATTACH、DDL、扩展或读写任意文件。
- authorizer安装前在事务中缓存CREATE指纹；只在SQL实际触及表时检查，缺失/替换表拒绝。inspect仅检查目标表。全库schema_cookie只作目录观察，不因为其他表结构变化阻塞当前表。
- SELECT结果只回当前获准caller。服务路径禁请求日志；中央/本地操作收据保存query摘要hash、动作、表范围、影响行数及操作编号，不保存SQL参数或结果行。响应限制200行/1MiB，明确partial，需SQL分页。
- 超时与未知效果保留状态，不能盲重发。跨SQLite业务DB与收据DB不能声称WAL崩溃场景下严格原子 exactly-once；中央先占位阻止未知操作自动再执行。

## 必要核查及留存

本包已做源码语法检查、实时目录/权限元数据核对、中央SQL安装和固定worker同步。本包施工未新授成员资格、未读写原成员私人行、未启动暂停应用、未发验证码。Root沿原请求 d582... 实际完成本人申请→Native管理软件仅批准inspect→结构200→行读取table_or_action_not_approved→撤权200→新inspect database_permission_required。另一本人明确临时whole_table授权13688...完成一条合成维护记录INSERT/UPDATE/DELETE各1行，记录已删除且许可已撤销。真实证据由Root保存在 evidence/sqlite-own-*；没有读取或修改原成员数据。

安装顺序：xiaochen运行 `install.sh`；安装827、828与真实 `baize-register.sql`；沿本次已接的固定runtime/engineering分派；Hufu合入独立module并安装一次 `installSqliteDatabaseAccess(app,{pool,runtime})`，其中runtime复用 `resource_execution_key`；协调engineering restart，发布Hufu。

## 工程源码归档

Hufu模块 `packages/sqlite-database-access/migrations/` 包含最终827/828及829发现指引；`backend/`包含worker、runner、固定route、installer，无私有cfg/密钥。安装脚本在归档中复用已安装的root配置；新机器必须由受控安装者提供根配置，成员不能填写任意DB路径。README与源均供Hufu项目工程维护。829只补catalog PostgreSQL domains标记及SQLite真实发现/分流路径，不授权。统一help的schema取objects真实响应，SQLite使用独立inspect/execute而非PG路由。当前归档/指引改动尚由Root进行最终source提交/发布。
