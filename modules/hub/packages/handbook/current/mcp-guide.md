# MCP与API · 实际调用说明

适用系统版本：2.10.0 · 文档修订：2026-10-21

## 默认行为
已知工具与参数可直接调用，无需每次发现目录、重读说明或重新建立管理上下文。入口保留协议、会话与真实主体识别所需的身份核验；只在同一请求内复用身份解析，不跨请求缓存允许结论。原生MCP入口与领域服务各自必要的检查继续执行，旧身份桥每次按实际凭据验证。
中枢网页和MCP的资料保存、接续、读取等组合操作共用应用用例，已登记的领域调用直接交给所属HTTP服务。普通程序可以直接使用已选择的公开API，不要求先调用MCP或补齐Agent留痕。普通工作响应不附带整份work_policy，需说明时GET /v2/work-items/judgment-policy。

## 接入和渐进发现

入口 `https://hufu.example.invalid/mcp`；确认 `hufu_whoami`、`hufu_context`，优先读 `handbook`，再从 `function-index` 或 `GET /v2/manuals/catalog` 按任务选择说明书。通过 `hub2_api` 读取：`{system:"hufu",method:"POST",path:"/v2/manuals/read",body:{id:"handbook"}}`。

`hub.tools({})` 查看功能组，`hub.tools({group:"materials"})` 展开功能组，`hub.help({tool:"hub.document.save"})` 读取契约，`hub.invoke({tool,arguments})` 调用。旧别名 `hub_help` 等以当前客户端实际工具列表为准，已知契约直接调用，参数不明确时按需读取帮助。直接 API 使用 `hub2_api`，system 为 hufu、meng 或 v8；公开调用不使用 /internal。

## 身份和权限

同一成员不同有效 MCP 使用当前账号已批准项目资格，普通个人项目、工作及资料不重复申请客户端动作。专项资源与管理动作检查实际资格、范围、期限和供应商条件；服务身份保留其自身动作与资源限制。目录、历史软件动作数组和说明书不授予权限。拒绝时按 error_code 定位实际缺口，不切换项目 MCP 或借用他人身份。

## 正确格式和固定引用

工作阶段保存优先复用 `v8.work.read` 返回的 `work_item` 对象：可作为 `v8.work.save` 的 `work_item` 输入，平台使用 id/revision；也可显式填写 work_item_id、expected_revision。固定引用直接复用工具返回的对象，兼容 size、项目/显示元信息，平台归一后执行；不要求成员手填 hash。工作编号查找可用 W前缀、#前缀或旧数字，返回真实工作身份；文件新显示格式以实际查号工具为准。

兼容处理只做可确定的别名、冗余内部字段和类型转换。目标不一致、删除对象或覆盖版本不能猜测；按当前错误显示差异与下一步。合法旧格式的 request_hash/phase 等内部冗余由平台重算，不当作客户端授权证据。

## 效果和恢复
同一写入重试沿用服务返回的operation_id、resume_id或原幂等标识；unknown/pending先查询原操作，不换键重发未知效果。内容保存、工作登记、简介和索引各自报告结果，附加步骤失败不倒推原件保存失败，也不再次上传已保存原件。
身份无效或到期为401，当前权限不足为403，版本或目标冲突为409，依赖繁忙或不可用为503；以error_code、retryable和原操作状态决定下一步。revision_conflict先回读当前版本；known_archive_copy_required表示需要已有且匹配该固定版本的归档操作，应核对操作和目标而非盲目重试。HTTP 200也必须检查业务state、fixed_ref与receipt。
正文、历史与候选按next_cursor/next_offset接续；目录、简介、摘要和裁剪视图不冒充完整原文。固定引用保留原版本，当前权限仍可变化；寻址结果和缓存不是授权证据。

## 成员工作查询与实体任务板
成员查询按需求选择 `member-work` 或 `task-points` 手册，使用现有 `hub2_api`：
```json
{"system":"v8","method":"POST","path":"/v2/member-work/list","body":{"limit":30}}
```
通过 `hub.invoke` 时外层为 `{tool:"hub2_api",arguments:上述对象}`。成员工作四个读取路径不是四个新的MCP工具名；契约读GET `/v2/member-work/help`，任务/积分契约读GET `/v2/board/help`。
复用列表给出的ref和next_cursor，不手造另一套业务编号。body的字段和来源ID按该模块手册；不能把任务ID当认领ID，也不能仅凭同名选择任务。理解空缺或后台不可用不代表成员没有工作。普通 `v8.work.save` 默认不生成短期上下文，需时显式请求；追加声明与主工作实际状态分别看work_state/completion_applied。

## TOOLS工具合集：统一入口

现有中枢MCP已接入 `tools.library`，无需另装独立TOOLS MCP或配置共享成员令牌。先通过以下调用取得本人当前可用操作与原生参数：
```json
{"tool":"tools.library","arguments":{"action":"help"}}
```
外层调用是 `hub.invoke`（本客户端兼容名可为 `hub_invoke`）。`action:"call"` 的 `operation` 使用help返回的名字；`arguments`填写该操作的原生参数。例如：
```json
{"tool":"tools.library","arguments":{"action":"call","operation":"knowledge_list","arguments":{"query":"关键词"}}}
```
六模块为素材下载、账号管理、HTML管理库、Skill管理库、知识文档管理库和硬件采购；用 `tools_modules` 查模块状态。模块总览可能列出业务全量操作名，只有help返回的本人可用操作才是统一工具调用契约。目录及模块可用不代表所有业务已经逐项验收。

