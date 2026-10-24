# 中枢统一绘画与视频 MCP

当前入口仍是 https://hufu.example.invalid/mcp 。成员沿自己的身份权限服务连接调用，无需另配供应商密钥或新 MCP 地址。

通过 `hub.tools {"group":"visual"}` 发现工具，通过 `hub.help` 读取契约，再通过 `hub.invoke` 调用。新增 visual.* 由中枢 MCP 直接转交已部署的生成领域服务；原 API 保留。

## 分工和当前边界

- Krea2 Turbo FP8 + 单个兼容 LoRA：两端共同输入，8步、Euler/simple、CFG1，尺寸512..2048且16倍数，总像素不超过2MP，seed为32位无符号整数。
- 集中生图和视频参考图：仅在 AutoDL 实际在线、已授权时段内、关机保护已核验、模型和指定LoRA就绪且有容量时选AutoDL。否则新任务选Cloud。零散任务默认Cloud。
- 视频生成始终Cloud。LoRA训练只AutoDL；本版本 `visual.training.plan` 仅产生计划，未开放训练执行。
- AutoDL抢卡、租用及环境配置由用户另交AI负责。本对话未开机、租卡、下载AutoDL模型或配置该实例。随包worker代码只是可供对方对接的实现草案，未做真实AutoDL GPU验收；不能把它标成在线能力。
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
