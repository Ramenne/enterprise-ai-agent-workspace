# 上海历史源存储治理

归档/状态/取回/回暖/精确物理退役沿现有公开接口、当前成员和领域SQL流程。既有源固定版本保留逻辑身份、正文SHA、来源闭包与授权。首次归档原历史键前，流式读取精确源VersionId并核对完整SHA/大小；未通过不得派发COPY。新副本位于同桶mengstore-1316920087（ap-shanghai）的hub2-archive/<operation_id>，不覆盖原键。当前主位置通过既有storage_primary_locations维护。

维护源码为source/packages/storage-tiers/src/legacy-source-broker.py、legacy-tier.mjs，以及通用CosTierProvider。构建复制到dist。hub2-legacy-source770.service的ExecStart由drop-in指向当前Mem发布的Python脚本；原 /read 与 root元数据/head接口保持。旧admitted.json仍由来源登记流程维护。机器签发者位于既有保护目录，不进入工程。新/tier-session只在原受保护Unix socket上接受root或Mem OS用户；不对外公开。

原历史键必须完全匹配已登记的bucket/key/VersionId；新键必须为专属UUID命名空间。临时STS仅在RAM保留，复制允许精确源Get及该操作目标Put/Get，取回、读取与精确VersionId删除分别签发。无桶列表、原键覆盖或无版本删除。缓存最多约512个未在签发中的策略，凭据遵守厂商原过期时间；不返回父密钥。最终授权、租约、CAS、固定目标和未知效果处理继续由现有领域执行。

新命名空间读取通过自己的上海短期凭据和精确VersionId执行，冷对象触发现有restore_required取回入口。临时恢复不冒称已回标准；累计有效使用或常驻条件回标准仍走既有warm流程，新的标准COPY继续保持同桶固定寻址。旧历史键继续原reader和登记准入。

验证：legacy-tier.test.mjs检查源哈希阻断、派发顺序、原提供商路径、冷读取与可读副本流；legacy-broker.test.py检查源准入、精确目标、恢复与删除权限范围。实际COPY、HEAD和退役结果另存阶段工作，不由单元测试代替。