读取知识先 `knowledge_list`，再用返回的id调用 `knowledge_read`；固定历史可传version。写入知识用 `knowledge_save`，依原契约填写projectId、title、body及sourceName或sourceUrl。项目存放权限与业务项目标签分别表达；不从同名推定权限或复制正文。

写入在tools.library外层提供稳定 `idempotency_key`（8—120位字母数字及 `_.:-`）。相同业务重试必须保留同一key和完整原参数；相同key改变参数会冲突。未知结果先查询：
```json
{"tool":"tools.library","arguments":{"action":"operation","idempotency_key":"原请求标识"}}
```
按原结果决定恢复，不换key重写；保存成功不等于知识方法已经验证。原生知识接口会裁剪正文首尾空白，精确字节需求应保存到文件资料并保留固定引用，不能承诺该知识接口逐字节保留所有首尾空白。

凭据来自本次已认证请求，上游再核对本人身份与当前权限；不接受工具参数指定actor或Authorization，不共用FGB/JIE令牌。密码、受保护备注及成员授权等禁止能力不进入可用目录，按实时help为准。不会因导入Skill包自动安装或执行其脚本；本机路径不是服务器可读取的文件，上传使用正文、HTML内容或契约允许的Base64。

## 通过TOOLS下载用户指定视频

只处理用户明确给出的作品或选中素材。通过 `tools.library` 的 `action:"call"` 按以下顺序调用：
1. `media_capabilities`，读取当前服务状态和调用端落盘边界。
2. `media_parse`，原生参数 `{ "text":"用户指定链接" }`，外层提供稳定idempotency_key。返回accepted仅说明解析已受理。
3. `media_job_status`，参数 `{ "id":"解析返回的job.id" }`，等待解析完成，并检查errors/issues及works里的素材。
4. `media_download_manifest`，参数 `{ "jobId":"同一任务id", "mediaIds":["明确选中素材的id"] }`。
5. 调用端按清单从来源站点实际下载，再核对本地路径、文件大小、音视频流和时长。B站可能返回独立视频与audioUrls，需要调用端无转码合并；只下视频轨不能宣称已取得含声音的完整视频。

清单返回 `delivery_required`、`downloaded:false` 是正常边界：TOOLS没有在调用者电脑上落盘，也不能返回虚构本机路径。任务约保留30分钟，来源URL可能更早过期，不能当永久下载地址。带签名的临时URL、Cookie和令牌不写共享报告；本机文件默认不自动上传中枢。工具不替用户取得付费权限或绕过站点访问限制。

2026-10-21实测覆盖：知识写入/读回/同key重放和冲突、发布后原回执恢复、认证与受限操作拒绝，以及用户指定B站视频的1080p音视频下载合并。多成员及撤权是隔离测试，不冒称全部成员和全部平台生产实测。详见工作#1000347、F-1009325-001及F-1009330-001。

## 工作编号直查

```json
{"tool":"hub.work.resume","arguments":{"work_no":"0237"}}
```
同一工作支持1000237或W-1000237；已知project_id/work_item_id也可直接接续。默认返回overview、latest_progress、unresolved和key_outputs；近期固定成果默认窗口3项并带当前元数据/读取参数，优先最近阶段。通过include_history:true展开历史，或沿返回的v8.work.read/history/page读取；include_context:true才构建可选上下文。
latest_progress是成员/Agent最新有权声明；unresolved为空不证明旧问题已解决；key_outputs是近期声明的成果，不是全量历史或自动采用。状态取当前work state，不能用旧completed回执覆盖后来状态。

## visual绘画、LoRA与视频

用hub.tools({group:"visual"})展开13工具：visual.capabilities、visual.image.preview/generate、visual.lora.resolve/import/list/get、visual.job.get、visual.output.get、visual.video.capabilities/preview/generate、visual.training.plan。调用前从capabilities确认真实路由和限制，preview只预检；generate是实际可能计费的提交。

