# Todo145：OpenRouter Messages 推理参数修复

状态：已实现并复审，补录；代码提交 `2d622900ce`。

## 原因与范围

Air 上 GLM-5.3 向 OpenRouter Messages 发送 `thinking.type=enabled`，却没有
`budget_tokens`，违反服务端协议。完整决策及证据见
[OpenRouter 请求契约](../../../openrouter-reasoning-request-contract.md)。

- [x] GLM、DeepSeek、Kimi K2、Qwen、MiMo 在 OpenRouter Messages 使用 adaptive + effort。
- [x] 关闭档位保持 disabled；不人为添加固定预算，不修改其他供应商或 API 格式。
- [x] 保留个人覆盖以及现有 Claude、GPT、Kimi K3 专用规则。
- [x] 发布配置解析、真实 SDK wire 共 221 项测试通过；类型、Lint、格式、架构检查通过。
- [x] Air 上 GLM-5.3、GLM-5.3-Flash、DeepSeek 4.1 Flash 的 adaptive 请求已成功。

Fable 的失败为地区限制，非本次推理参数问题；不绕过地区限制、不扩大修复。
未逐个线上调用全部模型，未发布远端配置。
