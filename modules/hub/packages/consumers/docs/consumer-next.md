# 2.0 消费者 SDK 与员工客户端／旧 Mac 文件工具接入通路

状态：下一版原创代码；冻结220..280与正在部署的领域/server/shared/migrations未由本代理修改。本实现提供可运行SDK/Node24 CLI与集成桥，不表示现有员工客户端移动App或旧Mac产品已更新、发布或验收。

## 范围与真实契约

- H2-BASE-007：持久changes、完整当前授权投影、断网/partial保留旧状态、游标retention重建、权限变化后受管显示。
- H2-BASE-009：旧文件工具通过2.0资料API读取固定版本，改名/写入保留ID与CAS、持久草稿resume/replay，不直写表。
- FLOW006：离线副本、版本/来源基准、重复回传保持同logical key，冲突保留成果，由Agent决定重基/另存/采用。

当前有效主稿没有§3.8标题；按§4.4接入契约、§14.2以及`packages/platform/src/changes.ts`、`migrations/120-worker-functions.sql`、Mem/V8当前2.0路由核对实现。没有读取或复制1.0实现。

真实接口：

| 接口 | 消费语义 |
|---|---|
| POST /v2/changes/snapshot | 一次REPEATABLE READ返回授权aggregate revisions与`delivery_highwater` opaque UUID；coverage=`project_material_and_work_revisions` |
| POST /v2/changes | 当前权过滤的metadata事件；opaque cursor只回传、不解析/自增；coverage=`current_authorized_project_metadata_only`；无业务payload |
| POST /v2/files/read | 精确project/material/version流；服务端发送前再核当前权，客户端整文件hash/size后才发布本地副本 |
| POST /v2/files/read-chunk | 每请求重新核权，最多128KiB，精确range、base64、chunk_sha256和whole fixed ref |
| POST /v2/placements/patch | metadata CAS，logical_path改变不改变固定资料身份 |
| POST /v2/materials/write-text | 一次复合写文本，保留原logical key及durable draft，不把pending当published |
| POST /v2/materials/write-text/resume | 使用已有resume_id与原draft的key；冻结schema不接受额外idempotency_key body字段 |

## 源码职责

- `src/transport.ts`：原生fetch、TLS或literal loopback、redirect:error、当前CredentialProvider、请求通道绑定、受控错误。
- `src/credentials.ts`：沿现有`deploy/mcp-call.mjs`的受控`{token:...}`文件形状；每次重读，O_NOFOLLOW/owner/0600，不在argv或日志放token。
- `src/projection.ts`：完整snapshot、opaque增量、event ID/group/revision补洞及去重。事件只触发刷新，不推导业务/权限或语义关联。
- `src/local-files.ts`：project+channel分区的0700/0600checkpoint与受控固定文件副本；流式hash/size核验后rename，失败清理临时文件且不覆盖已有好副本。
- `src/replay.ts`：原path/body/logical key和fingerprint保留；不自动换key或改基准。对strict resume可以只保header key而不发新body字段。
- `src/adapters.ts`：EmployeeClientConsumer及LegacyFileToolConsumer。员工客户端可用Node侧桥；轻量网页可直接使用transport/projection并注入自己的受控存储，文件系统模块不能直接当浏览器功能。
- `src/cli.ts`：Node24实际HTTP调用；参数是凭据文件路径，不是凭据值。

## 投影、权限与跨账号缓存

首次进入只需一个完整snapshot。已有checkpoint时拉完增量，再取一个完整**当前授权**snapshot作为显示权威；正常无事件时为2个HTTP调用。因为现有feed会过滤新受限资料且不保证向旧读者发出“失权删除”payload，不能只凭零事件保留公开显示。全量读取的是项目内metadata，不是每份原件；大scope预算/分页增强由后续服务契约提供。

短页表示已到此次投递水位；exact-limit继续请求。达到页预算、partial契约、坏JSON、断网、retention后重建失败时，保留旧projection与原cursor，不把空页当删除。状态`offline/partial/gap_pending`明确说明旧快照并非当前权限或业务真相。

完整新授权snapshot才允许删除已不可见的显示项。迟到事件若已被snapshot revision覆盖，不降级；future revision保留pending，后续snapshot补洞。authz或已不在当前授权inventory中的metadata只是历史刷新信号，不成为新的显示条目。相同event ID去重，group冲突不发明业务事实。

本地checkpoint以project ID＋SHA256(service endpoint＋高熵credential)分区，无raw token。指纹是**本地通道隔离**，不是服务端身份证明；真正actor/client仍由身份权限服务核验。请求期间每次重读provider并比较expectedBinding，阻止A→B→A混入其他通道响应。渲染时`await consumer.view()`也重查当前通道，不能只在poll时检查；恢复的旧同通道视图标offline。

