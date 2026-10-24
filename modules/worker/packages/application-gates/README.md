# 已运行原创2.0适配 · 固定工程发布

## 工程归属

|工程项目|真实项目源码|固定小陈服务/运行UID|
|---|---|---|
|白泽|baize/repo/src/baize_entry.py、baize_grant_hook.py、baize_grant_routes.py|hufu2-baize-compat / baize /18000|
|工具|tools/repo/src/tools_entry.py、tools_resource_bridge.py、tools_mcp_bridge.py、tools_file_navigation.py|hufu2-tools-compat /fgb-collector-poc /18767|
|机灵|jiling/repo/src/jiling_native.py|hufu2-jiling-compat、hufu2-jiling-ws /jiling-relay /4635、4634|
|共用Hufu|hufu/repo/packages/application-gates/backend/shared/|application_gate、native_identity_bridge、caller_context；以上四个新单元|

repo前缀为嘉兴 `/srv/workspace`。原1.0代码仅从原安装路径引用，不复制、不改动。新项目包不能携带三共享库文件；共享库由Hufu工程维护。原1.0/旧公开入口继续保留，切换选择待用户决定。

## 当前caller工程接口

沿现 `POST /v2/engineering/execute` 与 `operation`，不用新身份/授予/验证码。

- 三应用：原 write/commit/build/deploy/rollback/status/logs/service 动作。build固定编译src/*.py并记录当前commit；deploy要求干净repo和当前commit产物；仅本项目固定新单元。service仅固定本项目单元，不接受caller提供unit/path。
- 共用Hufu：正常commit后，build/deploy/rollback 的 parameters 为 `{component:"application-gates"}`。只编译/同步固定三共享源，重启以上四个新单元。parameters={}仍原Hufu core动作，不因普通core deploy额外发布这些应用。
- 每个效果保留idempotency_key，受理后沿operation_id查询最终效果；未知效果不盲重发。源码可回退，业务数据不回滚。

build/导出在既有hubeng-项目OS身份及私有文件分区执行。成员代码运行在已有baize/fgb-collector-poc/jiling-relay；root仅接受有界源码数据、固定文件/发布目录/symlink及固定systemd操作，不编译/import/执行项目Python。密钥仍既有private配置，沿已有14629 tunnel/key，无token进入repo。

## 固定安装与回退

小陈 `/srv/workspace`，unit仅新增30-engineering-release.conf覆盖原创2.0入口路径，旧cwd/依赖/配置保留。初始原创seed保留。项目release/current与shared/current分开更新，不把各项目代码混进其他项目工作区。回退只切相应源码指针并重启相应新单元。

fixed control source：application_release.py（小陈），application_release_route.py（嘉兴），install_controller.py/install_shared_branch.py（控制分派），install_profile.py（固定四单元与原创seed安装）。这些只归Hufu维护源；安装没有私有配置副本。

## 实际执行

同本人actor与原construction软件通过公开工程链完成三项目commit/build/deploy。白泽3032139、工具d637f4a、机灵ed03790。第一次发布发现运行器UMask0077使release目录700，明确修复chmod755并加入reset-failed，保留原失败证据。修复后真实deploy分别 b817b1d7、68cf406a、9980dfeb，均completed；四新单元active且固定loopback端口可连。首轮失败与修复后的成功不能合并声称首次成功。

证据本地 `authorization-execution-20261006/evidence/application-own-*.json`。仅必要工程通路/运行核查；未重启旧1.0，未读改成员私人资料，未启动暂停产品，未发送验证码。服务ready证据为active和loopback端口，不宣称每个业务接口或旧身份入口已切换完毕。

共享Hufu实际commit e0f6f28f27bfc0760c44c6a38f92830306007e72，component build ba4dedab、deploy82e1128e均completed。shared/current切到e0f6f28f27bf-2e5585bcb180；只重启四新单元，core仍9188419。初始install_profile是一次root受控原创bundle初始化，归档调用需明确源bundle路径（shared/与三项目src/）；常规维护直接沿实际工程component通路，不需要SSH安装Gate。
