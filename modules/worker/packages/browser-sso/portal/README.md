# 原创应用浏览器SSO薄桥

复用Portal2.0已有实际本人中央会话、一次ticket/state、consumer验证、host-bound AES-GCM cookie。没有生成新成员/软件token，没有控制器代替本人，Bearer/MCP调用继续优先且不从cookie自动升级身份。

- 新网页入口：https://baize.example.invalid/hufu2/start%E3%80%81https://service.example.invalid/hufu2/start%EF%BC%9Bcallback%E5%9B%BA%E5%AE%9A/hufu2/callback%E3%80%82%E9%97%A8%E6%88%B7%E6%96%B0%E5%A2%9E%E4%B8%A4%E6%96%B0%E5%85%A5%E5%8F%A3%E5%8D%A1%E7%89%87%EF%BC%8C%E6%97%A7%E6%AD%A3%E5%BC%8F%E5%8D%A1%E7%89%87/%E8%B7%AF%E7%94%B1%E4%BF%9D%E6%8C%81%E3%80%82
- 新target baize_hufu2/tools_hufu2仅固定应用/host，旧baize target仍旧callback。
- __Host-hufu2_session加密、HttpOnly/Secure/SameSite=Lax、无Domain；Portal持原加密key，产品不共享该key。sealed payload绑定target/application/host、原本人中央cookie与原到期（最多原8小时）。consumer服务key只是固定应用认证，不是成员proof。
- 每次cookie业务，产品→中央/check→真实get-session+me→固定app decision，再原gate项目/主体/期限检查；当前Owner数据事实与中央个人grant继续内层生效。无会话返回明确login_path，失效不假装登录。
- 原旧cookie若有效必须与当前native主体一致，否则拒绝；成功后不清除有效旧cookie，不切断旧正式登录。只有已认证为失效的旧cookie，在新本人登录成功时清除本产品旧cookie。
- Cookie unsafe请求要求精确Origin。工具根GET带query可能采集，保守作为write，同源GET导航可用Sec-Fetch-Site=same-origin；不是逐动作审批。根无query/其他读取不提升write。现Bearer同样对根GET+query走原项目write资格。
- 产品cookie不能在另一target/host兑换；不当通用Bearer。内部返回的授权是同一次真实本人会话原proof，不是controller/manager凭据，也不新发软件资格；每次资格/软件过滤仍取中央当前结果。

源归Hufu packages/application-gates/backend/shared + packages/browser-sso/portal；产品cookie名/旧cookie解析归各自src入口。共享Gate新增一个固定原创Python文件，原application-gates component构建/发布。Portal新增target/module/navigation以原可信Root安装配套；公开patch/install源保留，私有consumer种子/Portal key不进repo。

当前桌面/原头调用客户端仍需自身实际2.0Bearer接入；网页cookie桥不会替未登录的人制造会话，也不替机灵未知旧pair建立所有权。旧公网是否切新后端仍待用户选择。
