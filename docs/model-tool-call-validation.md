# Model Tool Call Validation

## 背景

provider 可能返回两类不同问题：

- 工具名为空，例如 `{ id: "call_x", name: "", input: {...} }`；
- id 与非空工具名存在，但 final `tool-call.input` 是 malformed JSON 或 `null`。

client-executed 调用的空字符串/纯空白工具名虽然无法命中 registry，但在 call id 可闭合时仍能
生成配对的 error tool result。该分支保留 provider 原始名称，按稳定恢复行为处理，
不猜测真实工具。参数损坏时同样保留调用身份，通过普通工具 schema / lookup 生成结果并让模型在
当前 run 中恢复，而不是把错误升级成整个模型请求失败。

## 工具身份

- 本次只恢复 `typeof toolName === "string" && toolName.trim().length === 0` 的
  client-executed 调用。原始空字符串或空白字符串必须保留，不得被 wire / storage 占位值覆盖。
- `toolName` 缺失或为 `null`、数字、对象等非字符串时，继续返回
  `invalid_model_response`。这是本次范围选择，不覆盖非字符串工具名的恢复。
- `providerExecuted=true` 的空字符串/纯空白名称继续返回 `invalid_model_response`。
- 合法非空名称继续 trim 后执行。
- 非空工具名即使未注册，也继续进入既有 tool lookup。找不到工具时，executor 返回
  `Tool not found: <name>`，runtime 生成与原 call id 配对的 `is_error=true` tool result。
- 缺失 call id 的既有兼容行为不在本 ticket 中修改，也不能与 malformed 参数恢复混为一类。
  `generateText` 继续使用现有 `toolCallId ?? id ?? crypto.randomUUID()`；streaming 不增加
  新的 id fallback。空名称仅在当前路径已有可闭合 id 时恢复。

空字符串/纯空白名称使用既有 registry-miss 生命周期：

```text
provider final tool call（原始名称）
                 │
                 ▼
client-executed + name.trim()==="" + id 可闭合
                 │
                 ├── 正常 finish ──> 强制 registry miss
                 │                     ├── 不运行 Hook / permission / handler
                 │                     ├── 同 id ToolCallError + error result
                 │                     └── sibling batch 闭合后 continuation
                 │
                 └── finish 前断流 ──> 既有 stream_recovery_interrupted_tool
                                       不改写为 registry-miss 错误
```

空名称 registry miss 使用两份明确分离的错误内容：

- UI / log error：`Model returned an invalid tool call: tool name is empty.`
- provider `modelContent`：
  `<tool_use_error>Error: No such tool available: ${rawToolName}</tool_use_error>`

普通非空 unknown tool 继续使用 `Tool not found: <name>`，不改变既有文案。

## Provider、持久化与 App 投影

runtime assistant/tool-result history 始终保存 provider 原始名称。只有协议要求非空的边界使用
固定占位值 `empty_tool_name`：

| API 格式 | assistant tool call | tool-result wire |
| --- | --- | --- |
| `anthropic-messages` | 原始空字符串/空白字符串 | `tool_result` 不携带 name |
| `openai-chat-completions` | `empty_tool_name` | tool message 不携带 name |
| `openai-responses` | `empty_tool_name` | `function_call_output` 不携带 name |

- 显式 `apiFormat` 优先；格式缺失时仅 `providerKind="anthropic"` 保留原始名称，其他 provider
  使用 `empty_tool_name`。不得根据 URL 猜测协议。
- `ToolPart.tool` 保存 `empty_tool_name`，`ToolPart.metadata.providerToolName` 保存原始名称。
  判断 metadata 是否存在必须使用 `providerToolName !== undefined`，不能使用 truthy 判断。
- pending、running、completed/error 及 streaming synthetic 生命周期都保留同一 top-level
  metadata。hydration 优先恢复原始名称，再由当前 provider 格式决定 wire 投影，因此 provider
  切换不会把存储占位值误当成模型原始名称。
