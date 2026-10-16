# Todo113 第二轮：官方事实与实施裁决

核对日：2026-09-11。实施基线 revision 21（包含 Todo126），不是最初调查的 revision 19。本轮由用户批量授权执行；第一轮结果不作为第二轮的验收替代。

## 结论与范围

按原厂规格补通用配置，聚合网关的容量、协议差异放站点规则；不修改个人配置、历史选择或运行中 Model。原厂退役只移除该模板成员及精确默认规则，保留旧型号通用匹配供个人和第三方使用。新增补漏成员默认关闭，保持现有主力及排序；不因目录补齐改变用户默认选择。

| 型号                     | 官方事实 → 当前缺口 → 实施                                                                                                                                                                                                                                                                                                                                      |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GPT-5.4 / Pro            | 1,050,000 context / 128,000 output；基础版 none/low/medium/high/xhigh，Pro 仅 medium/high/xhigh，原厂 Pro 仅 Responses。[1] 当前落未知配置；分别补原厂、聚合前缀及快照规则，原厂与 OpenRouter 补四款，Zen 原有四款保持关闭。图片/PDF、工具及 Schema 支持沿用对应 API；不扩到其他 5.x 或图像生成变体                                                             |
| GPT-5.4 Mini / Nano      | 各 400,000 / 128,000；none/low/medium/high/xhigh，图片输入、文本输出。[2] 分别补规则，不能继承基础版容量                                                                                                                                                                                                                                                        |
| DeepSeek V4.1 Flash      | 原厂 `deepseek-flash`，1M/384K、视觉、可关闭及 low/high/max；原厂旧 V4 Flash 退役别名路由，新公告明确 V4 Pro 继续服务。[3] 原厂保留 Flash/Pro、移除旧 Flash 目录。OpenRouter `deepseek/deepseek-v4.1-flash` 为 1,048,576/384,000，必须用站点覆盖容量，并用其统一 reasoning/结构化输出协议；不改第三方旧 V4 Flash                                                |
| Qwen3.7 Max              | 北京/国际均提供，1,000,000/131,072，混合思考。默认 ID 等价 2026-05-20，**纯文本**；2026-06-08 快照才增加图片/视频。[4] 补目录、通用规则及精确视觉快照，不把全族改成视觉                                                                                                                                                                                         |
| Qwen3.7 Plus / Flash     | 均 1,000,000/131,072，文本/图片/视频、混合思考；Plus 支持严格 Schema；Flash 的“结构化输出”不能直接等于 Chat JSON Schema。[5] 分别补配置；OpenRouter Flash 当前输出上限为 65,536，Plus 当前不宣告视频，因此加网关限定而非改原厂能力                                                                                                                              |
| Qwen3.6 Plus / Flash     | 均 1,000,000/65,536，文本/图片/视频、混合思考；思维链上限不是 maxOutputTokens，不能将 81,920/131,072 填进输出上限。[6] 补北京/国际目录与协议映射；Chat 严格 Schema 不默认打开                                                                                                                                                                                   |
| Qwen3.8 Omni Flash       | 官方型号页搜索索引列 65,536/16,384，文本/图片/音频/视频输入，仅文本输出，none/minimal/low/medium/high/xhigh/max，无搜索/Schema；北京、新加坡列有配额。[7] 当前页面直接打开重定向旧 Omni 指南，且 Messages 支持未证实。先补可证实的通用及 Chat/Responses 配置和国际 Chat 模板；北京模板默认 Messages，**不为了补目录改整个 Provider 协议**，其目录加入暂挂待确认 |
| Kimi K2.7 Code Highspeed | 官方明确与普通 Code 是同一个模型，256K，输出加速。Code 不允许关闭 thinking，现有 disabled/enabled 值域错误。[8] 原厂新增高速版（关闭），Code 共用值域收紧为 enabled，K2.6 不变；沿用既有 98,304 输出上限，官方当前 quickstart 仅给默认 32K，未把默认值当硬上限                                                                                                  |
| Kimi / MiMo 下线         | K2.5 和 moonshot-v1 全系于 8/31 下线；MiMo v2-pro/omni/flash 于 6/30 下线。[9] 仅移除原厂目录及配套精确规则；K3 短别名无明确退役证据，保持原默认关闭                                                                                                                                                                                                            |
| MiMo UltraSpeed          | 9/8 公告顶部明确内测结束、商业版待开放，下方旧试用文字不作为开放证据。[10] 不新增；原通用 Pro 后缀配置不删除                                                                                                                                                                                                                                                    |