```json
{"tool":"visual.image.preview","arguments":{"prompt":"A blue ceramic bird on a wooden desk","demand":"batch","width":1024,"height":1024,"seed":42424242}}
```
统一图像当前为Krea2 Turbo FP8，8步、CFG1、Euler/simple，尺寸512..2048且16倍数，总像素不超过2097152，seed不超过4294967295，一次一个兼容LoRA。原Krea HTTP适配器capabilities允许8倍数；统一visual层采用更窄的16倍数共同契约，不能把两个入口的范围混写。当前不支持参考图片输入或图像编辑；“视频参考图”指生成后的用途，图库选图是提示词来源。
Civitai链接先visual.lora.resolve/import，按返回ID用visual.lora.get等到ready；中枢生产只把链接交Cloud导入，不直连Civitai。当前Krea2兼容safetensors单LoRA，按固定模型/版本/文件身份及实际执行端状态校验。Cloud ready不证明AutoDL已导入同一权重；不能为切路删掉指定LoRA。
生成时按实时契约提供稳定UUID idempotency_key、generation_authorized:true及实际估计/预算；estimated_credits和budget_credits是调用方预算检查，不是实时价格或供应商硬封顶。用visual.job.get({kind:"image",id:"原任务UUID"})查原任务，按返回asset_id用visual.output.get取得原图MCP image；视频kind为video，下载路径仍需当前身份。
当前线上capabilities：批量生图autodl_if_ready_else_comfy_cloud、零散生图comfy_cloud、视频comfy_cloud_only、训练autodl_only；AutoDL state=not_connected、ready=false，实际现可用执行端为Cloud。新的“同一队列等待60秒后才回退Cloud”已提交源码但尚未部署，不按新策略承诺线上行为。任何已经固定provider或可能提交的任务只查原端，未知结果不跨端重发。
visual.video.capabilities当前返回原生MiniMax H3 Ref2VA Turbo4、352P/544P、最长15秒、必须参考视频、最多9张参考图；先preview，获实际生成授权后再generate。visual.training.plan只产计划，不能执行训练、租卡或自动开机。本次文档核查没有新增付费生成。

## gallery生成、自动回库与反馈

hub.tools({group:"gallery"})当前17工具：原8项publish/list/get/annotate/keywords/keyword.link/recipe.save/recipe.list，新增generation.capabilities/preview/create/get/sync/list、feedback.add/list、provenance.get。
共同链路为：读取原作→选择真实固定片段post_id/slice_id/revision→recipe草稿→gallery.generation.create→visual执行→gallery.generation.sync→自动回库→gallery.feedback.add→gallery.provenance.get→下一版草稿。完整实际prompt与参数保留，中文译文不替代模型输入。
create按当前契约提供稳定UUID、实际prompt、真实sources及预算；后台受理后用sync({id:"原UUID"})查询、取图和回库，published才表示完成回库，返回真实post_id/url。get只读本地记录；archive_pending只恢复取图/回库，不能重新生图。重复同UUID生成和同步应沿原任务/原作品。

```json
{"tool":"gallery.feedback.add","arguments":{"post_id":"实际作品ID","body":"实际看图后的观察","source":"agent_observation","idempotency_key":"稳定反馈标识"}}
```
点评复用原comments正文；agent_observation、user_quote、web_comment区分来源，作者取当前身份。user_quote必须确有用户原话，仍属调用者声明，系统不证明人类来源。相同成员同键同内容返回原点评，变更内容409；不自动训练、改Skill或生成下一张。provenance读取固定来源、实际参数、草稿和点评；缺失历史参数返回缺失，不能补猜。recipe.save保存下一版草稿不扣生成费用。
Cloud真实闭环依据F-1009213-001：任务bfe4810d-f387-4993-a225-4020e43f05f3，512方图+LoRA、2条固定来源，作品46fac8df-a208-4882-a122-fe1e66c9189c；原图MCP读回与画廊SHA一致，重放未重复生成/回库/点评。此为既有特定样本实测，不能推定所有模型/未来请求成功。当前画廊网页身份及默认生成提交配置仍待补齐，接口闭环成功不等于所有网页账号已可直接付费生成。

## 员工客户端查询与发送

当前单一工具名employeeclient；action=help取得参数，可用members、conversations、messages、message、send、send_file，不再列已经退役的多工具候选。沿当前成员身份调用，查询不标记已读；默认assistant为本人文件传输助手。group或他人必须由用户明确选择，私聊username取members返回的真实actor_id，不推测姓名映射。

```json
{"tool":"employeeclient","arguments":{"action":"messages","arguments":{"target":"assistant","limit":20}}}
```
写入在工具外层带稳定idempotency_key；send的arguments含body和明确target，回执message才算已发送；未知结果用message_id查询，不换键群发。send_file只接受当前本人有权读取的员工客户端项目固定材料material_id/version_id/sha256，当前1字节至2MiB；不接受任意URL、本机路径或Base64，更大附件仍用产品上传。需要给别人或群发消息时必须有用户实际授权。
HTTP基础入口https://employeeclient.example.invalid/business/v1/integration%EF%BC%8Chelp%E5%88%97%E5%90%84%E8%B7%AF%E7%94%B1%EF%BC%9B%E5%90%8C%E4%B8%80%E5%BD%93%E5%89%8DBearer%E5%92%8CIdempotency-Key%E3%80%82%E6%97%A2%E6%9C%89%E7%BE%A4%E6%B6%88%E6%81%AFAPI%E5%AE%9E%E6%B5%8B%E5%B7%B2201%E5%88%9B%E5%BB%BA%E5%B9%B6200%E8%AF%BB%E5%9B%9E%EF%BC%88%E5%B7%A5%E4%BD%9C

历史版本与变更记录保存在正式发布档案；通过 POST /v2/manuals/read 提供本篇 id 和指定 version 可读取对应冻结正文。
