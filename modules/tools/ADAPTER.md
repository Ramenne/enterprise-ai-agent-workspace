# tools 原创2.0适配

本项目src仅本项目原创入口/hooks；共享Gate/身份上下文归Hufu工程源码。原1.0业务模块来自原安装目录，仅引用运行，不复制到本repo。

使用现engineering.execute write/commit/build/deploy/rollback/operation，固定python_compat profile。源码编译/导出在hubeng-tools身份下，运行继续原业务独立UID，无成员sudo/任意unit/path。dist构建artifact必须属于当前已提交commit。发布仅本项目已运行hufu2单元；失败恢复上版，业务数据保留。
