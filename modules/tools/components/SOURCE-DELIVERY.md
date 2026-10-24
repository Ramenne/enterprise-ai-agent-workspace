# FF AI客服与闲鱼管理实际源码协作入口

本目录由杰按用户明确的YYY接手授权，从FF服务器2026-10-21实际源码取回，供FF和YYY在既有工具团队工程内读取、修改、提交和Git合并。

- ai-customer/：来自FF服务器/opt/xianyu-lab/source，闲鱼自动回复、AI回复、多账号与商品业务源码。
- accounts/：来自FF服务器/opt/xianyu/current，当前工具集与账号管理Node源码；保留原工具团队范围。
- SOURCE-MANIFEST.json：原路径逐文件摘要；未携带Git历史，因此本次提交是实际快照导入基线，不冒充FF原始提交历史。

使用现有Hufu /v2/engineering/execute，project_id=69197d56-41b0-4c8b-ac19-181f63e87c1f。read/write/commit对应本工作区；command可在项目身份下执行git diff、git branch、git merge等。合并权限沿resource.write，不存在另外的Git托管站账号。

FF原生产文件没有覆盖或重启。现有core build/deploy仍是旧python兼容入口，不能把它当作本目录Node/闲鱼源码发布；本次交付是源码协作，生产发布按实际产品资源继续接线。成员数据、Cookie、环境密钥、数据库、依赖、日志不包含在本快照中。
