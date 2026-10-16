# Coding Plan Entitlement Failure State

## 背景

Model Provider 设置页的 Z.ai / BigModel Start Plan 与 Coding Plan 内容区通过 `useUsageEntitlement` 查询权益状态。此前查询 promise 若在 Windows 网络、代理或系统证书链路下悬挂，Plan Card 会一直停留在 `Checking`，用户无法判断是仍在加载还是已经失败。

## 设计

- Plan Card 不新增整卡 skeleton，也不新增新的视觉层级。
- 权益查询必须有前端超时边界，超时后复用现有 `unavailable` 状态，展示“获取失败 / Fetch failed”。
- 已有缓存且静默刷新超时时，继续保留缓存快照，只退出 loading 并记录错误，避免网络抖动把可用套餐短暂打成空态。
- 无缓存的首次查询超时时，清空快照并进入失败态，避免无限 `Checking`。
- 失败态继续保留现有连接、重试或重新登录入口，不改变 Z.ai / BigModel family mode、provider id 和 entitlement 判断规则。

## 影响面

- 桌面端、Web 端和手机远控共用 UI hook，超时只影响权益展示状态，不改变 provider registry、task realtime、stream 或 replayable/continuous 语义。
- Windows/macOS/Linux 行为统一：底层请求未在超时内 settle 时，都从 `checking` 落到 `unavailable`。

## 个人套餐凭据失败后的主动重新登录

Z.ai / BigModel 个人 Coding Plan 的 `credential-failed` 状态，右侧操作为“重新登录”，说明为“获取套餐失败，请重新登录后重试。”。不将该状态解释为 OAuth 已过期，不自动退出账号。其他失败、未登录、未购买、Start/Team 状态保留原行为。已登录的 Start 套餐获取失败继续提供“重试”，沿用 Host 手动刷新；未登录的 Start 套餐仍走登录入口。

```text
Host Account State: credential-failed → 设置页展示失败提示
用户点击重新登录 → onLogin({ forceOAuth: true })
→ 既有 requestLoginEntry(当前 family) → 统一 OAuth 登录
→ oauth-login-entitlement → Host 重新获取凭据和发布权益
```

登录状态仍由统一登录流程管理；UI 不新增凭据缓存或状态 owner。桌面与手机共用组件，不修改 continuous/replayable 恢复边界。取消或失败沿用已有登录流程，允许再次操作。

验收：两家个人套餐展示重新登录与失败提示，点击必须传 forceOAuth（同 family 已登录也不能退化为静默刷新）；加载期间按钮禁用；其他套餐不出现本次专属操作。组件浏览器覆盖桌面/窄屏、中英文、深浅主题，组件 fixture 不等同完整 Electron/手机远控 OAuth E2E。
