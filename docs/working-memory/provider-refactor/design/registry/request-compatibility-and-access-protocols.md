# 模型请求兼容与 Provider Access 产品协议

> 状态：当前有效设计；Compatibility Config 已删除
>
> 最近更新：2026-10-07（官方版本安全校验细节迁出，本文改为中性概括）

本文划定模型历史回放、API 请求编码差异与 Provider Access/产品协议的归属。Model Config 不再提供通用
Compatibility 容器；协议差异必须归入已有的真实领域契约，否则不进入配置。

## 1. 总原则

模型响应进入 ZCode 后，默认遵守无损回放原则：

```text
Provider 返回的真实 content / reasoning / metadata
                        |
                        v
              Canonical Message 保存
                        |
                        v
              历史消息与持久化
                        |
                        v
              Adapter 请求序列化
                        |
                        v
          同一模型续轮时完整、原样写回
```

“原样”指语义和值不变，不要求中间每一层使用相同的 wire JSON。Provider 的非标准字段如果会被 AI SDK 的标准类型
丢弃，Adapter 可以在输入/输出边界做无损投影；投影只能搬运真实返回的数据，不能借机猜测、补造或修复不存在的值。

新增 Adapter 协议投影必须同时满足下列条件：

1. 当前 AI SDK 或目标 Adapter 的标准编码不能表达该服务的真实协议；
2. 行为能够由当前官方契约、ZCode 产品服务契约或可复现真实请求证明；
3. 归属已有 Model/Provider 契约，Adapter 不需要按具体 ID hardcode；
4. 失败行为明确，兼容投影不能静默丢数据；
5. 它不是另一领域的 Access、安全校验、排队或鉴权状态机。

不得为协议特例重新建立通用 Compatibility 字段或 Personal Model Rule。

## 2. 字段归属裁决

| 现有字段/行为                                 | 最终归属                                    | 裁决                                                                                           |
| --------------------------------------------- | ------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| OpenAI-compatible reasoning 回放              | 无额外配置                                  | 保留真实 reasoning，由当前 OpenAI-compatible SDK 编码 `reasoning_content`                      |
| Anthropic-compatible 无 thinking 的 tool-call | Canonical replay                            | 不为空 tool-call 补造 synthetic thinking；只回放服务端真实返回内容                             |
| Anthropic thinking signature                  | Canonical reasoning metadata + Adapter 投影 | 保存真实 signature/redacted data 并原样回放；不得制造真实签名                                  |
| Z.ai text/tool block signature 候选 patch     | 不采用                                      | 不在当前 HEAD/staging，不把外部分支候选带入本次重构；可独立实测服务 wire，但测试不等于自动合入 |
| `omitMaxOutputTokens`                         | 删除                                        | 旧 GitHub Copilot 特判不为当前未正式支持的接入保留                                             |
| `maxOutputTokensRequestField`                 | 删除                                        | 当前先不支持 Snowflake Cortex，不为它保留字段、Rule 或请求体改写                               |
| 官方版本访问安全校验字段                      | `zhipu-account/start-plan`                  | 从 Model Config 移除；动态材料仍由官方版本产品链路提供                                         |
| `failureProtocol`                             | `zhipu-account/off-peak`                    | 字符串 marker、跨进程错误与 UI 状态机行为保持不变                                              |
| 官方版本请求安全校验准入                      | Provider 请求协议                           | 由显式 Access 与官方域名决定是否进入，具体规则只在官方版本维护                                 |
| `requiresMfjsToolSchema`                      | Model Config                                | 保留模型/API 请求编码事实；仅为显式匹配的 Model Config 启用，失败时报错；设置页置于最后        |

## 3. Reasoning 历史回放

### 3.1 OpenAI-compatible

ZCode 必须保存服务端真实返回的 reasoning block，并把同一段 canonical 历史交回 Adapter。当前
`@ai-sdk/openai-compatible` 已能把 assistant reasoning content 编码为 `reasoning_content`，因此不再需要
`withOpenAiCompatibleReasoningContent()` 重新提取、删除 reasoning part 或为空 tool-call 制造
`reasoning_content: ""`。

目标链路为：

```text
真实 reasoning_content
        |
        v
AI SDK reasoning part + provider metadata
        |
        v
ZCode canonical reasoning block
        |
        v
AI SDK assistant reasoning part
        |
        v
OpenAI-compatible SDK 编码 reasoning_content
```

如果未来 SDK 版本回归，应通过请求体契约测试发现并在 SDK 边界修复，不能恢复按模型名判断的第二事实源。

### 3.2 Anthropic 标准行为

Anthropic 的真实 thinking block、空 thinking、signature 和 redacted thinking 必须完整保存并在 tool-use 续轮中
原样回放。以下两种“空”必须区分：

```text
服务端返回 empty thinking + real signature
└─ 真实响应事实，必须原样保存和回放

服务端完全没有返回 thinking
└─ 默认不能凭空制造 empty thinking / empty signature
```