- App 可见产品态只按空名恢复的结构化证据静默过滤，不能只比较固定占位字符串：live
  `model.streaming` 中原始名称 trim 后为空时不生成 V4 `ToolCallRow`；持久化 `ToolPart` 只有在
  `ToolPart.tool="empty_tool_name"` 且 `metadata.providerToolName` 存在并在 trim 后为空时，才不映射
  legacy message tool part、cold hydration 工具行或可见 footprint。过滤同时适用于 desktop
  continuous 与 web remote replayable。
- 空名恢复调用不发布 `ToolCallScheduled`。scheduler、registry-miss、持久化 `ToolPart`、provider
  error result 和 continuation 均保持不变；后续 `ToolCallError` / batch terminal 事件不会反向创建
  产品工具行。
- `empty_tool_name` 不是保留工具名。没有上述 metadata 的裸 `ToolPart.tool="empty_tool_name"`，以及
  live 中模型原始返回的同名非空调用，都按普通合法工具名执行和展示。这样内置、alias、MCP 或插件
  注册同名工具时不会发生“实际执行但产品静默”的身份碰撞。
- App / remote mapper 不暴露 `providerToolName`；公共协议与旧 session 无需迁移。旧数据没有
  metadata 时继续使用 `ToolPart.tool`，包括按普通工具展示裸 `empty_tool_name`。普通非空 unknown
  tool 不经过静默过滤，仍显示既有 terminal error 工具行。
- `tool_input_start` 与 `model.streaming` 保留原始空名称；占位值只用于要求合法非空名称的
  App / storage 或 OpenAI-compatible wire 边界。

## Malformed tool input JSON

Adapter 只解析 AI SDK final `tool-call.input`；流式 delta 仅用于展示。统一归一化规则为：

- `undefined`、缺失 input、空字符串 → `{}`，不记录 parse-fail；
- string input 至多剥离一个前导 BOM，再使用严格 `JSON.parse`；
- JSON 解析失败、解析结果为 `null`、或原生 input 为 `null` → warn 一次并降为 `{}`；
- 其他非 string 值保持原值，由普通工具 schema 判断；
- 不进行 partial JSON repair，不裁剪尾部或补括号猜测模型意图。

```text
AI SDK final tool-call(input)
              │
              ▼
       严格归一化一次
        │             │
        │ valid       │ malformed / null
        ▼             ▼
   parsed input    warn + input={}
        │             │
        └──────┬──────┘
               ▼
       普通工具 lookup / schema
        │                 │
        │ reject          │ accept
        ▼                 ▼
same-id is_error=true   正常执行工具
tool result
        │
        ▼
同一 run 的下一次模型请求尝试恢复
```

malformed 不增加 `inputIssue` 或 parse-failed 标记。如果工具 schema 接受 `{}`，工具仍正常执行；
如果 schema 拒绝，使用现有 recoverable input-validation error。未知但非空工具名使用同一个
`{}` 和 call id 进入既有 `Tool not found` 路径。

## Provider-visible input validation error

首次模型输入未通过 `inputSchema.safeParse` 时，runtime 格式化完整校验错误，
并返回同一 tool call id 的 error tool result：

```text
<tool_use_error>InputValidationError: ${formattedError}</tool_use_error>
```

Provider projection 必须保留以下字段和值，不增加内部 telemetry metadata：

```json
{
  "role": "user",
  "content": [
    {
      "type": "tool_result",
      "tool_use_id": "<原 tool call id>",
      "is_error": true,
      "content": "<tool_use_error>InputValidationError: ...</tool_use_error>"
    }
  ]
}
```

该 formatter 按以下顺序输出可识别的问题：

1. missing：`invalid_type` 且 message 包含 `received undefined`；
2. unexpected：`unrecognized_keys`，只输出 keys，不拼接 issue 自身 path；
3. wrong type：其余 `invalid_type`。

精确行模板为：

```text
The required parameter `${path}` is missing
An unexpected parameter `${key}` was provided
The parameter `${path}` type is expected as `${expected}` but provided as `${received}`
```

路径使用字符串字段的 `.` 与数字字段的 `[n]` 连接，空 path 输出空字符串。wrong type 的
`received` 从 issue message 使用 `/received (\w+)/` 提取，无法提取时使用 `unknown`。
存在任一可识别问题时，输出：

