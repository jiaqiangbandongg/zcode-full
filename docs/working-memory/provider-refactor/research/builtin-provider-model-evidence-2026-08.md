# Built-in Provider 主推模型与能力证据（2026-08）

> 状态：初始 revision 4 发布证据；2026-09-01 已补充 Kimi 多模态校正
>
> 设计依据：[`zcode-builtin-provider-config.md`](../design/registry/zcode-builtin-provider-config.md)

## 1. 证据规则

本报告只记录发布者用于维护 Built-in Config 的依据，不向运行时 Config 增加 evidence、confidence 或
provenance 字段。事实按以下顺序裁定：

```text
ZCode 产品或账号服务的已确认契约
          |
          v
Models API 实时成功响应（若厂商提供）
          |
          v
当前官方模型/API 文档
          |
          v
第三方兼容场景的保守推断
```

- 官网明确声明的 context、max output、输入格式和协议能力可以进入对应 Model/API/Endpoint Rule。
- ZCode 套餐链路额外提供的能力进入 Provider-scoped Rule，不能反向改写原生模型事实。
- Models API 文档示例只证明响应形状，不代替带当前访问材料的实时目录。
- 官网未列出的候选模型可以为第三方兼容服务保留保守规则；目标官方 Endpoint 未确认前不默认启用。
- 请求接受某字段、忽略某内容或没有报错，不等于模型消费了该输入，也不构成能力证据。
- “JSON Output”或 JSON Object 不等于严格 JSON Schema；当前字段
  `supportsJsonSchemaOutput` 只在已证明严格 Schema 的线路上开启；字段改名已由 Todo74 承接 Todo39 完成。

## 2. 厂商结论矩阵

| 厂商                  | 本轮主推/独特模型                                      | 关键官方事实                                                                                            | 本轮默认启用 | 主要保守项                                                                          |
| --------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- | ------------ | ----------------------------------------------------------------------------------- |
| GLM / Z.ai / BigModel | `glm-5.3`、`glm-5.3-flash`、`glm-5v-turbo`             | 5.3 为文本旗舰；5.3 Flash 原生 Text/Image/Video；1M context、128K output                                | 三者         | 普通 Account API 的 5.3 不声明视觉；旧 5.x/4.x 默认关闭                             |
| Coding Plan           | `GLM-5.3`、`GLM-5.3-Flash`、`GLM-5.2`、`GLM-5-Turbo`   | Individual/Team 静态成员；Plan 服务为成员提供 Image/Video 转写                                          | 四者         | 不推断 Audio/PDF；Start 仍由账号返回成员约束                                        |
| Kimi                  | `kimi-k3`、`kimi-k2.7-code`、`kimi-k2.6`               | K3 1M 且支持 Image/Video；K2.7 Code 256K 且支持 Image/Video；K2.6 256K 且支持 Text/Image/Video          | 三者         | `k3` 支持 Image/Video；`k3-256k` 仅支持 Image；alias 与旧 K2.x/Moonshot V1 默认关闭 |
| MiniMax               | `MiniMax-M3`、`MiniMax-M2.7`、`MiniMax-M2.7-highspeed` | M3 是当前最新主推，1M、Text/Image/Video，并明确支持中国区 Anthropic/OpenAI Endpoint；M2.7 为 204800     | 三者         | M3 最大输出仍取保守值；Models API 文档示例不是实时成员目录                          |
| DeepSeek              | `deepseek-v4-flash`、`deepseek-v4-pro`                 | 1M context、384K output、Text、Tool；Anthropic/ChatCompletions 均支持；新版 Pro/Flash 支持 low/high/max | 两者         | JSON Output 不扩散为严格 Schema；Responses 的严格 Schema 按 API/Endpoint 单独处理   |
| Qwen                  | `qwen3.8-max`、`qwen3.8-flash`                         | 1M context、131072 output、Text/Image/Video、Tool；两者支持严格 JSON Schema                             | 两者         | 旧 3.5/3.x 保留但默认关闭；原生搜索不等于应用侧自动启用搜索工具                     |
| MiMo                  | `mimo-v2.5-pro`、`mimo-v2.5`                           | 两者 1M/128K；Pro 为文本；v2.5 支持 Image/Video/Audio；旧 v2 系列已退役                                 | 两者         | 结构化输出先按当前协议保守；Audio 仅进入静态事实，不新增本轮编码入口                |
| OpenAI                | `gpt-5.6-sol`、`gpt-5.6-terra`、`gpt-5.6-luna`         | 三档 1.05M/128K，Text/Image、Tools、严格输出；`gpt-5.6` 是 Sol alias                                    | 三个真实 ID  | alias 与旧 Codex 默认关闭，避免重复入口                                             |
| Anthropic             | Fable 5、Opus 5、Sonnet 5、Haiku 4.5                   | 全部 Text/Image/Tool；前三者 1M/128K，Haiku 200K/64K                                                    | 四个独特档位 | PDF 是 Messages API 文档能力，保留当前事实；不扩散 Video/Audio                      |
| xAI                   | `grok-4.6`、`grok-build-0.1`                           | 4.6 为 Text/Image、500K、Tool、严格输出；Build 为 256K coding 档                                        | 两者         | `grok-4.3` 默认关闭                                                                 |

## 3. Account 与套餐视觉边界

普通 Account API 与 Coding Plan 必须分开：