401/403或本地凭据通道改变时，受管view隐藏；持久旧数据和此前下载字节不谎称已收回。相同通道断网保留旧数据、标unknown/stale覆盖，不一律抹除。`exportCheckpoint()`用于受控持久化，不是UI渲染接口。

## 员工客户端与文件工具的调用

```ts
const bridge = await EmployeeClientConsumer.open(v8Api, projectId, checkpointStore);
const view = await bridge.refresh();
// UI renders await bridge.view(); keeps status/warnings/checked coverage visible.
// Work details still call current-authorized /v2/work-items/read.

const files = new LegacyFileToolConsumer(memApi);
await files.readFixed(fixedReference, controlledDirectory, {chunkBytes:131072});
await files.renamePlacement({project_id,placement_id,expected_revision,logical_path}, logicalKey);
await files.resumeText({project_id,resume_id}, originalLogicalKey);
```

Provider可接当前受控文件或应用的受控凭据渠道；不要由业务body选择actor，不为了接入新增设备注册门槛。缺少native来源header时保持unknown，业务原始来源可在允许的properties/declaration保存，不假装证明原生线程。

固定引用至少包含`project_id/material_id/version_id/sha256/size`。下载不根据逻辑文件名选择latest；改名不改变本地固定版命名。全文件模式的资格窗口是发送前复核，不保证途中即时中止；可选chunk模式每次请求freshcheck，仍不能收回已传字节。任一chunk失权/错hash/range/size，中止、不发布半份本地文件。

服务返回未评估关联、陈旧但仍有权来源或来源未齐，SDK不硬编码相关/重要/采用/删除判断；Agent看warning、理由与原件后作选择。

## Node24构建与CLI

在hub2目录，用Node24：

```sh
node node_modules/typescript/bin/tsc -p packages/consumers/tsconfig.json
node --test tests/consumers-next.test.mjs
node packages/consumers/dist/cli.js sync --credentials-file /受控目录/member-client.json --service v8 --url https://新入口 --project 项目UUID --state-dir /受控目录/view-cache
node packages/consumers/dist/cli.js read-fixed --credentials-file /受控目录/member-client.json --service mem --url https://资料入口 --ref-file /受控目录/fixed-ref.json --cache-dir /受控目录/fixed-copies --chunk-bytes 131072
```

CLI不自动写旧客户端配置、更新App或部署。URL不允许user/password/query/fragment，HTTP只允许loopback。身份文件及fixed-ref输入是当前用户拥有的0600普通文件，state/cache目录0700。POSIX受控文件Provider适合本轮Mac/Linux，其他平台应注入对应受控Provider，不宣称Windows文件保护已验。

`--url`是服务base，可为独立origin或已有反向代理的`https://入口/mem`、`https://入口/v8`前缀；SDK保留该前缀后拼接固定`/v2/...`路径，不跳到另一服务。

需要断网后同逻辑操作回传：先`prepare-replay`把body/key/fingerprint保存到0600操作文件，再`replay`；网络异常/部分成功/409时保留此文件，查询原operation或用同文件重放，不生成新key。strict resume命令用`--body-key false`，不向冻结schema注入额外字段。

```sh
node packages/consumers/dist/cli.js prepare-replay --credentials-file /受控目录/member-client.json --service mem --url https://资料入口 --api-path /v2/materials/write-text/resume --logical-key 原逻辑键 --body-key false --body-file /受控目录/resume-body.json --operation-file /受控目录/resume-operation.json
node packages/consumers/dist/cli.js replay --credentials-file /受控目录/member-client.json --service mem --url https://资料入口 --operation-file /受控目录/resume-operation.json
```

`--resync true`可请求重取授权snapshot。它只替换完整授权metadata，不决定资料归属/语义或清除已下载副本。

## 本轮验证与后续

Node24.19.0严格独立构建与全仓库noEmit通过；消费者专属测试覆盖半页、断网、retention、迟到/重复/group冲突/revision gap、失权、跨账号与endpoint缓存、请求中换凭据、redirect不转发Bearer、固定hash/size/中断、分段失权、同key回放和strict resume。

真实Node24 CLI子进程调用本地HTTP的2.0协议fixture，执行初始snapshot、第二轮opaque changes、固定文件流，并核验磁盘字节；测试身份与资料均合成。这个验证**不是嘉兴当前原生数据库/真实成员权限或COS**，不是已升级的员工客户端设备/旧Mac产品验收，也没有实施旧`/f/`门面或全旧链接映射。

下一版主控合并后，需要在实际受控2.0服务上跑同命令及权利收缩、网络恢复、当前成员/客户端切换和真实旧工具整合；保留现有部署与冻结包边界。代码与测试handoff/hash在consumer-next证据目录。
