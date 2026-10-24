# MiniMax 语音与音乐 API

基础地址：`https://hufu.example.invalid/api/h3-cloud/audio`

所有请求携带 `Authorization: Bearer <本人中枢凭据>`。服务按当前调用者核验 Vault 的 MiniMax 凭据授权，不使用网页、浏览器、Cookie 或公共代用身份。

| 方法与路径 | 用途 |
|---|---|
| GET /capabilities | 支持模型、参数与已验证边界 |
| POST /health | 只读鉴权检查，不生成、不扣生成额度 |
| GET /voices | 官方系统音色列表 |
| POST /speech/preview | 检查语音参数，返回真实上游请求，不提交 |
| POST /music/preview | 检查音乐参数，返回真实上游请求，不提交 |
| POST /speech/jobs | 提交非流式 MP3 语音任务 |
| POST /music/jobs | 提交非流式 MP3 音乐任务 |
| GET /jobs/{uuid} | 当前本人任务状态 |
| GET /jobs/{uuid}/audio | 下载已完成 MP3，仍需身份与凭据授权 |

生成请求额外携带 `Idempotency-Key: <固定UUID>`。同 UUID、同请求不重提；同 UUID 改请求返回 409。失败或未知状态先查原任务，不自动重发。

语音预览请求：
```json
{"model":"speech-2.8-hd","text":"你好，这是语音接口示例。","voice_id":"male-qn-qingse","speed":1,"volume":1,"pitch":0}
```

音乐预览请求：
```json
{"model":"music-3.0","prompt":"轻快钢琴与电子节奏，明亮的中文流行曲","lyrics":"[Verse]\n新的故事从这里开始\n[Chorus]\n跟着节拍向前走","is_instrumental":false}
```

实际提交 `/jobs` 前，在对应请求中加入：
```json
{"generation_authorized":true,"billing_source":"m_plan","billing_acknowledged":true,"estimated_cost_cny":0.1,"max_cost_cny":1}
```

上述金额仅为调用格式示意，不是报价。必须由调用方按实际模型、文本和套餐估算；这是预算确认门槛，供应商没有提供硬性单次扣费上限，不能当作强制封顶。

语音最多 3000 字符；支持 speech-2.8-hd/turbo、speech-2.6-hd/turbo。音乐支持 music-3.0、music-2.6；prompt 最多 2000 字符，lyrics 最多 3500 字符，纯音乐设 is_instrumental=true。不接受自行指定音乐 duration。暂不封装音色克隆、流式输出及网页会员接口。

已验证：官方 API 凭据鉴权与 303 系统音色查询。未验证：新的语音/音乐生成、音乐历史付费资格、网页声贝是否适用于 API。官方 API 与网页会员额度不可假定互通；接口要求显式承认 official_api 计费，默认不切换用户此前优先选择的网页额度。当前 token-plan 查询返回 2062/no active token plan subscription，不等同于账户所有 API 余额为零。

任务状态包括 queued/submitting/succeeded/failed_or_unknown/submission_unknown/queue_failed；进程重启不自动恢复提交。成功返回音频 SHA256、大小、trace_id；full_decode_verified=false 表示接口只保存音频，尚未做播放器/完整解码验收。供应商 HTTP 200 内部错误仍会判失败，不冒称生成成功。


## 2026-10-20 M Plan 更新

当前已将原Vault条目更新为M Plan订阅Key，稳定ID和授权关系保留，展示名改为MiniMax M Plan。新请求使用billing_source=m_plan；服务按实际Key类型校验，误报official_api会返回409。M Plan先扣套餐额度，超额可能扣已有积分包；它不消耗普通API账户余额，也不是Audio声贝。人民币估价用于表达预算量级，不代表本次现金支出。历史official_api任务保留原计费标记。具体用量以官方窗口/积分变化为准，返回100%不证明没有消耗。前文旧“尚未测试语音”状态由本节及阶段回执更新：新Key短语音实测成功，音乐测试结果见本轮回执。
