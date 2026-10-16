# Provider 调研

Research 保存支撑设计和实施判断的代码事实。它不定义目标架构；当代码继续演进时，每篇调研都应保留调查日期和适用范围。

| 专题 | 状态 | 用途 |
| --- | --- | --- |
| [`todo154-start-plan-independence-impact.md`](./todo154-start-plan-independence-impact.md) | 实施前调查归档；新实现与验证转 Todo154 §8 | 记录 current／鉴权限制、Session／草稿写回与独立配置差异、I27 纠偏和提交推荐入口，支撑 Todo154 |
| [`builtin-online-release-review-2026-09-11.md`](./builtin-online-release-review-2026-09-11.md) | 调研完成，修复待执行 | 线上 CDN 字段实测、Standalone 更新停滞、正文超时复现、缓存／版本／各端生效审查；实施归 Todo117 |
| [`embedded-search-provider-dependency.md`](./embedded-search-provider-dependency.md) | 调研完成 | 证明 Embedded Search 的 Provider Connection 依赖可以删除 |
| [`reasoning-config-to-wire.md`](./reasoning-config-to-wire.md) | 调研完成，迁移未实施 | 还原 reasoning level、provider options 和最终请求字段的完整现状映射 |
| [`m2-registry-aggregation-and-refresh.md`](./m2-registry-aggregation-and-refresh.md) | 历史现状调研；结论已进入 Design/M2，残留见 Cleanup | 还原 M2 前 Host、Core Worker 和 Renderer 的 Registry 构建、推送、缓存与刷新链路 |
| [`account-provider-facts-and-auth.md`](./account-provider-facts-and-auth.md) | 历史现状调研；Account 边界已经裁决并实施 | 区分 Plan 的静态配置、账号访问范围和请求鉴权，并定位 Model 需要固定的账号访问身份 |
| [`legacy-model-provider-service-call-map.md`](./legacy-model-provider-service-call-map.md) | 历史调用面；主要消费者已迁移，残留见 M2 Cleanup | 将旧 IModelProviderService 方法按 Settings、Selection、Account、Connectivity 与 Worker Bridge 归类 |
| [`provider-config-schema-and-builtin-glm-draft.md`](./provider-config-schema-and-builtin-glm-draft.md) | 历史设计草案；配置结构已进入 Design | 汇总 Provider access/api 双维度、Account Access Overlay、各类 Builtin Provider，以及 GLM-5.2、GLM-5.3、GLM-5-Turbo 的协议配置 |

阅读调研中的候选命名和历史判断时，以其文首的“结论去向”为准；当前有效目标始终由 [`../design/design.md`](../design/design.md) 维护。