有些 Anthropic-compatible 流把真实 thinking signature 放在 `content_block_start`，而 AI SDK 只读取
`signature_delta`。`anthropic-stream-compat` 可以把这份已经收到的真实值投影为 SDK 能识别的标准事件；这属于无损
搬运，不是生成签名。

### 3.3 不合成空 thinking

任何 Anthropic-compatible Provider 都统一执行 canonical replay：服务端返回真实 thinking/signature 时原样保存和
回放；服务端没有返回时不补造 block 或 signature。该行为不接受 Model ID、Provider ID 或配置开关分流。

2026-09-10 补充：历史签名兼容判断与上述 block 编码规则分开。旧 Coding Plan ID 与同服务的 Individual/Team ID
可以通过 Adapter 内集中、精确枚举的纯函数判为回放兼容；模型 ID 仍须一致。Z.ai、BigModel 分组隔离，其他
Provider 保留精确 ID 判断，不新增配置或持久化字段、不重写历史身份，也不把该函数用于选型和鉴权。
完整边界与验证见 [Reasoning History Replay](../../../../../apps/zcode-cli/docs/design/v2/model/anthropic-reasoning-history-replay.md#coding-plan-provider-identity-compatibility)。

### 3.4 Z.ai text/tool block signature：候选实现不采用

当前 HEAD 与 `origin/staging` 没有 text/tool block signature replay；相关实现只存在于未合入候选分支。本次重构不采用、
不移植这份候选实现。可以单独对真实 Z.ai 服务做 wire 测试，以确认是否存在非标准 signature；但测试结果只形成新证据，
不让候选分支自动进入设计。

如果未来基于真实证据重新立项，原则仍只能是“收到什么就传回什么”：

```text
真实非标准 block.signature
        |
        v
Adapter 捕获并存入对应 block metadata
        |
        v
持久化不丢失
        |
        v
SDK serializer 边界写回原 block
```

标准 Anthropic SDK 当前只允许 thinking block 携带 signature，所以未来确有该 wire 行为时也只能重新设计 SDK 边界，
不得生成缺失 signature，也不得补造空 thinking。

## 4. 输出 Token 上限兼容

### 4.1 删除 GitHub Copilot omit 特判

`omitMaxOutputTokens=true` 当前用于旧 GitHub Copilot + GPT 匹配。GitHub Copilot 不是本轮正式支持的 Built-in
Provider，这条历史规则没有当前产品契约支撑，因此删除字段、Built-in Rule、Runner 分支和相关构造测试。未来正式接入
Copilot 时按当时接口重新设计，不能恢复旧规则作为默认。

### 4.2 Snowflake Cortex 暂不支持

`maxOutputTokensRequestField="max_completion_tokens"` 当前只为 Snowflake Cortex 把 SDK 生成的 `max_tokens` 改名。
本轮裁决为暂不支持 Snowflake，因此删除该字段、Built-in Rule、请求体改写与专属测试，不保留兼容读取。未来如果正式
支持 Snowflake，根据当时接口重新设计，不能把这条旧规则作为默认事实恢复。

## 5. Provider Access 产品协议

### 5.1 官方版本访问安全校验

Start Plan 在官方版本中需要额外的访问安全校验。它是产品协议，不是某个模型的静态能力或 API 编码偏好。
`access.type=zhipu-account + mode=start-plan` 是唯一静态分派事实；动态材料由请求期链路生成和注入，
不持久化进 Model Config。具体实现只在官方版本中维护。

### 5.2 官方版本请求安全校验

Individual/Team Coding Plan、显式手动套餐 Access 以及官方域名请求在官方版本中会经过额外的请求安全校验，
具体准入规则与实现只在官方版本中维护。开源设计只保留以下边界：

- 两种手动 Access 的 type 在覆盖、序列化、编辑 Key 和绑定 Model 时原样保留；不能在保存时降回普通 `api-key`；
- 准入判断使用本次 Model 已绑定的配置快照，不读取实时 Registry，不修改保存的 Access、Template 或 Model Selection，
  也不增加迁移；
- 不属于 Model Config，不按模型 ID、Template ID 或 Key 内容推测准入；
- 连接测试、普通请求、子任务、本地与远程执行继续走共享 Adapter；不改变桌面 continuous、手机 replayable
  或 Host/Worker 状态所有权；
- 获取 Key 仅使用 `apiKeyManagementUrl` 展示元数据，个人／团队共用模板的单一入口，不新增身份专用链接字段，
  也不由链接推断鉴权（Todo116）。

### 5.3 Off-Peak 执行协议归入 Access

Off-Peak 的排队、Ticket 和失效重试属于访问该产品服务的执行协议，不是模型事实。
`access.type=zhipu-account + mode=off-peak` 是唯一静态分派事实。

当前 Adapter 抛出包含 `off-peak-ticket-expired` 的字符串错误，Desktop/Renderer 再按字符串或正则识别。这套运行状态机
本轮保持等价，不因为配置归属迁移而顺手改成结构化错误。

本轮保持：

- 删除 Model Config `failureProtocol`，由完整 Provider Access 的 `mode="off-peak"` 启用同一行为；
- 现有 ticket marker 字符串；
- 现有跨进程传播和 UI 识别；
- Off-Peak 队列、Ticket、恢复与调度语义。

不得在本轮顺手改为结构化错误，也不得把一次“字段整理”伪装成产品状态机迁移。它作为明确技术债保留，未来独立设计。

### 5.4 Coding Plan 请求来源归因 Header

所有模型请求在 Adapter 的 per-request 层发送 `x-zcode-session-type`，值域为 `main`、`subagent`、
`side_chat`、`other`。它表示宿主会话类型；标题、Memory 与工具内部请求继承宿主，调用用途通过
`x-zcode-query-source` 独立表达。连接测试等工作区独立请求归为 `other`。

该 Header 是请求级来源归因，不是 Provider/Model 静态能力，也不是鉴权材料：

- 不进入 Provider Config、Model Config、Registry 或 Active Model；
- 不按 Provider ID、Model ID、Endpoint 或 Access Mode 推断；
- 由本次调用上下文产生，并覆盖 Provider 静态 Header 中的同名伪造值；
- 流式、非流式和 Adapter retry 使用同一构造逻辑，retry 不改变来源分类。

完整分类表和兼容规则见
[`Agent 模型请求归因 Header`](../../../../superpowers/specs/2026-06-09-agent-model-request-session-header-design.md)。

## 6. Settings 边界

第一版 Model 编辑页不展示：

- 智谱 Provider Access 的 `family` 与 `mode`；
- 已删除的 `openai-reasoning-content`、`omitMaxOutputTokens`、`maxOutputTokensRequestField` 和
  Model Config `failureProtocol`。

`requiresMfjsToolSchema` 仍属于允许编辑的 Model Config，但放在高级区域最后。转换只在该字段明确为 true 时执行；转换
失败必须报错，不能静默发送另一种 Tool Schema。

## 7. 实施与验证门槛

1. 先用最终 HTTP request body 测试证明当前 OpenAI-compatible SDK 能原生回放非空 reasoning，再删除 ZCode helper；
2. 删除 GitHub Copilot omit 字段和规则，不保留兼容读取；
3. 官方版本安全校验按 `zhipu-account.mode` 与显式 Access 分派，并保持动态材料与运行状态不进入 Config；
4. Off-Peak 启用事实是 `mode=off-peak`，字符串 marker 与现有运行状态机保持等价；
5. DeepSeek 统一执行 canonical replay，不保留 synthetic empty-thinking 或 Compatibility Config；
6. Z.ai text/tool signature 候选实现不采用；真实 wire 测试作为独立证据任务；
7. 删除 Snowflake 字段和专属请求改写，当前不支持 Snowflake；
8. Adapter 不恢复通用 Compatibility Config、Registry 查询或 ID hardcode。

## 8. 当前证据记录

本节只保存本轮裁决所依赖的可复核入口，不建立逐 commit、逐叶子的重型历史审计。

- Anthropic 官方 Extended Thinking：<https://platform.claude.com/docs/en/build-with-claude/thinking>。明确要求 tool-use
  续轮完整、原样传回真实 thinking blocks 和 signatures，并允许真实 empty thinking 携带有效 signature；
- DeepSeek 官方 Thinking Mode：<https://api-docs.deepseek.com/guides/thinking_mode>。OpenAI 格式工具续轮要求回传
  服务端真实 `reasoning_content`；
- DeepSeek 官方 Anthropic API：<https://api-docs.deepseek.com/guides/anthropic_api>。当前只声明支持 `thinking`、
  `tool_use`、`tool_result` 等格式，没有 synthetic empty thinking 或 signature 要求；
- 当前 `@ai-sdk/openai-compatible@2.0.60` 的
  `convert-to-openai-compatible-chat-messages.ts` 会把 assistant reasoning parts 编码为 `reasoning_content`；SDK
  changelog 自 2.0.20 起明确包含多轮 tool call 的 reasoning content；
- `apps/zcode-cli/packages/adapters/src/model/anthropic-reasoning-metadata.ts` 是当前 synthetic empty thinking 实现；
  `apps/zcode-cli/docs/design/v2/model/anthropic-reasoning-history-replay.md` 保存历史内部设计主张，但不是外部服务证据；
- 当前 DeepSeek Replay fixtures 的 `syntheticReason` 明确表明相关 wire shape 是构造数据，不能单独证明服务端约束；
- text/tool block signature 候选提交 `70546bde31` 只位于
  `origin/anthropic-block-signature-replay-staging-latest`，不是当前 HEAD 或 `origin/staging` 的祖先；
- Off-Peak 当前 marker 常量为 `off-peak-ticket-expired`，Adapter 与 UI 仍通过错误字符串传递和识别，本轮按既有行为保留。