```text
${toolName} failed due to the following ${count > 1 ? "issues" : "issue"}:
${lines.join("\n")}
```

此时同一批 issues 中的其他错误类型不会显示。三类均不存在时，完整返回 Zod 4.0 error
message：issues 数组使用英文默认 message、移除内部 `input` / `inst` / `continue` 字段，
并通过带 bigint-to-string replacer 的 `JSON.stringify(issues, replacer, 2)` 序列化。
provider-visible formatter 使用完整 issue 列表，不受内部日志最多保留 20 条错误的限制。

首次模型输入同时存在 runtime normalization 与 provider JSON Schema 两个既有边界：

```text
runtimeInputSchema.safeParse
       │
       ├── success ──> normalized input
       │
       └── failure ──> raw input + retained parser issues
                                      │
                                      ▼
                         provider JSON Schema gate
                            │                   │
                            │ success           │ failure
                            ▼                   ▼
                   hooks / permission     exact error modelContent
                                                   │
                                                   ▼
                                 same-id, is_error=true tool result
```

- JSON Schema 继续决定当前首次输入的接受/拒绝结果；保留 parser issues 不得新增拒绝。
- runtime parse 成功但 JSON Schema 失败时，使用 JSON Schema issues。
- runtime parse 与 JSON Schema 同时失败时，先将两侧证据投影成一份有序 canonical issues：
  runtime parser 决定实际失败项与 fallback 顺序，匹配到的 JSON issue 只替换为目标版本字段结构；
  provider-only required / unexpected 结构问题继续由 JSON issues 补充。
- runtime parse 失败但 JSON Schema 成功时保持既有流程，不提前返回参数错误。
- 没有 runtime schema 的动态工具继续使用完整 JSON Schema issues。

这样默认值与 preprocess/transform 语义来自实际 parser，不在 JSON Schema validator 中重新
推断；canonical projection 是 provider-visible 顺序的唯一归属，formatter 只消费该结果，
不再自行合并或重排两套错误。参数类错误仍按 missing → unexpected → wrong type 分类输出；
非参数 fallback 保持 runtime parser 的字段/自定义校验顺序，仅将本地 parser 的数组级
bounds 调整到数组子项 issues 之后，以匹配目标版本遍历顺序。不得采用“JSON issues 全部在前、
runtime-only issues 追加在后”的策略，否则会把更早字段的 regex/refine 错误移动到后续字段之后。
该投影只改变错误表达，不改变 schema 接受范围。

本契约仅对应模型原始 arguments 的首次 schema failure。schema 成功后可选执行的
工具级 `validateInput` 属于语义/环境校验，失败内容不经过参数错误 formatter；PreToolUse hook 修改后的
输入和 REPL inner tool call 也是独立调用点。ZCode 当前没有 deferred/discovered-tool
surface，因此不生成延迟工具发现的 schema 提示。本修复不为这些分支新增接口或行为。

该逻辑没有 provider/model gate；所有支持工具调用的模型共用同一分支，不增加模型专属判断。

实时执行与冷恢复必须向模型投影同一份 error content：

```text
live ToolExecutionResult.modelContent
                │
                ├──> 当前 turn 的 provider history
                │
                └──> error tool part metadata.modelContent
                                      │
                                      ▼
                         resume / hydration provider history
```

- `ToolStateError.error` 继续保存通用 UI / log 错误，不改成 provider wrapper。
- error result 仅在 `modelContent` 本身为 string 时将其附加保存到
  `ToolStateError.metadata.modelContent`；本次不扩展结构化内容的持久化协议。
- hydration 优先使用 string 类型的 `metadata.modelContent`，旧数据、缺失值或非 string 值继续
  fallback 到 `state.error`，无需迁移。
- `metadata.modelContent` 仅供 Agent 冷恢复使用，映射 App / remote 消息时必须移除，不改变
  ZCode protocol 或 UI 可见 tool metadata。
- hydration 不根据当前工具 schema 重新格式化历史错误，避免 schema 或 formatter 版本变化改写
  模型当时实际看到的内容。

## 数据与诊断边界

