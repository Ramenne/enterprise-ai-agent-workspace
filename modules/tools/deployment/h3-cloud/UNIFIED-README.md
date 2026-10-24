# 中枢统一绘画与视频 MCP

当前入口仍是 https://hufu.example.invalid/mcp 。成员沿自己的身份权限服务连接调用，无需另配供应商密钥或新 MCP 地址。

通过 `hub.tools {"group":"visual"}` 发现工具，通过 `hub.help` 读取契约，再通过 `hub.invoke` 调用。新增 visual.* 由中枢 MCP 直接转交已部署的生成领域服务；原 API 保留。

## 分工和当前边界

- Krea2 Turbo FP8 + 单个兼容 LoRA：两端共同输入，8步、Euler/simple、CFG1，尺寸512..2048且16倍数，总像素不超过2MP，seed为32位无符号整数。
- 生图和视频参考图统一进入中枢耐久队列。AutoDL在排队60秒内实际就绪且有空闲时选AutoDL；60秒到期仍未固定执行端则选Cloud。此计时只约束开始派发前的等待，不限制生成时长。零散与集中需求采用同一规则，不为新请求自动开机。
- 视频生成始终Cloud。LoRA训练只AutoDL；本版本 `visual.training.plan` 仅产生计划，未开放训练执行。
- AutoDL当前713机RTX4090已完成Krea2 Turbo FP8 1024×1024、8步单机首图，端到端11.378秒。中枢到该实例的受控连接尚未建立；单机成功不表示统一MCP的AutoDL路径已上线。训练尚无数据集验收。
- 单张生图/视频参考图指输出用途；当前Krea工作流不支持参考图片输入或图像编辑。
- 不承诺两端像素一致、同延迟、同价格；Cloud未提供的权重校验事实不捏造。

## 常用调用

```json
{"tool":"visual.image.preview","arguments":{"prompt":"A blue ceramic bird on a wooden desk","demand":"batch","width":1024,"height":1024,"seed":42424242}}
```

```json
{"tool":"visual.lora.import","arguments":{"url":"https://civitai.com/models/2781697?modelVersionId=3132956","idempotency_key":"<稳定UUID>"}}
```

导入可能异步。用返回的LoRA ID调用 `visual.lora.get`，等state=ready。默认在Cloud导入：中枢只向Cloud传链接，不直接访问Civitai。指定target=autodl必须已有可用连接；Cloud导入完成后AutoDL未连通，原ID仍保留，不能宣称两端均已导入。

```json
{"tool":"visual.image.generate","arguments":{"idempotency_key":"<稳定UUID>","prompt":"A blue ceramic bird on a wooden desk","width":1024,"height":1024,"seed":42424242,"lora_id":"<上一步返回ID>","lora_strength":0.8,"demand":"batch","generation_authorized":true,"estimated_credits":60,"budget_credits":120}}
```

estimate和budget是调用者明确提供的预算校验参数，不是平台实时价格，也不是计费方硬上限。AutoDL已租用时的GPU小时费独立计算，未经授权不能延长租期。

用 `visual.job.get {"kind":"image","id":"<同一UUID>"}` 查原任务，输出UUID取自job的outputs；用 `visual.output.get {"kind":"image","id":"...","asset_id":"..."}` 直接取得原图MCP image内容。可读取已通过旧API完成、归当前成员所有的历史任务。

视频参数使用 `visual.video.capabilities` 和既有 `调用能力/ComfyCloud-H3-Ref2VA-v1/README.md`，通过visual.video.preview / generate，任务和结果的kind=video。视频结果为需当前Bearer鉴权的下载路径，不能把它当公开链接。

## 身份、幂等和故障

调用者身份始终传至生成服务；供应商配置按当前成员权限读取。任务和LoRA按成员隔离。控制面不接受任意供应商URL或新密钥。

生成必须带稳定UUID。统一账本先记录原provider，再提交；重复同UUID仅查询原provider。任何可能已经提交的任务禁止切路重发。参数变化使用相同UUID返回冲突，不允许静默改写。提交前的预检失败可修正后使用同一UUID；统一账本建立后出现未知效果，则保留原ID调查。

