# OpenAI-compatible 前置 system message 合并设计

## Feature/change summary

| Field | Value |
| --- | --- |
| Change | OpenAI-compatible 请求发出前，将开头连续的多条 system message 合并为一条 |
| User-visible surfaces | 无直接 UI 变化；旧式 chat template 不再因多条前置 system 报错或只保留最后一条 |
| Existing code owners | `apps/zcode-cli/packages/adapters/src/model/transform.ts`、`system-message-compat.ts` |
| Evidence | adapter 单测与真实 `@ai-sdk/openai-compatible` fake-fetch wire body |
| Out of scope | Anthropic、OpenAI Responses、gateway/custom provider、core ContextBuilder、会话中段 system 语义 |

## 背景与根因

Core ContextBuilder 为不同稳定性与 cache boundary 有意生成 CLI prefix、stable body、dynamic body
三段 system message。AI SDK 的 OpenAI-compatible Chat Completions 转换器会逐条发送这些 message，
不会代替调用方合并。

OpenAI-compatible 只约束 HTTP 外形，不约束后端模型的 chat template。部分旧式 template 只接受
一个开头 system；还有 template 会在遍历多条 system 时覆盖旧值。因此，多段 system 必须保留在
provider-neutral core 内，但需要在 OpenAI-compatible adapter 序列化边界归一化。

## Clarification log

| Round | Question | User answer | Boundary fixed | Follow-up needed |
| --- | --- | --- | --- | --- |
| 1 | 是否可以在 OpenAI-compatible 发请求前合并多个 system | 用户确认可以并要求实现 | 这是兼容性修复，不改变 core prompt assembly | no |
| 1 | 是否把会话中段 system 一并提升到开头 | 接受调研结论：只合并开头连续 system | 禁止改变 system 的因果位置 | no |
| 2 | 是否拒绝前置 prefix 之后的 system | 用户确认该校验属于过度兜底，要求移除 | adapter 只合并前置 prefix，中段 system 原样透传 | no |

## 请求合同

仅当 `providerKind === "openai-compatible"` 时执行：

1. 从消息索引 0 开始识别连续的 system prefix。
2. prefix 中存在两条及以上 system 时，按原顺序使用精确分隔符 `\n\n` 连接文本，不 trim、
   不排序、不得丢失空白。
3. 合并结果占据原第一条 system 的位置；其余 user、assistant、tool message 内容与顺序不变。
4. 0 条或 1 条前置 system 不创建额外变换。
5. 前置 prefix 结束后若再次出现 system，保持其原始位置和内容；adapter 不负责提升、降级、
   改写或拒绝中段 system。
6. Anthropic、OpenAI、gateway、custom provider 继续保留原始多段 system。
7. Core ContextBuilder 继续保留多段 system，避免破坏 Anthropic cache boundary。

```text
provider-neutral core          adapter                         HTTP wire
system(prefix)  ┐
system(stable)  ├─ openai-compatible ─> system(prefix\n\nstable\n\ndynamic)
system(dynamic) ┘                                  │
user / assistant / tool ───────────────────────────┴─> 原顺序不变

非 OpenAI-compatible ─────────────────────────────────> 全部原样保留
user ... system(mid-conversation) ─────────────────────> 原位置透传，不 hoist
```

## Domain scope and high-risk cross-products

| Domain | Include? | Decision |
| --- | --- | --- |
| Model/provider/runtime config | yes | `providerKind` 是唯一启用开关，转换归 adapter 所有 |
| Conversation/session behavior | limited | 只保护消息顺序，不修改 session/history/persistence |
| Mobile remote/replayable | no | desktop 与 mobile 最终共用 agent adapter；不改变 delivery 语义 |
| Workspace identity | no | 不读取 workspace 相关字段 |
| Protocol/schema | no | `ModelInputMessage` 与 `@zcode/protocol` 均不变化 |

高风险交叉项只有 provider kind × system 位置 × system 数量。客户端、workspace、stream/generate
均由相同 adapter 归一化函数折叠，不扩展成独立产品状态。

## Candidate combinations and pruning

| Candidate ID | Provider | Input shape | Expected effect | Status |
| --- | --- | --- | --- | --- |
| OCS-01 | OpenAI-compatible | 0 个 system | 原样转换 | accepted |
| OCS-02 | OpenAI-compatible | 1 个前置 system | 原样转换 | accepted |
| OCS-03 | OpenAI-compatible | 2+ 个前置 system | 合并为一个，顺序与文本不变 | accepted |
| OCS-04 | OpenAI-compatible | user 后出现 system | 保持原位置和内容，不 hoist | accepted |
| OCS-05 | Anthropic/OpenAI/gateway/custom | 2+ 个前置 system | 不合并 | accepted |
| OCS-06 | generate/stream | 相同 message 输入 | 因共用 `toAiSdkMessages` 而保持相同结果 | accepted |

以下组合剪枝：桌面/手机、local/remote、continuous/replayable、workspace identity。它们都在请求进入
adapter 前决定 transport 或 runtime 归属，不改变本设计的纯 message/providerKind 输入。

## Accepted cases

| Case ID | Setup | Action | Assertions | Evidence layers | E2E status |
| --- | --- | --- | --- | --- | --- |
| OCS-01/02 | OpenAI-compatible，0/1 system | 调用 message transform | 数量和内容不变 | unit | adapter unit |
| OCS-03 | 三条前置 system + 普通历史 | 调用 transform 和真实 SDK generate | wire 只有一条 system，后续 roles/order 不变 | unit + network body | adapter wire |
| OCS-04 | user 后插入 system | 调用 transform | 保持原位置和内容，前置 prefix 仍正常合并 | unit | adapter unit |
| OCS-05 | Anthropic 两条前置 system | 调用 transform | 仍为两条 system | unit | adapter unit |

不补 conversation-session E2E catalog/matrix：该修复不增加用户交互状态，真实 SDK wire test 已直接
覆盖最终验收面，桌面 E2E 只会重复 adapter 请求合同。

## 实现边界

- 在 `system-message-compat.ts` 提供专属纯函数，并在 `toAiSdkMessages()` 进入逐角色转换前调用。
- 不修改 `buildProviderRequestMessages()`，保持 core/provider projection 中立。
- 不在 final JSON fetch wrapper 解析并重写未知 body；typed message 边界能保留角色与顺序约束。
- 合并后的 system 继承最后一个前置 system 的 cache-control marker。该 marker 只投影到 Anthropic
  provider options，不影响 OpenAI-compatible wire；保留它用于避免 adapter 中间态无谓漂移。

## 验证

- `model-transform.test.ts`：OCS-01 至 OCS-05。
- `openai-compatible-system-messages-wire.test.ts`：真实 SDK fake fetch，断言最终 `messages`。
- `pnpm --filter @zcode/adapters typecheck`。
- 根目录 `pnpm typecheck` 与 `pnpm lint`。