- 原始 malformed string/null 不得进入 provider-visible history、持久化 tool part 或结构化 warn。
- string 只记录真实 `inputLength`；原生 null 记录 `inputType: "null"`，不伪造长度。
- warn 记录 `toolName`、`source`、parse error 类型和恢复方式，每个 final malformed call
  只记录一次。
- streamText、generateText 与 model-io 复用同一归一化结果，避免二次解析、重复 warn，
  或诊断内容与 runtime 实际输入不一致。
- AI SDK 为 invalid call 生成的 `tool-error.input` 按 call id 复用 final call 的归一化 input；
  不允许 raw malformed string/null 从 `toolResults` 进入 runtime 或 model-io。
- model-io 的结构化 `response.toolCalls` 与 `response.toolResults` 记录归一化后的 `{}`，
  不记录 raw malformed input。
- 空字符串/纯空白工具名的 model-io、runtime history 与内部持久化 metadata 保留原始值；
  由空名投影产生的 `empty_tool_name` 仅用于上述非空边界，不得回流 registry lookup。provider 原始
  返回的同名非空字符串仍是普通工具身份，可以正常 registry lookup。
- 更底层 provider raw 取证继续遵守既有采集与脱敏边界。

## 验收标准

- client-executed 空字符串/纯空白工具名生成同 id `is_error=true` tool result，模型收到
  `<tool_use_error>Error: No such tool available: ${rawToolName}</tool_use_error>`，同一 turn
  继续请求。
- 空名称强制 registry miss，handler、Hook、permission 与 `ToolCallStarted` 均不运行；普通
  非空 unknown tool 文案不变。
- Anthropic assistant history 保留原始名称；Chat Completions 与 Responses 的 assistant
  tool call 仅在 wire 边界使用 `empty_tool_name`，三者 tool-result wire 均不携带 name。
- 正常 streaming finish 进入 registry miss；final 后、finish 前断流仍返回既有
  `stream_recovery_interrupted_tool`。
- live/cold hydration 都恢复 `providerToolName` 和精确 `modelContent`；App message/snapshot
  不物化原始空名称或带空 `providerToolName` metadata 的占位工具行，也不暴露 provider 原始空名称
  metadata。裸 `empty_tool_name` 无该 metadata 时按普通工具展示；旧 session 无需迁移。
- 注册名或 alias 恰为 `empty_tool_name` 的合法调用正常发布 streaming/scheduled/result 生命周期、
  执行 handler 并在 live/cold/legacy 产品态展示，不得被空名恢复静默逻辑误伤。
- missing/非字符串名称、provider-executed 空名称、既有 id normalization 和一般 ToolCall Hook
  lifecycle 均不改变。
- 884 字符 malformed AskUserQuestion fixture 输出 `input={}`，只 warn 一次，不抛
  `invalid_model_response`。
- string `"null"`、原生 null、BOM、undefined、空字符串和合法 object 均按上述矩阵处理。
- partial JSON 不修复。
- required-schema 工具收到 `{}` 后生成同 id `is_error=true` tool result，并在同一 run
  发起下一次模型请求。
- 接受 `{}` 的工具正常执行。
- 未注册但非空的工具名生成同 id `Tool not found` error result。
- parallel batch 中 malformed、正常和未知调用都闭合后，再进入下一次模型请求。
- provider-visible 下一轮消息使用 `tool_use.input={}` 和配对的
  `tool_result.is_error=true`，不得出现 raw malformed string/null。
- 首次 schema failure 的 `tool_result.content` 使用完整
  `<tool_use_error>InputValidationError: ...</tool_use_error>`；不得退化为
  `Tool input failed inputSchema validation`。
- session 恢复后仍使用持久化的同一份 string provider content；旧 session 缺少该 metadata 时
  保持使用既有 `state.error`。
- missing、unexpected、wrong type 与非参数 fallback 的顺序、换行、单复数、路径及
  Zod 4.0 JSON message 均以源码 golden 做 byte-for-byte 验证。
- 同一输入同时包含 runtime-only 与 JSON 可表达约束时，较早字段不得被 JSON-first 合并移到
  较晚字段之后；至少覆盖 regex + sibling bound、field refine + sibling enum 两类生产 schema。