Cloud已有独立耐久账本，统一层与其共用原任务ID。两层跨进程原子性不作虚假承诺：若统一层已记账而实际派发前中断，状态可能是未知且无供应商任务；不会自动补发，需要查原记录处理。

## AutoDL对接契约（交环境负责人）

中枢不扫描实例或自动租卡。环境负责人准备ComfyUI/Krea2后，对接受控worker服务，推荐实例环回监听 + 获准SSH隧道；不要公开无鉴权ComfyUI。

中枢服务读取仓库外 `VISUAL_AUTODL_CONFIG`（默认 `/srv/workspace`），当前未创建该配置。管理员核验后配置：

```json
{"origin":"http://127.0.0.1:18293","worker_id":"<实际实例标识>","authorized_actors":["<获准成员actor_id>"],"lease_authorized":true,"starts_at":0,"ends_at":0,"shutdown_verified_until":0,"drain_seconds":300}
```

时间使用Unix秒。shutdown_verified_until必须来自实际关机安排核验，不能为选路随意填真。此配置是执行授权范围，不因能发现MCP而扩大成员GPU使用权。

worker接口：GET /health，POST /jobs，GET /jobs/{UUID}，GET /jobs/{UUID}/outputs/{assetUUID}，POST /loras/import，GET /loras/{UUID}。

health返回worker_id、contract=krea2_turbo_shared_v1、observed_at、model_ready、idle、ready_loras。中枢要求观测时间差<30秒。/jobs接收{id,request}，必须在外部Comfy提交前持久保存原ID；重复不能重复出图。/loras/import接收固定{id,model_id,version_id,file_id}，执行端自行访问Civitai并校验SHA256；中枢不下载模型。LoRA ID沿用Cloud登记ID，但两端状态和内容哈希分别保留，Cloud ready不推定AutoDL ready。

实际接通后仍需做一张AutoDL生成、同UUID重试、带LoRA生成、窗口关闭/训练GPU锁冲突等验收；本轮不冒充已做。


## 画廊与反馈闭环（已接入）

生成、回库和反馈现在共用一套执行层。需要保留拼装来源和自动回库时，从 `hub.tools {"group":"gallery"}` 展开17个工具，使用 `gallery.generation.create → gallery.generation.sync → gallery.feedback.add → gallery.provenance.get`。直接 `visual.image.generate` 保留为模型执行接口。详细契约见同工作区 deploy/visual-feedback-mcp/README.md 与中枢固定文档“调用能力/统一生成反馈MCP-v1/README.md”。AutoDL仍待其他AI完成环境后接入。


## 60秒队列实现（2026-10-21，待受控发布）

只有一条权威队列：成员Codex → 中枢visual.image.generate → AutoDL或Comfy Cloud。
不在Agent机器和GPU机器各自重复维护一条等待队列。提交立即返回同一UUID和
state=queued、provider=pending、queued_at、fallback_at；成员用visual.job.get查状态。
已固定provider的任务，即使超时、网络断开或结果未知，也只能查询原端，禁止切路重发。

队列与provider保存在同一私有SQLite；并发抢占用BEGIN IMMEDIATE，截止时间优先于
同一刻的AutoDL可用信号，每台worker最多保留一个未确认结束的任务。前任务只有明确
成功/失败/取消证据才释放槽位；未知状态不释放。16个等待任务/成员为队列限额。
队列提交时复用现有Cloud预检，因此指定LoRA必须已在Cloud就绪；AutoDL也必须就绪
同一LoRA ID才可抢占。不能为回退删除LoRA或换权重。训练始终AutoDL，当前仍只暴露计划。

后台分发使用提交者请求上下文，凭据只在内存，不写进队列。服务进程重启后，尚在等待的
任务由该成员下一次鉴权job.get恢复；截止时间不重置。已抢占但未确认效果的任务保持未知，
不能自动重新派发。此限制需要调用方持续查询，不能声称服务重启后无需成员鉴权即可完成。

当前源码修改与本地测试不等于线上发布；需在登记的tools-h3-cloud组件发布，并接通
受控AutoDL worker。现有普通tools默认deploy指向另一项旧业务服务，禁止借此重启错服务。
