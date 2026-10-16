# Anthropic Authorization Header

## 背景

ZCode 的 Anthropic Messages 请求默认依赖 AI SDK 的 `apiKey` 配置发送 `x-api-key`。部分 Anthropic-compatible 网关同时按 `Authorization` 读取同一份凭据；如果只发送 `x-api-key`，主对话请求、连通性探测和 Repo Wiki 短请求会出现鉴权行为不一致。

## 目标

- 普通 Anthropic transport 请求必须同时携带 `x-api-key: <api-key>` 和 `Authorization: Bearer <api-key>`。
- 用户或运行时显式配置的 `Authorization` 仍然优先，避免覆盖 Start Plan、安全校验 Header 或代理侧已有鉴权语义。
- Start Plan Anthropic endpoint 保留 `Authorization: Bearer <zcode-jwt>`，并补齐 `x-api-key: <zcode-jwt>`，保持与普通 Anthropic 双 header 形态一致。
- `anthropic-version: 2023-06-01` 和现有 `anthropic-beta`/runtime headers 行为不变。

## 影响面

- Agent 主模型请求：`@zcode/adapters` 的 Anthropic provider registry。
- 设置页连通性探测：`packages/services` Anthropic endpoint check。
- Repo Wiki 模型短请求：手写 Anthropic Messages HTTP 请求。

## 非目标

- 不改 OpenAI、OpenAI-compatible、Responses、Gemini 的鉴权 header。
- 不把 Start Plan 的 Bearer 语义改为裸 token。
- 不新增协议字段；这是 provider runtime header 组装行为。
