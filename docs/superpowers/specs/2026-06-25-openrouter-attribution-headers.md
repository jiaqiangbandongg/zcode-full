# OpenRouter Attribution Headers

## 背景

ZCode 的模型请求和服务侧业务请求已经携带 `X-Title` 等来源 header。OpenRouter app attribution
要求应用同时提供 OpenRouter 专用的 title 和 category 字段，以便请求通过 OpenRouter 或兼容网关时能被正确归因。

## 目标

- 保留现有 `X-Title`，不改变既有上游兼容行为。
- OpenRouter provider 的默认来源 header 同时携带：
  - `X-OpenRouter-Title: ZCode`
  - `X-OpenRouter-Categories: programming-app`
- 判定统一复用 `@zcode/shared` 的 `isOpenRouterBaseUrl()`：解析 provider runtime `baseURL`，
  要求协议为 `https:` 且 host 为 `openrouter.ai` 或其子域。
- 覆盖模型连通性检查、Repo Wiki/Git 提交消息模型请求，以及 zcode-cli/bootstrap 生成的 provider headers。

## 非目标

- 不新增协议字段，不修改 `@zcode/protocol`。
- 不改变用户显式覆盖 `X-Title` 的语义；用户覆盖旧字段时，OpenRouter provider 默认 attribution 字段仍保留。
- 不给非 OpenRouter provider 或普通 ZCode 后端业务 API 请求添加 OpenRouter 专用 header。
- 不修改生成产物或历史打包 bundle，源代码变更会在后续构建时进入产物。

## 验证

- 更新 source header 和 bootstrap provider header 的单测期望。
- 执行相关定向 vitest。
- 按仓库要求执行 `pnpm typecheck` 和 `pnpm lint`。
