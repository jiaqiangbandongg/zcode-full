# Todo129 实施边界与验收

旧版对照固定 `790884b1ce`，本轮起点 `b2e2b31ea3`。

## 已核实的旧口径

- 旧 modelSelectionGroups / providerFamilyRuntimeModel：Team 连接使用同一家 `builtin:*-coding-plan` 模型身份，连接 key 不作为 model_provider。个人与团队恢复同一个旧统计桶。
- legacyPersonalProviderConfigImporter 将旧 `builtin:zai/bigmodel` 写为固定 `zai-api/bigmodel-api` 实例；只映射这两个精确 ID，不按 templateId 将 UUID 实例归桶。
- 旧 offPeakTelemetry 固定 `offpeak-idle-plan`；两家新闲时身份都恢复该值。
- 保留事件编码：发送 custom 编码，实际请求一般为 provider/model，自动化与闲时为纯 model ID。

## 影响面

使用 feature-boundary-planner；Codegraph 不可用，采用图中 telemetry / off-peak / purchase-funnel 节点、精确引用搜索和旧代码对照。改变展示归类、首页准入和事件构造，不改事实生产、同步或持久化。

```text
Registry Settings View → 套餐分类 → 首页闲时入口 / 购买漏斗
实际提交 / 请求事实   → 事件字段构造 → 旧统计 ID → 原有上报渠道
                          ↑
                纯映射，不查询或修改账号
```

纯映射供事件构造复用，不放全局 transport；事实仍为真实 ID。Step/Completion 映射最终归因（包括子任务和 seed），不改生命周期、usage 或去重。Web 平台 no-op、桌面 continuous、手机 replayable 均不改。报告经测试平台捕获，不向生产采集端发送。

## 验收矩阵

| 组   | 必须成立                                                                                          |
| ---- | ------------------------------------------------------------------------------------------------- |
| 身份 | 个人/Team/Start/闲时两家对称；旧值不变；UUID/未知不猜；模型斜杠冒号百分号不变                     |
| 事件 | send、请求 step/completion、子任务、压缩、自动化、闲时实际 builder/报告负载符合旧值，其他字段不变 |
| 套餐 | Team-only entitled=true 属 Coding Plan；false 不算；Start 独立；空 view unknown；开关不是退订     |
| 漏斗 | BigModel Team 为 MaaS / bigmodel，Z.ai 为 Z_AI / z.ai；上下文冻结、升级单次上报不变               |
| 首页 | Team-only 可进入创建；灰度关闭、dismiss、明确无 Coding Plan 仍阻止；不绕过表单资格                |

不测试购买真实扣款、不改报表或历史统计。真实 Electron 合批验证单独记入账本，组件测试不冒充整机验证。
