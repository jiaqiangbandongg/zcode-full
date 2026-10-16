# Prompt Enhance

聊天输入框新增了“增强提示词”能力，用于在发送前先把当前草稿交给已选中的自定义模型供应商做一次润色。

## 设计

- UI 只负责收集当前草稿和最近对话上下文，并把增强后的文本回填到 composer。
- 真正的网络请求下沉到 `modelProviderService.enhancePrompt()`，由 host 侧按 `modelProviderId` 重新读取最新 provider 配置。
- 请求格式会按当前 ZCode provider 选择优先级：
  - `claude` 优先 Anthropic
  - `codex` / `opencode` 优先 Responses
  - `glm` 优先 OpenAI Chat
  - `gemini` 优先 Gemini
- 若首选协议失败，会自动尝试同一 provider 可用的其他兼容格式。

## 当前范围

- 仅支持“自定义模型供应商”场景。
- 原生 CLI/native 模型暂未接入，因为它们没有统一暴露可复用的直接 HTTP 鉴权配置。
