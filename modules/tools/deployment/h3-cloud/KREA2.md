# Krea 2 Turbo 原生文生图 API

入口：https://hufu.example.invalid/api/h3-cloud/krea2

基于 Comfy Cloud 原生 Krea 2 Turbo FP8 权重，固定 8 步、Euler/simple、CFG 1。与当前原生 H3 共用已有授权通道，独立任务账本；并非合作伙伴 Krea 节点，也不是在中枢 CPU 服务器驻留模型。

每次请求携带调用者自己的 `Authorization: Bearer <HUFU_TOKEN>`，不能使用 Comfy 密钥充当中枢身份。服务在当前调用者权限下读取已核验配置 `调用配置/Comfy-Cloud-QQ.json`，所属账号为 `user@example.invalid`／Personal Workspace。无权读取配置的成员需取得相应项目权限。密钥不写入代码或任务状态。

## 接口

- `GET /capabilities`：能力和限制。
- `POST /health`：已有供应商历史任务的只读连通检查，不生成图片。
- `POST /preview`：验证请求并返回原生工作流，不付费提交。
- `POST /jobs`：创建单张图片；`Idempotency-Key` 必须是新 UUID。同请求重用同 UUID，不会重复提交。
- `GET /jobs/{id}`：查询当前调用者的任务；完成结果在 `supplier.outputs`。
- `GET /jobs/{id}/outputs/{asset_id}`：下载图片，不返回供应商签名 URL。

任务请求：
```json
{
  "prompt": "A cinematic photograph of a small ceramic bird on a wooden desk, warm window light, detailed texture",
  "profile": "turbo",
  "width": 1024,
  "height": 1024,
  "seed": 42424242,
  "generation_authorized": true,
  "estimated_credits": 60,
  "budget_credits": 120
}
```

`estimated_credits` 与 `budget_credits` 是调用方提交前自检，示例数值不是价格承诺或供应商扣费硬上限；实际扣费以平台账单为准。只做预览时可省略这三个授权/预算字段。

宽高为 512–2048、8 的倍数，像素总量不超过 2,097,152。例如 1024×1024、1536×1024、1920×1080。不能把 2048×2048 当作本接口的 2MP。每次一张；当前不开放 RAW、LoRA、提示词自动扩写、风格参考或人物编辑。

超时或无法确认供应商提交结果时，状态为 `submission_unknown`；沿用原任务编号核查，不能另建 UUID 自动重试扣费。不同调用者任务隔离，Krea 与 H3 任务账本隔离。Krea 和原生 MiniMax H3 共用 QQ 账号专用配置；旧配置仅留作历史。

原生工作流来源：https://github.com/Comfy-Org/workflow_templates/blob/main/templates/image_krea2_turbo_t2i.json
说明：https://docs.comfy.org/tutorials/image/krea/krea-2

部署：同一个 `hub2-tools-h3-cloud.service` 加载 `tools_krea2_cloud.py`，路径在已有 `/api/h3-cloud/` 代理范围内。发布脚本仅更新该组件，保留旧 release 和独立持久任务数据库。

## 已完成的实际验证（2026-10-19）

两个模型已统一接入 `user@example.invalid`／Personal Workspace，专用配置 `调用配置/Comfy-Cloud-QQ.json`。密钥在该账号开发者平台内经本人确认创建，本机副本位于仓库外，未进入源码或任务日志。

一次 1024×1024 实际文生图成功，输出 PNG 1,195,009 字节，已通过本 API 下载、完整解码及人工目视检查。供应商报告排队1.846秒、执行4.041秒；本次客户端含鉴权、轮询、下载及校验共27.890秒，其中下载9.371秒。仅代表本次单图样本，不是延迟承诺。任务：本地 9880ecaa-63cf-43da-a156-7f2aa1ee58ec，供应商 2a56bb9a-1d67-4480-a3fa-a741f6ca094e。同一输入和Idempotency-Key重复请求返回原成功任务、resubmitted=false。

两个模型的线上 health 均200，使用新密钥读取当前QQ账号下已验证成功的原生H3历史任务；未新增视频生成。H3历史任务5b6531c0-467a-48e6-a9d7-757cf62a9d97的执行图确认Ref2VA原生权重、Turbo4 LoRA、4步；历史执行67.058秒。

服务器回归合计9项通过；无身份401、合法预览200、超过2MP拒绝422。此前402来自切换前的旧配置试测，不能用来判断本QQ账号没有余额；旧失败报告和旧任务保留，不自动重试。

当前运行源码提交：5f5fde1fede6d7acbf3684436b82ae86056142cd。供应商GET /api/v2/jobs列表在此Cloud入口返回501，health因此使用已核验的QQ历史任务读取，不把任务列表当作可用接口。
