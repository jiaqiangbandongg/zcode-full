# Usage Remaining 刷新策略

日期：2026-06-13（2026-08-14 更新为按需访问刷新）

## 背景

footer 套餐 badge、输入框 context 面板里的 Coding Plan 剩余额度，以及 Start Plan 余额都来自 `useUsageEntitlement`。这些数据会影响用户判断是否还能继续发起任务，因此需要统一刷新策略，避免各入口刷新时机不一致，也避免多个组件同时挂载时放大 quota / billing 请求。

## 策略

- 剩余用量统一为“缓存优先 + 用户访问时校正”：对话 Context 在 hover/open 时触发，模型供应商套餐卡和 Usage 页 Coding Plan tab 在打开时触发。侧栏 footer 套餐徽标是常驻入口，在可见/挂载时触发同样的 access 探测，不依赖用户先访问其它入口预热。
- 三个入口首帧立即回显同一账户/套餐范围的缓存快照，后台校正不阻塞面板展示；无缓存时才展示 loading。
- 自动访问刷新按 `usageStatsService + providerId + organizationId + projectId + provider credential fingerprint` 共享 1 分钟 freshness window。任一入口刚请求过，1 分钟内反复 hover 或打开其他入口都不重复请求。
- 用量刷新必须按权益调度状态执行：
  - `unknown` / `active` / `none` / `unavailable` 都允许用户访问触发校正，但受共享 1 分钟 freshness window 限制。
  - 用户手动刷新、登录/token/provider 指纹变化、购买成功可强制绕过 freshness window，用于重新探测 `none` 或 `unavailable`。
- 同一品牌账号存在 Coding Plan 与 Start Plan 两套入口时，权益调度必须互斥：
  - 只要 Coding Plan provider 已配置，就先查询 Coding Plan。
  - Coding Plan 已有 quota / subscription / remaining 时，只处理 Coding Plan，不再查询或展示同品牌 Start Plan 余额。
  - 只有 Coding Plan provider 未配置，或服务端明确返回 `no_plan`，才允许同品牌 Start Plan 作为兜底入口。
  - Coding Plan 查询中、网络错误、token 过期或 `unavailable` 状态不能降级到 Start Plan，避免把“暂时查不到”误判成“没有 Coding 权益”。
- 不再因任务开始、完成、失败或停止刷新剩余用量，也不再运行 5 分钟/空闲 30 分钟轮询或 `nextResetTime` 定时器。
- Context 每次从关闭变为打开时调用 `reason=access`、`silent=true`；反复 hover 不得重置或延长面板展示，只由共享 freshness window 决定是否发请求。
- 模型供应商套餐卡、Usage 页 Coding Plan tab 和侧栏 footer 在打开/可见时调用同样的 `reason=access`、`silent=true`；Usage 趋势数据也按相同 scope 使用 1 分钟访问 freshness window。
- 用户手动刷新、登录成功、token/provider 指纹变化、购买成功可以重新探测 `none` 状态；这些显式动作用于处理用户刚购买或登录态刚恢复的场景。
- 请求失败后退避：30 秒、60 秒、120 秒、300 秒，成功后清零。
- 同一个服务实例、同一 provider 请求参数和同一 provider 指纹共享一份最新快照；任一入口刷新成功后，其它已挂载入口同步显示。
- 同一时刻的相同请求继续复用 in-flight Promise，避免并发重复请求。

## 边界

- Coding Plan Usage 面板的 quota 是核心数据：quota 网络失败时整体报错；activity / usage-detail / model-performance-day 是可选数据面，单路网络/HTTP 失败只清空对应区域并在服务层记 warn，不拖垮整张面板。HTTP 200 但业务信封失败（如 token expired）仍整体抛错，避免把鉴权错误伪装成空用量。
- `nextResetTime` 表示额度重置时间，不是数据生成时间。
- `UsageEntitlementSnapshot.generatedAt` 表示本地生成快照的时间。
- 缓存中的 `no_plan` 可以用于停止自动、轮询和任务生命周期刷新，但不能永久封死手动刷新、登录/token/provider 指纹变化或购买成功后的重新探测。
- Usage 页 Coding 图表的打开自动刷新受 1 分钟访问 freshness window 限制；用户点击刷新仍强制获取。
- 桌面端和 Web 端均通过 UI hook 触发服务层依赖注入，不直接访问本地文件或 credential。
- 桌面 `desktop-continuous` 与手机 `web-remote-replayable` 都只由各自 renderer 的用户访问触发。额度状态仍留在 UI / shared host 服务，不下沉到 relay 或 desktop main，也不改变两端各自的 stream 恢复边界。