## 聚合逐型号核对

实际读取 OpenRouter `/api/v1/models` 和 Zen `/zen/v1/models`（均 HTTP 200），同时核对 Zen 端点文档。[11] API 列表证明供给，不证明任意 Key 有权限。

| 新增/复核对象                          | OpenRouter                                                           | OpenCode Zen                                                                                | 百炼第三方                                                                                                                                                                    |
| -------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GPT-5.4 四款                           | `openai/gpt-5.4{,-pro,-mini,-nano}` 全部列出；Messages/Chat 网关转换 | 四款已列，Responses                                                                         | 未确认，不猜                                                                                                                                                                  |
| GPT-6 Astra / Fable5.1                 | `openai/gpt-6-astra`、`anthropic/claude-fable-5.1` 均列出            | 原 ID 均列，分别 Responses / Messages                                                       | 未确认                                                                                                                                                                        |
| DS V4.1 Flash                          | `deepseek/deepseek-v4.1-flash` 已列                                  | 本次接口及文档未列，不猜 ID                                                                 | 未确认新 Flash，旧 V4 Pro/Flash 不是新版供给证据                                                                                                                              |
| Qwen3.7 Max/Plus/Flash、3.6 Plus/Flash | 五个 `qwen/` ID 全部列出，保留原成员                                 | API 当前仅列 3.6 Plus；现有 3.7 Max/Plus 没有明确退役证据，保留原关闭成员、不据单次缺失删除 | 原厂双地域核实后补                                                                                                                                                            |
| Qwen3.8 Omni                           | 未列                                                                 | 未列                                                                                        | 原厂见上，Messages 待确认                                                                                                                                                     |
| Kimi Code Highspeed                    | 未列                                                                 | 未列                                                                                        | 官方列 `kimi/kimi-k2.7-code-highspeed`，但指南只证实 Chat、图片仅公网 URL，当前北京默认 Messages 且本地附件是 Base64；不把“有型号”写成当前模板已可完整执行，保留适配限制 [12] |
| MiMo UltraSpeed                        | 未列                                                                 | 未列                                                                                        | 未确认                                                                                                                                                                        |
| Qwen3.8 Max 快照                       | 列 `qwen/qwen3.8-max-0902`，原无日期 ID 本次未列                     | 未列                                                                                        | 原厂 0902/2026-09-02 别名规则已覆盖；不批量罗列快照。OR 补已核实快照（关闭），原成员无退役证据不删                                                                            |

## 其他主力及边界复审

- Fable5.1 官方仍是 1M/128K、始终 Adaptive、low/medium/high/xhigh/max；原厂与两聚合已列，第一轮规则及工具约束继续验证。[13]
- GPT6 Astra 原厂仍 1,050,000/128,000；工具使用以 Responses 为准，现有原厂/Zen 模板均为 Responses。OpenRouter 的 Messages 是其转换服务，不据原厂限制关掉网关。[14]
- MiniMax 官方主力仍 M3，xAI 仍 Grok4.6；未找到需新增的同期稳定文本型号，不扩大到音视频生成产品。[15]
- GLM 四手动模板及账号目录保留 Todo126 的 Flash PDF、GLM5.3 桥接标签及 Turbo 默认裁决；不动账号名单。
- 新目录不保证旧已保存非法档位继续执行；也不迁移或清空这些选择。容量展示不应以执行校验是否通过为前提，沿用 Todo123。
- OpenRouter Qwen3.8 Max 0902 提供 minimal/low/medium/high/xhigh，3.6 Plus/Flash 明确支持 Schema；仅站点覆盖，不扩到原厂。发现的 GPT6 Astra Pro 聚合变体涉及 reasoning.mode 的独立语义，本轮不以现有 Astra effort 配置冒充已适配；留待独立确认，不扩大本轮候选。

