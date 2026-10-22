# Xiaomi MiMo API 与 Token Plan 模板

## 接入事实（2026-10-14 核验）

MiMo 按量 API 和 Token Plan 是独立接入产品。设置页需要提供两张模板，避免用户把订阅密钥填到按量地址。

| 模板 ID | 中英文名称 | Anthropic Base URL | 凭据 |
| --- | --- | --- | --- |
| `xiaomi-mimo` | Xiaomi MiMo API | `https://api.xiaomimimo.com/anthropic` | 按量 API Key，`sk-` |
| `xiaomi-mimo-token-plan` | Xiaomi MiMo Token Plan | `https://token-plan-cn.xiaomimimo.com/anthropic` | 个人 `tp-` 或团队 `ttp-` |

凭据来自[官方控制台](https://platform.xiaomimimo.com/)。两种 Key 不能混用，但客户端不新增前缀校验。Token Plan 的实际地址以用户控制台为准；同协议也有 `token-plan-sgp.xiaomimimo.com`、`token-plan-ams.xiaomimimo.com` 集群，用户继续通过现有 Base URL 编辑入口覆盖。

官方依据：[首次调用](https://mimo.mi.com/docs/zh-CN/quick-start/summary/first-api-call)、[Token Plan 快速接入](https://mimo.mi.com/docs/zh-CN/tokenplan/Token%20Plan/quick-access)。

## 模型及兼容边界

- 两模板提供 `mimo-v2.6-pro`、`mimo-v2.6-flash`，默认启用；模型事实共用规则，1M 上下文按现有配置单位记为 1000000，最大输出 131072，文本输出，支持文本、图像、视频及音频输入。Anthropic 的推理选项为 `disabled` / `enabled`，映射到 `thinking.type`，输出上限映射到 `max_tokens`。
- 官方[模型列表](https://mimo.mi.com/docs/zh-CN/quick-start/summary/model)及 [Anthropic 协议](https://mimo.mi.com/docs/zh-CN/api/chat/anthropic-api)提供上述依据。[Token Plan 个人版](https://mimo.mi.com/docs/zh-CN/tokenplan)列出 Pro、Flash 的套餐支持；Ultraspeed 属定制服务，不作为通用模板默认成员；ASR/TTS 不属于本次聊天模型目录。
- 官方公告 V2.5 Pro、V2.5 将于北京时间 2026-10-21 10:00 下线。原 API 模板暂时保留这两项及其规则，供已有选择继续解析；新 Token Plan 模板只提供 V2.6。此变更不自动改写用户的模型选择，用户需要主动切换到 V2.6。后续删除旧成员单独处理。
- 原 `xiaomi-mimo` 的 templateId 不变，只更新默认展示名并增加 V2.6。Personal 的 providerId、自定义名称、enabled、Key、API 地址、模型覆盖不迁移、不重写。已有实例若手填 Token Plan 地址仍保留该地址。
- 两模板复用现有 `xiaomi-mimo` 图标和模板创建流程；不引入 Provider 类型、品牌条件分支或新的状态源。

```text
Built-in 模板 + 模型规则
          ↓ 现有 Resolver（Personal 覆盖优先）
Personal 实例 → Effective Provider → Registry → 新建模型请求
      ↑
设置页显式创建/编辑 → ProviderSettingsFacade → Personal 文件
```

源文件为 `config/provider/zcode-builtin.json`，递增 revision，测试环境文件由 `pnpm provider:config:sync-test` 生成。下载、缓存和发布方式沿用现有合同，不随 MR 自动发布远端配置。

## 验收

| ID | 场景 | 断言与证据 |
| --- | --- | --- |
| MIMO-01 | 生产/测试配置读取、两模板解析 | 名称、协议、地址、模型成员和启用规则正确；V2.6 能力与参数映射完整 |
| MIMO-02 | 原实例及海外地址覆盖 | 名称、禁用状态、密钥、地址、个人模型配置保留；解析不修改 Personal |
| MIMO-03 | 手机宽度中文浅色 / 桌面宽度英文深色 | 两张模板及 tooltip、图标显示正确；分别点击只交付对应 templateId；详情使用各自 Base URL，无额外写入或横向溢出 |

配置/Resolver 单测覆盖 MIMO-01/02。浏览器 pending 用例覆盖 MIMO-03 的共享组件，详见[用例矩阵](testing/provider-settings-batch-20260910.md)。浏览器夹具隔离服务写入，不等同于完整 Electron、手机 shared-host 或真实官方付费请求验证。