```text
普通 Account API + glm-5.3
└─ 原生 Text；Image/Video=false

普通 Account API + glm-5.3-flash
└─ 原生 Text/Image/Video

Start / Individual / Team Plan
└─ Provider 服务为其实际成员提供 Image/Video 转写
```

普通 Account API 接收含图片的请求但不报错，只能说明服务端容忍或忽略了内容，不能证明 `glm-5.3` 具备视觉。
因此本轮保持它的原生视觉能力为 `false`。Plan 的视觉能力来自 ZCode 产品链路，是独立的 Provider 服务事实。

## 4. 本轮 Provider 成员与初始顺序

`builtinModelIds` 的物理顺序遵循“默认 enabled 在前、默认 disabled 在后”。这只是发布文件的初始顺序，
运行时不新增排序器，用户拖动后的 Personal `modelOrder` 仍是用户顺序事实。

- GLM API：5.3、5.3 Flash、5V Turbo 在前，其余历史成员在后。
- Individual/Team：5.3、5.3 Flash、5.2、5-Turbo。
- Kimi：K3、K2.7 Code、K2.6 在前。
- MiniMax：M3 在前；M2.7、M2.7 Highspeed 作为仍正常服务的速度档随后，三者默认启用。
- Qwen：中国与国际 Provider 均以 3.8 Max、3.8 Flash 开头。
- MiMo：2.5 Pro、2.5 在前。
- OpenAI：Sol、Terra、Luna 在前，alias 与旧型号在后。
- Anthropic：四个独特价格/速度档全部启用。
- xAI：4.6、Build 在前，4.3 在后。

## 5. 官方资料

- GLM：[模型总览](https://docs.bigmodel.cn/cn/guide/start/model-overview)
- Kimi：[API 模型选择](https://www.kimi.ai/help/kimi-api/api-model-selection)、[K3 发布说明](https://www.kimi.com/news/kimi-k3)、[K2.7 Code 模型说明](https://www.kimi.ai/resources/kimi-k2-7-code)、[Kimi Code 模型表](https://www.kimi.com/code/docs/en/kimi-code/models.html)
- MiniMax：[模型调用](https://platform.minimaxi.com/docs/guides/text-generation)、[Anthropic Models API](https://platform.minimaxi.com/docs/api-reference/models/anthropic/list-models)、[OpenAI Models API](https://platform.minimaxi.com/docs/api-reference/models/openai/list-models)
- DeepSeek：[模型与价格](https://api-docs.deepseek.com/quick_start/pricing/)、[更新日志](https://api-docs.deepseek.com/updates/)、[Responses API](https://api-docs.deepseek.com/api/create-response/)
- Qwen：[Qwen3.8 Max](https://help.aliyun.com/en/model-studio/qwen3-8-max)、[Qwen3.8 Flash](https://help.aliyun.com/en/model-studio/qwen3-8-flash)、[Structured Output](https://help.aliyun.com/en/model-studio/qwen-structured-output)
- MiMo：[模型总览](https://mimo.mi.com/docs/en-US/quick-start/model)、[Audio Understanding](https://mimo.mi.com/docs/en-US/usage-guide/multimodal-understanding/audio-understanding)
- OpenAI：[Models](https://developers.openai.com/api/docs/models)
- Anthropic：[Models Overview](https://platform.claude.com/docs/en/models/overview)
- xAI：[Grok 4.6](https://docs.x.ai/developers/models/grok-4.6)、[Structured Outputs](https://docs.x.ai/developers/model-capabilities/text/structured-outputs)

## 6. 已知不完美与下一轮验证

本轮目标是形成比 revision 3 更可信的发布基线，不宣称完成带真实访问材料的 Endpoint 实测。后续模型验证 API
应优先调用厂商 Models API，再验证接口未提供的能力：

1. 每个真实 Endpoint 与当前访问材料的模型列表、alias 及可选 capability 元数据；
2. 三种 API Schema 下的 Tool、reasoning、MCS 与严格 JSON Schema；
3. Image/Video/Audio/PDF 是否真的被消费，而不是仅被接受或忽略；
4. max output、默认 reasoning 档位及服务端限制；
5. 官方文档与账号产品接口发生漂移时的自动报告。

其中 OpenAI-compatible Models API 通常只返回基础身份；Anthropic 官方 Models API 当前还可返回 token 上限、
Image/PDF、Thinking、Effort 与 Structured Outputs 等能力。第三方兼容服务可能只实现子集，解析和证据采纳都
必须按实际字段进行，不能按协议名称补齐。

## 7. 2026-09-01 Kimi 证据校正

本轮复查发现 revision 4 刷新时把“摘要未记录多模态”误当成了“不支持”，后续配置延续了这个错误。当前官方
资料已经明确：

- Kimi API 模型选择页声明 `kimi-k3` 具有原生视觉理解；K3 发布资料进一步明确原生架构理解文字、图像和视频；
- Kimi K2.7 Code 官方 FAQ 明确声明 Text、Image、Video 输入；
- Kimi Code 模型表声明 `k3` 支持 Image/Video，而 `k3-256k` 仅支持 Image。

因此 revision 7 校正这三项事实。以后能力从已发布的 `true` 降为 `false` 时，必须有明确的负面证据或可复现
请求结果，不能再以资料缺席作为依据。