```text
官方/聚合事实 → Built-in Model / API / Site / 模板默认
                         ↓
                  Personal 优先合并
                         ↓
             共享 Registry → 所有选模入口
                         ↓
                新执行对象读取新配置
                既有执行对象保持冻结
```

## 实施验收

SDK 区分性测试发现既有漏接：OpenAI Compatible 的 `supportsStructuredOutputs` 未装配，默认 false，导致配置已允许 Schema 的请求被 SDK 降为 JSON object。本轮最小修复：将 Model 的 `supportsJsonSchemaOutput` 在 bind 时冻结并传入 SDK factory；不新增 Provider 特判或协议字段。测试覆盖支持/不支持、原有 Model 冻结及新 Model 配置生效。

先增加缺漏复现测试；配置修改后验证每个新增型号的完整解析、别名/邻近负例、网关差异、精确默认成员及 Personal 优先；真实 SDK 捕获三协议请求中的推理/上限/工具/媒体。最终文件 revision 22，重新跑发布完整性门禁。真实付费端点无凭据的部分不声称通过；桌面/手机共享读取在整批验收记录。

## 来源（全部官方，核对日同上）

[1]: https://developers.openai.com/api/docs/models/gpt-5.4
[2]: https://developers.openai.com/api/docs/models/gpt-5.4-mini
[3]: https://api-docs.deepseek.com/updates/
[4]: https://help.aliyun.com/zh/model-studio/qwen3-7-max
[5]: https://help.aliyun.com/zh/model-studio/qwen3-7-plus
[6]: https://help.aliyun.com/zh/model-studio/qwen3-6-plus
[7]: https://help.aliyun.com/zh/model-studio/qwen3-8-omni-flash
[8]: https://platform.kimi.com/docs/guide/kimi-k2-7-code-quickstart
[9]: https://mimo.mi.com/docs/zh-CN/updates/deprecate
[10]: https://mimo.mi.com/docs/en-US/news/latest/beta-extended
[11]: https://opencode.ai/docs/zen/
[12]: https://help.aliyun.com/zh/model-studio/kimi-api-by-moonshot-ai
[13]: https://platform.claude.com/docs/en/models/fable-5-1/overview
[14]: https://developers.openai.com/api/docs/models/gpt-6-astra
[15]: https://docs.x.ai/developers/models

补充逐变体/协议来源：[GPT5.4 Pro](https://developers.openai.com/api/docs/models/gpt-5.4-pro)、[Nano](https://developers.openai.com/api/docs/models/gpt-5.4-nano)、[Qwen3.7 Flash](https://help.aliyun.com/zh/model-studio/qwen3-7-flash)、[Qwen3.6 Flash](https://help.aliyun.com/zh/model-studio/qwen3-6-flash)、[思考模式](https://help.aliyun.com/zh/model-studio/deep-thinking)、[Chat Schema 支持清单](https://help.aliyun.com/en/model-studio/qwen-structured-output)、[Messages 扩展](https://help.aliyun.com/zh/model-studio/anthropic-api-messages)、[Responses](https://help.aliyun.com/zh/model-studio/qwen-api-via-openai-responses)、[Kimi 下线](https://platform.kimi.com/docs/models)、[MiniMax](https://platform.minimax.io/docs/guides/models-intro)、[OpenRouter 模型事实](https://openrouter.ai/api/v1/models)、[OpenRouter Messages](https://openrouter.ai/docs/api/api-reference/anthropic-messages/create-messages)、[OpenRouter reasoning](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens)。
