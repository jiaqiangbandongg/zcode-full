# `/event/report` 桌面投递可靠性

> 状态：首期实现规范。
>
> 目标：在不阻塞业务、不引入持久化 outbox 的前提下，使已经生成的业务事件尽量与业务数据对齐。

## 范围

首期只修改 Desktop Main 中公共 `TelemetryCore` 的 `/api/v1/event/report` 投递策略。
Renderer 调用点、`IPlatformService`、IPC schema、事件 payload、ARMS、CLI OTLP telemetry 和
Web/mobile `web-remote-replayable` 均保持不变。

业务结果、toast、导航、登录/登出和任务执行均不得等待 telemetry。崩溃、强杀、断电、长期离线、
事件源未生成以及持久化补发不在首期范围。

## 投递合同

### 请求头（2026-09-16）

仅 App `/api/v1/event/report` 复用 `buildZCodeSourceHeadersFromContext` 的完整公共头：User-Agent、HTTP-Referer、X-Title、X-ZCode-App-Version、X-Platform、X-Release-Channel、X-Client-Language、X-Client-Timezone、X-Os-Category、X-Os-Version、X-Device-Mid。语言、时区和设备 ID 与本事件上下文一致；环境来源为当前 endpoint，版本/平台取 App 上下文。缺失或非法值沿用公共函数的归一化规则。

凭据服务仍是登录身份唯一 owner；Main 注入只读 Authorization loader，每次发送（包括重试）从当前活动账户读取 `zcodejwttoken`。账户与事件 user_id 一致且 token 非空时发 `Authorization: Bearer <ZCode JWT>`，匿名、退出、切换到其他账号、凭据读取失败时不带该头。禁止 OAuth token / API key 替代，禁止缓存 JWT、将 JWT 写入事件体或日志。读取后复核活动账户和 user_id，丢弃跨账户异步结果。

上报请求禁用自动重定向，避免服务端 3xx 将携带的身份/设备头转发到其他地址；失败仍沿用有界重试，不扩大目的地。

```text
事件上下文 + 持久化 deviceMid → 公共通参（无额外磁盘读取）
每个 attempt → 凭据服务读取并复核当前账号 → 可选 Bearer JWT → HTTP POST
```

奖励页网页请求不注入这些头，Website 上报不在本次修改范围。Bridge 登录/主题/语言同步、桌面 continuous 和手机 replayable 边界保持不变。

验收：完整公共头与 payload 一致；登录/匿名、退出及切账号、token 轮换、重试凭据重读、读取异常匿名降级；本机 Electron 观测 App 上报携带头，同时奖励页初始/刷新请求不再注入 App 专用头且 Bridge 可用。

验证记录：2026-09-16 相关单测 9 文件 65 项通过；本机 macOS Electron 正式 Rewards 回归 `desktop-e2e-20260916-043702-139` 3/3 通过，runner exit 0。隔离 HTTP fixture 观测登录/退出后的 App 上报，断言全部公共头及可选 Bearer 格式（不输出 JWT）；网页首次/刷新无 App 专用头，Bridge 明暗/语言及菜单流程保持。根 typecheck、desktop typecheck:e2e、lint（47 既存 warnings / 0 errors）、architecture check 通过。未用 Docker；未验证真实服务端验签、Windows/Linux 实机或生产部署。

一个逻辑事件只构造一次 endpoint、完整请求体和 `event_id`，所有 attempt 复用相同值：

```text
logical event (stable event_id + body)
  -> attempt 1
       +-- 2xx ----------------------> delivered
       +-- network/timeout/408/5xx --> wait 300ms -> attempt 2
       +-- 429 ----------------------> wait 1s ----> attempt 2
       `-- other 4xx ----------------> failed
```

- 每次请求 5 秒超时；最多发送两次。
- 2xx 视为服务端接收成功，不解析 response body 业务码。
- 第二次失败后 `TelemetryCore` 保持 reject 语义；既有 UI helper 继续吞掉失败，业务不回滚。
- `TelemetryCore` 记录一条最终脱敏 warn，只含事件名、event ID、attempt 数、状态分类和耗时；
  attempt 级细节仅用 debug。
- 服务端按 `event_id` 去重；验收要求是去重后业务重复为零，原始请求允许出现相同 `event_id`。

## 退出 drain

`TelemetryCore` 跟踪 Main 进程内尚未 settled 的逻辑报告。正常退出时，
`flushPendingReports({ timeoutMs: 2000 })` 与 Host、Cron 和窗口设置清理并行进入
`prepareAppQuit` 屏障。

flush 在 deadline 内持续等待期间新增的 in-flight；集合为空即提前返回。到期后只记录剩余数量，
不取消业务、不改变退出结果，也不无限延长退出。

## 性能边界

- 正常 2xx 路径仍只有一次请求；公共头不新增磁盘 IO，Authorization 每次 attempt 通过现有凭据服务异步读取和复核。
- 重试只发生在可恢复失败，最多额外一次请求。
- 5 秒超时替代无限悬挂，使失败场景的内存和连接占用有界。
- 退出最多并行等待 2 秒，不串行放大现有退出预算。

## 验证与验收

单元测试覆盖网络错误后成功、408/429/5xx、永久 4xx、请求 abort、稳定请求体/event ID、最终告警、
动态 drain 和 drain 超时。Desktop 退出测试验证 telemetry flush 已并行进入现有屏障。

上线后仅统计包含修复版本的 Desktop 客户端，连续观察三个完整自然日。以创建成功的去重
`off_peak_task_id` 为分母，以成功匹配 telemetry 的去重任务数为分子，按业务任务创建日归属。
目标是从约 87.6% 提升到至少 95%，且绝对提升不少于 5 个百分点。

若未达到目标，再单独设计持久化 outbox、启动恢复和长期离线补发。
