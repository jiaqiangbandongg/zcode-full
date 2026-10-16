# WebSearch Provider Domain Allowlist

## 背景

WebSearch 通过 provider-native `web_search` 发起内部模型请求。不是所有 Anthropic 兼容端点都支持这个服务端工具，因此运行时只在已确认的供应商域名下暴露 `WebSearch`。

## 规则

- 只对 `providerKind === "anthropic"` 的连接启用 WebSearch。
- 域名匹配以 `baseURL` 的 hostname 为准，不看 provider id 或模型名。
- `bigmodel.cn`、`z.ai`、`deepseek.com`、`z.ai` 的根域和所有子域均允许。
- 例如 `bigmodel.cn` 已由 `bigmodel.cn` 子域规则覆盖；`zcode.z.ai` 由 `z.ai` 子域规则覆盖。

## 影响面

这只影响 agent 侧工具暴露和 provider-native WebSearch 投影，不改变桌面端 continuous 链路、手机端 replayable 恢复语义，也不改变普通模型请求的 endpoint 解析。
