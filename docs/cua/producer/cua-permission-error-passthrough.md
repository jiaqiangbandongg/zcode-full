# CUA 权限错误透传契约

## 结论

CUA 不再返回或翻译 `CUA_PERMISSION_REQUIRED`。Helper/Broker 的失败统一作为普通 MCP
tool error 返回，模型依据准确的原始错误信息决定是否调用只读 `request_access`、提示用户授权，
或采取重新激活应用、重新观察等其它恢复动作。

## 原因

`permission_denied` 并不等价于 macOS TCC 缺失。前台窗口不匹配、可信 Host 的
`prevent_activation` 策略、Windows UIPI、Linux XTest、无效目标和部分 native capability
失败都可能使用该错误码。producer 无法仅凭通用错误码可靠判断权限种类；consumer 再根据错误
文本自动弹权限框会把一次不可靠推断扩散成产品行为。

## 运行时契约

```text
Helper/Broker error
        |
        v
ordinary MCP tool error + original message + delivery evidence
        |
        v
model chooses request_access / re-observe / activate / stop

official request_access success (macOS only)
        |
        v
read-only text result + namespaced typed permission metadata
        |
        v
trusted ZCode Host may ask the user whether to open onboarding
```

- 不存在 producer 级 macOS 权限翻译分支。
- 不存在 consumer 级错误文本扫描或由普通错误触发的自动权限弹窗。
- `request_access` 保持只读，只报告当前授权主体、权限状态和能力，不主动弹系统框。
- macOS 成功结果在 MCP result `_meta["zcode.cua/request-access-status-v1"]` 携带严格、
  版本化的权限快照，供已经验证 official-CUA authority 的可信 Host 响应；模型可见 JSON
  文本保持原样。非 macOS、字段缺失或枚举非法时不输出该 metadata。
- `accessibility=denied|stale` 与 `screenRecording=denied` 是确定缺权；`unknown`
  不足以触发权限引导。
- Host 必须同时确认 official-CUA authority、精确 `request_access` 工具名和 live desktop
  delivery，再由 UI 重新读取新鲜状态并询问用户。producer 自身不打开系统设置。
- 设置页保留用户主动发起的权限引导。
- `action_sent`、`request_delivery_state` 和 `retryable` 仍是安全事实；
  `possibly_sent` 的非幂等动作不得自动重放。
- `broker_unavailable` 继续使用已有 `CUA_NOT_READY` 契约，因为它表达 transport readiness
  和安全重试边界，不是权限分类。
- macOS、Windows、Linux 使用同一错误透传规则，不根据 `process.platform` 改写错误含义。

## 模型恢复规则

- 错误明确提到 Accessibility 或 Screen Recording 时，可以调用一次 `request_access` 获取状态。
  如果结果明确缺权，告知用户需要授权并结束当前轮；不得继续 CUA、自动重试或承诺授权后自动继续。
- 错误属于 foreground、focus policy、stale target 或 capability 时，按原始错误给出的恢复路径处理，
  不推断为 macOS 权限问题。
- `possibly_sent` 时先重新观察或读取独立业务状态，禁止原样重放动作。

## 验证

- 真实 stdio MCP：`permission_denied` 原始 message 到达模型，结果中没有
  `CUA_PERMISSION_REQUIRED`。
- `broker_unavailable`：仍返回 `CUA_NOT_READY`。
- `possibly_sent`：delivery evidence 保留，native dispatch 不重复。
- consumer replay：普通失败 ToolCallRow 正常显示，live/cold restore 一致，无自动权限弹窗。
- `request_access` metadata：macOS 合法状态按 schema 输出，文本逐字不变；非 macOS、字段
  缺失和非法枚举不输出可信 metadata。
- 真实模型门禁统一使用 eval provider 配置指定的真实模型；最终成功必须由 fixture-owned 应用状态验证。
