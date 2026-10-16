# CUA 权限错误透传与恢复契约

- 日期：2026-08-25
- 状态：已实现，待 MR review
- 关联：producer `zcode-cua` !576、consumer `z-code` !2315

## 决策

ZCode 不再消费或生成 `CUA_PERMISSION_REQUIRED`。CUA Helper/Broker 的失败作为普通 MCP
tool error 进入模型和 ToolCallRow；模型读取准确错误后自行决定调用只读 `request_access`、重新激活
应用或重新观察。普通错误本身仍无 UI 副作用；只有经过 official-CUA authority 校验的实时
`request_access` 结构化权限快照可以触发独立的 Host 确认流程。

## 根因

```text
permission_denied
  -> producer 猜成 macOS TCC
  -> MCP structuredContent 展平成文本
  -> Renderer includes("CUA_PERMISSION_REQUIRED")
  -> 自动请求 Accessibility + Screen Recording
```

`permission_denied` 同时承载 TCC、foreground policy、Windows UIPI、Linux input、无效 native
能力等不同失败。跨层继续细分和二次核对会引入新的状态机，却仍不能从通用错误码证明真实权限缺口。
因此删除自动分类比继续收窄分类更可靠。

## 新链路

```text
Helper/Broker original error
        |
        v
ordinary MCP error + original message + delivery evidence
        |
        +--> ordinary ToolCallRow / continuous / cold replay
        |
        v
model chooses request_access / activate / re-observe / stop

official live request_access typed metadata
        |
        v
desktop-continuous local Host rechecks fresh status
        |
        v
ZCode confirmation -> existing permission onboarding
```

## 不变量

- producer 不返回 `CUA_PERMISSION_REQUIRED`，consumer 不扫描该字符串。
- Renderer 不因 tool error 自动打开确认框、系统设置或权限 onboarding。
- 设置页和 Composer 状态入口保留。除此之外，本地 macOS `desktop-continuous` 的官方
  `request_access` 实时结果在明确缺权时可以先弹 ZCode 确认框；用户确认前不得打开系统设置。
- `request_access` 保持只读，不提示系统权限、不创建新 Helper。
- `request_access` 的文本解析只服务 Tool Card 展示，不能成为行为触发器。触发必须来自
  producer namespaced `_meta`、official authority 和严格 runtime schema。
- `action_sent=true` 或 `request_delivery_state=possibly_sent` 时不得自动重放原动作。
- `broker_unavailable` 继续使用 `CUA_NOT_READY`，因为它表达 transport readiness 和重试安全，
  不属于权限推断。
- desktop continuous 与 mobile replayable 展示相同普通失败事实；live permission observation
  只存在于本地 desktop continuous，mobile 不接收该事件、不启动独立 Helper。
- 历史 transcript 中的旧字符串只按普通文本展示，不能重新触发副作用。
- 授权返回后只恢复 Helper 并刷新权限；不发送 task command、continuation 或自动重放工具。

## 覆盖

- producer unit + stdio MCP：TCC 形态和非 TCC `permission_denied` 均原样返回。
- producer fault：`possibly_sent` 保留且 dispatch 不重复。
- consumer unit：Root/ToolCallRow 不挂权限 gate，旧错误文本无副作用。
- consumer live observation：只有 official `request_access` 合法 metadata 触发；第三方同名工具、
  malformed metadata、snapshot/recovery/mobile/remote 均无副作用。
- conversation replay：失败 ToolCallRow、后续 assistant 内容和 cold restore 一致。
- package：相同 semver、不同 buildId 的新包会替换旧 Helper。
- 真实模型：全部使用 Kimi K3，应用最终状态由独立 oracle 验证。

当前 deterministic replay artifact：
`packages/desktop/.e2e-artifacts/desktop-e2e-20260824-194204-941`。该 artifact 证明包含历史
`CUA_PERMISSION_REQUIRED` 文本的普通 MCP error 只生成一个失败工具行，live/cold restore
一致且没有自动权限弹窗；它不替代 Kimi K3 真实模型门禁。
