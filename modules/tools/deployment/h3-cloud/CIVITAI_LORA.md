# Civitai 链接导入并加载 LoRA 生图

操作路径：成员在电脑浏览器查看 Civitai，将喜欢的 LoRA 链接发给 Codex；Codex 使用成员自己的中枢身份，把链接交给中枢的 Krea 接口。中枢只请求 Comfy Cloud，不直接联网访问 Civitai；由 Comfy Cloud 查询、导入模型，加载并生成。

入口：`https://hufu.example.invalid/api/h3-cloud/krea2`，所有请求使用调用者本人 Hufu Bearer。共享 Comfy 密钥只在后台读取。中枢会记录该成员的 LoRA 映射、版本、Cloud 资产编号和导入状态，成员之间接口记录隔离。不要把共享 Comfy 账号完整密钥给前端。

## 接口

1. `POST /loras/resolve`，JSON `{"url":"https://civitai.com/models/2781697?modelVersionId=3132956"}`。中枢检查网址，再委托 Comfy Cloud 预检，返回名称、格式、大小；此时架构可能仍显示待核验。
2. `POST /loras/import`，相同 JSON，携带 `Idempotency-Key: <UUID>`；Cloud 导入并返回模型资产，中枢核对其 `base_model` 为 Krea 2、`source_arn` 对应实际 Civitai 版本和文件。导入完成返回 `id` 与 `state:ready`。
3. 未完成时 `GET /loras/{id}` 接续导入；失败不会当作可用。`GET /loras` 列出本人记录。
4. `POST /preview` 或 `POST /jobs` 沿用已有图片请求，增加 `lora_id` 和 `lora_strength`（-2至2，默认1）。服务使用本人成员记录对应且经 Cloud 核验的 loader_path，接入 LoraLoaderModelOnly，再连 KSampler。不能将模型资产 UUID 当作媒体 core/ASSET 传入该节点；实测会转换成哈希文件名并校验失败。
5. 生图仍要求稳定生成 UUID、generation_authorized=true 和正数估算/预算字段；查任务和下载图片沿用现有接口。

支持 Civitai 模型页、带 modelVersionId 的版本页以及 `/api/download/models/<版本号>?fileId=<文件号>`。不带版本号时由 Cloud 解析当前版本，导入成功后记录确切版本；之后生图使用已导入资产，不能静默切到未来新版本。复制的URL不能携带token，访问受限模型若Cloud无法读取会失败，不替用户绕过权限。当前实现只接受 `.safetensors` LoRA，单文件不超过2GiB，每次一份；其他底模LoRA即使导入，也不能在Krea工作流加载。Cloud未提供触发词时明确未提供，可由用户另行提供并加入实际提示词。

## Codex 一步调用脚本

`civitai_generate.py` 读取进程环境 HUFU_TOKEN，串联导入、轮询、预览、生成和下载；不需要成员操作 Comfy Cloud 页面。参数包含 --url、--prompt、--strength、--width、--height、--seed、--estimated-credits、--budget-credits、--output。示例值不是费用承诺，供应商按实际用量计费。

脚本把请求和稳定UUID保存在 output对应的 `.receipt.json`；重跑同一命令查询原任务，不能为未知效果自动换UUID。若导入返回 import_unknown，保留记录排查，不能自动重复下载。同一已解析版本重复导入返回原成员记录。

当前供 Codex 和其他程序通过 HTTP API 调用；本次没有给中枢网页另做“粘贴网址”表单。

## 本轮验证（2026-10-20）

Civitai `[KREA 2] Realism Slider` v1.0，模型2781697、版本3132956、文件3013604，链接 https://civitai.com/models/2781697?modelVersionId=3132956。导入返回Krea2底模、确切source_arn和Cloud loader_path=RealismSlider-v1.safetensors；导入资产6112f519-5239-490c-a4dd-fefd3d244bbf。中枢个人LoRA记录08b6b1d3-01a7-498d-a3d2-5564141b5c0a。

先前媒体core/ASSET接法测试失败于节点校验，没有产出图片。改为供应商loader_path后成功：供应商直接验证任务a1145baa-35c5-414d-a9cd-e1ed28082324执行4.164秒；随后中枢完整链路任务3d6437ac-09d7-4752-aa73-1a90f56fba4b，供应商b381c2a4-5cb4-4eba-a75c-91f823cf1aec成功，执行1.601秒、排队2.727秒、客户端含Cloud查询/轮询/下载总56.387秒。后一次是相同seed及工作流的重复样本，可能受热缓存影响，不代表首次生成速度。最终PNG1024x1024、1141845字节，完整解码通过，sha256=1ec8036bb51c6e11fd96766fb68ac62129569d4c9ea2224920d24f90bbbe9f8d。

中枢服务器直连Civitai查询曾超时，最终运行版本已删除直连代码，生产导入/预检仅访问cloud.comfy.org；实际模型由Cloud直接取自Civitai。生产源码a34203e83b8a0f37279ca4324f1acccf62047c12，组件合计20项回归通过，保留了既有H3和音频适配器。
