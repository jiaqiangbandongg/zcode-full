# GLM API Error Quota Banner（V4 待迁移）

旧链路对 GLM quota/API 错误提供模型设置、升级或恢复 CTA。当前 V4 composer 使用通用 `ChatErrorBanner`，尚未接回这些专用 CTA 和抑制规则。

因此当前行为是展示 projection 中的通用错误并允许本地 dismiss；不能承诺本文标题中的专用 quota 体验。后续实现应使用结构化 fault code 和 provider/entitlement 状态，不依赖错误文案匹配。
