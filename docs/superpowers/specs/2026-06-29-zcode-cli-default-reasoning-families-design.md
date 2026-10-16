# zcode-cli 默认思考强度族补全设计

## 背景

用户自定义 provider/model 时，App 侧 Catalog 可能没有完整 reasoning metadata。zcode-cli 在 workspace dynamic provider overlay 中已有一层默认推断，但目前只覆盖 DeepSeek V4、GLM、GPT、部分 Anthropic DeepSeek 场景。对于 Qwen、Kimi、MiMo 这类模型，如果 App 传入的 dynamic model 没有 `reasoning`，agent 生成的 catalog override 不会包含 `supportsReasoning` 和 `reasoning.levels`，后续 session settings 里也没有可选思考强度。

本次只做 zcode-cli 侧补全，不改 App/UI 的 Catalog 生成逻辑，也不引入 shared inference。

## 目标

- dynamic provider model 没有 `reasoning` metadata 时，zcode-cli 能按 provider kind 和模型族补默认 reasoning。
- Qwen OpenAI-compatible provider 使用 canonical `openaiCompatible.enable_thinking`，不能误用通用 `thinking.type`。
- Kimi/MiMo 使用通用 thinking toggle：OpenAI-compatible 走 canonical `openaiCompatible.thinking.type`，Anthropic 走 `anthropic.thinking`。
- 保持既有 DeepSeek V4、GLM-5.2、GPT 默认推断行为不变。
- 自动推断只生成 canonical direct fields，不生成 `extra_body`。

## 非目标

- 不修改 `packages/ui` 的思考强度列表展示逻辑。
- 不修改 `packages/services` 的 App Catalog 存储或模型编辑器。
- 不做手动 reasoning override 表单。
- 不把 inference helper 抽到 shared 包。

## 设计

`apps/zcode-cli/packages/bootstrap/src/zcode-protocol/workspace-model-catalog.ts` 中的 dynamic provider overlay 是本次唯一行为入口。当前 `createDynamicProviderDefaultReasoning(kind, modelId)` 只能看 provider kind 和 model id；Qwen 需要 provider id 前缀识别，因此改成接收完整 `provider` 和 `model`。

默认推断顺序：

1. Anthropic kind：
   - DeepSeek V4 继续使用 DeepSeek V4 Anthropic reasoning depth。
   - GLM-5.2 继续使用 GLM-5.2 Anthropic reasoning depth。
   - GLM、DeepSeek 非 V4、Kimi、MiMo 等 catalog thinking-toggle 族使用 Anthropic thinking toggle。
2. OpenAI kind：
   - GPT 继续使用 OpenAI provider reasoning effort。
   - 其他族不补通用 OpenAI-compatible 参数。
3. OpenAI-compatible kind：
   - GLM-5.2 继续使用 GLM-5.2 reasoning depth。
   - GPT 继续使用 OpenAI-compatible reasoning effort。
   - DeepSeek V4 继续使用 DeepSeek V4 reasoning depth。
   - Qwen 使用 direct `enable_thinking` toggle。
   - Kimi、MiMo、GLM、DeepSeek 非 V4 使用 direct `thinking.type` toggle。

`isCatalogThinkingToggleProtocolModel` 继续作为 Kimi/MiMo/GLM/DeepSeek 等族的统一识别边界，但 Qwen 分支必须排在通用 thinking toggle 分支之前。

## 测试

在 `apps/zcode-cli/packages/bootstrap/tests/zcode-protocol.test.ts` 增加 dynamic provider 无 reasoning metadata 的覆盖：

- Qwen OpenAI-compatible provider：生成 `enabled/disabled` 档位，并映射到 `enable_thinking: true/false`。
- Moonshot Kimi OpenAI-compatible provider：生成 `enabled/disabled` 档位，并映射到通用 `thinking.type`。
- Xiaomi MiMo Anthropic provider：生成 `enabled/disabled` 档位，并映射到 `anthropic.thinking`。

回归运行定向 vitest，再运行项目要求的 `pnpm typecheck` 和 `pnpm lint`。
