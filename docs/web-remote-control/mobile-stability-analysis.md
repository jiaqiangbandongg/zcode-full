# Web 远程控制移动端稳定性分析

> 状态：稳定性背景分析，部分“当前风险”已被后续实现修复。
>
> 当前有效架构是 shared-host attachment + 桌面 `continuous` / 手机 `replayable`
> 消息流。具体消息恢复语义以 `docs/web-remote-control/task-realtime-sync.md`
> 和 `docs/web-remote-control/web-remote-control-architecture.md` 为准。

本文分析手机 Web 远程控制“总是断”的主要原因，并给出可以落地的体验优化方向。

## 结论

当前实现的稳定性边界不是单一问题。它同时受三类因素影响：

1. 移动端 Web 平台限制：手机浏览器切到后台、锁屏、系统低电量或内存紧张时，页面可能被隐藏、冻结、丢弃，WebSocket 和 JS 定时器都不能保证继续运行。
2. 当前 mobile transport 恢复策略偏粗糙：已配对后 socket close 会直接整页刷新，缺少按 `visibilitychange` / `pageshow` / `online` 触发的原地恢复状态机。
3. 外部 relay 和网络链路存在半断风险：代码里已经补过 `waiting` 误报、单向通路、relay `INTERNAL` 等实际问题，说明稳定性不只取决于浏览器。

所以，不能简单归因为“Web 技术栈不行”。正确判断是：**Web 可以做这个功能，但不能承诺手机页面在后台长期保持实时控制连接；产品和技术实现都必须围绕“前台实时、后台可恢复”设计。**

## 当前连接模型

当前 `/remote` 使用外部 relay：

```text
mobile browser /remote
  -> WebSocket terminal
  -> external relay wss://zcode.z.ai/ws
  -> WebSocket device
  -> desktop main
  -> shared-host attachment
  -> existing workspace scope in the single Host Process
```

关键点：

- desktop 以 `device` 角色连接 relay。
- mobile web 以 `terminal` 角色连接同一 relay。
- 双端使用 `pair_status_query` / `pair_status_ack` 做平均 10 秒、有界 8~12 秒 jitter 心跳；最近一次 ACK 超过 30 秒未更新时由本地 watchdog 触发重连。
- ZCode 业务消息全部封装在 relay `data.payload`。
- mobile UI 通过 `rpc-frame` 还原为 `IMessagePassingProtocol`，再复用现有 `Root`。
- 手机端不拥有独立 Agent host process；重连只重建 bridge attachment，不销毁仍在运行的 host/runtime。

对应实现：

- `packages/web/src/webRemoteControlTransport.ts`
- `packages/web/src/main.tsx`
- `packages/desktop/src/main/webRemoteControlTransport.ts`
- `packages/desktop/src/main/webRemoteControlManager.ts`
- `docs/web-remote-control/web-remote-control-architecture.md`

## 移动端 Web 的硬边界

### 切 App 或切浏览器 Tab

手机用户切到其他 App 后，页面通常会进入 hidden 状态。现代浏览器为了省电、省内存，可以进一步冻结或丢弃页面。

这会带来几个结果：

- JS timer 可能不再按时运行，10 秒心跳可能延迟很久。
- WebSocket 可能保持一段时间，也可能被系统或网络层关闭。
- 页面被丢弃时，没有 JS 回调可以运行，恢复时等同重新加载。
- `beforeunload` / `unload` 在移动端不可靠，不能作为断线保存和恢复的核心机制。

外部参考：

- Chrome Page Lifecycle: https://developer.chrome.com/docs/web-platform/page-lifecycle-api
- MDN Page Visibility API: https://developer.mozilla.org/en-US/docs/Web/API/Page_Visibility_API
- MDN WebSocket close event: https://developer.mozilla.org/en-US/docs/Web/API/WebSocket/close_event

### 锁屏和息屏

锁屏、息屏比普通切后台更激进。即使浏览器短时间内没有立即关闭 WebSocket，也不能依赖它长期可用。

Screen Wake Lock 可以改善“用户正在前台远控但手机自动息屏”的问题，但不能解决切 App 后后台保活。Wake Lock 只适用于 active / visible document，页面隐藏、设备低电或省电模式下会被释放。

外部参考：

- MDN Screen Wake Lock API: https://developer.mozilla.org/en-US/docs/Web/API/Screen_Wake_Lock_API
- MDN WakeLockSentinel: https://developer.mozilla.org/en-US/docs/Web/API/WakeLockSentinel

## 当前实现中的稳定性边界

### 1. Mobile 已配对后 socket close 不再直接刷新页面

早期实现里，`WebRemoteControlTerminalTransport` 在已配对后收到 close 会调用 `reloadPage()`。当前实现已经改成连接状态机：

- `connecting`
- `authenticating`
- `waiting`
- `paired`
- `reconnecting`
- `suspended`
- `kicked`
- `error`

已配对 socket close、网络变化、后台恢复等路径会优先进入 `reconnecting` / `suspended` 并尝试原地恢复。`reloadPage` 只保留为兜底注入点，不是已配对 close 的主策略。

仍需关注：

- 恢复时间过长时，UI 仍必须给出明确的 reconnecting/suspended 状态。
- 旧 RPC frame 不能盲目 replay，硬恢复应以重新 attach bridge + snapshot 对齐为边界。
- 非幂等业务命令仍需要业务层 accepted ack 或幂等键，而不是依赖 transport 重发。

### 2. Mobile 已有页面生命周期恢复状态机

当前入口已监听移动端关键生命周期事件：

- `visibilitychange`
- `pagehide`
- `pageshow`
- `online`
- Chrome 的 `freeze` / `resume`

页面恢复时会触发 `recoverConnection()`，并通过 bridge/runtime snapshot 重新对齐当前 workspace/task。仍需要关注的是长时间后台后 host 是否仍存在、relay 是否仍 matched，以及 snapshot 是否覆盖 replayable gap。

### 3. Desktop 端仍比 mobile 端更稳定

desktop device transport 在 socket close 后会自动 `scheduleReconnect()`。relay `INTERNAL` 也被当成可恢复错误处理。

mobile terminal transport 现在也具备 `recoverConnection()` 和可恢复状态，但移动浏览器后台冻结、锁屏和系统回收仍是硬边界。因此产品语义仍应是“前台实时，后台可恢复”，不能承诺后台长期在线。

这会造成不对称体验：desktop 可以长期运行并继续持有 host/runtime；mobile 回来后需要通过 replayable stream 和 snapshot 恢复视图。

### 4. Relay 已出现过半断和路由问题

现有代码注释说明已经遇到过几类 relay 问题：

- 外部 relay 边缘层可能只按 `query.mid` 分片，单独依赖 `X-Device-ID` 会让 desktop 和手机落到不同后端。
- 已配对会话里，心跳偶发返回 `waiting`。
- relay 偶发只保留手机到 desktop 的单向通路，desktop 已响应但手机收不到。
- terminal 快速刷新 / 重连时 relay 可能短暂返回 `INTERNAL`。

这些不是移动浏览器后台限制，而是 relay / 网络 / 负载均衡层面的稳定性问题。

### 5. 高频 RPC 依赖同一条 relay 通道

当前业务 RPC、workspace bridge、task realtime mirror 都走同一条 relay data channel。stream mirror 已经做了聚合、seq gap 检测和 snapshot fallback，但当链路抖动时，控制消息和实时更新仍共享同一个通道。

风险：

- 大量 UI stream frame 可能影响控制类请求的响应延迟。
- pending request 超时后，上层难以知道是 desktop 没处理、relay 单向断、还是 mobile 收不到。
- replayable stream 的 gap 可以回退到 snapshot，但 transport 层 RPC frame 仍不能通用 replay。

## 用户可感知的断线场景

| 场景 | 主要原因 | 当前表现 | 可优化方向 |
| --- | --- | --- | --- |
| 手机切到微信/浏览器后台几分钟再回来 | 页面 hidden / frozen / socket close | 刷新或失败页 | 前台恢复时自动重连并恢复 workspace/task |
| 手机锁屏后回来 | 息屏导致 WebSocket 断开或 JS 暂停 | 刷新、卡住或提示 relay unavailable | Wake Lock + 恢复状态机 |
| 移动网络从 Wi-Fi 切 5G | TCP/WebSocket 断开 | 请求超时或失败 | `online` 事件触发 reconnect + request replay |
| relay 短暂抖动 | relay close / INTERNAL / waiting 误报 | desktop 可能恢复，mobile 可能失败 | mobile 使用同等重连策略 |
| relay 单向通路 | mobile 发得到，收不到 desktop 响应 | bootstrap/list 超时 | 请求级超时诊断 + 重建 terminal socket |
| 另一个手机扫码 | relay kick / session conflict | 当前手机被踢 | 保持终态失败，但文案说明原因 |

## 优化建议

### P0: 把“后台会断”产品化处理

目标：不要让用户误以为这是不可恢复崩溃。

建议：

1. 页面进入 hidden 时保存最小恢复状态：
   - `deviceSid`
   - `currentWorkspaceKey`
   - `currentTaskId`
   - `bridgeSessionId`
   - 最近一次成功 pair 时间
   - 最近一次收到 desktop payload 时间
2. 页面回到 visible / pageshow / online 时执行恢复：
   - 检查 socket readyState。
   - 如果 socket 不可用，创建新 terminal socket。
   - 等待 pair matched。
   - 重新发 `bootstrap-request`。
   - 按保存的 workspace/task 发 `workspace-bridge-open`。
   - 重新渲染 Root 或触发 snapshot reload。
3. UI 显示明确状态：
   - “连接已暂停”
   - “正在恢复远程控制”
   - “恢复失败，请重新扫码”

关键原则：后台不承诺实时在线，但前台恢复要尽量自动。

### P0: 改造 mobile transport close 策略

目标：已配对后的 close 不直接刷新。

建议新增状态：

```ts
type WebRemoteControlTerminalTransportState =
  | "idle"
  | "connecting"
  | "authenticating"
  | "waiting"
  | "paired"
  | "reconnecting"
  | "suspended"
  | "kicked"
  | "error";
```

策略：

- `KICKED` / `AUTH_FAILED` / `DEVICE_NOT_FOUND`：终态失败。
- `close` / `error` / `desktop-bootstrap-timeout`：进入 `reconnecting`，指数退避。
- `document.hidden`：进入 `suspended`，停止高频操作，保存恢复状态。
- `document.visible`：立即尝试恢复。

注意 pending request：

- 幂等请求：`bootstrap-request`、`workspace-list-request` 可以自动 replay。
- 切 bridge：可以 replay，但要保证 `bridgeSessionId` 新旧关系明确。
- RPC frame：不能盲目 replay，需要依赖上层 snapshot reconciliation。

### P0: 增加断线诊断日志

目标：让“总是断”能被归因。

Mobile 侧建议记录安全元数据：

- transport state transition。
- WebSocket close `code` / `reason` / `wasClean`。
- `document.visibilityState`。
- `navigator.onLine`。
- hidden 持续时间。
- 最近一次 sent / received payload 时间。
- pending request 类型和超时时间。
- pair status ack: `matched` / `waiting` / `kicked`。

日志注意：

- 不记录 QR URL 原文。
- 不记录 `hash` / `passHash`。
- 不记录 payload 原始 JSON。
- 高频 stream / rpc frame 只记录计数和长度，不记录正文。

### P1: 增加前台 Wake Lock

目标：减少“用户正在看着远控页面，但手机自动息屏导致断开”。

建议：

- 在 `/remote` 进入 active bridge 后请求 `navigator.wakeLock.request("screen")`。
- UI 提供可关闭开关，例如“保持屏幕常亮”。
- 监听 WakeLockSentinel `release`，页面 visible 时自动重新申请。
- 不支持 Wake Lock 时静默降级，提示用户保持屏幕开启即可。

边界：

- Wake Lock 不能后台保活。
- 低电量、省电模式、页面隐藏时会被系统释放。

### P1: 恢复时优先使用 snapshot reconciliation

目标：断线期间任务继续跑，用户回来后能看到最新状态。

建议：

1. terminal 恢复 matched 后，先打开 bridge。
2. bridge ready 后主动拉取：
   - workspace task list
   - active task snapshot
   - 当前 task runtime status
3. 如果 owner run 仍在运行，重新订阅 dynamic task event。
4. 如果 replayable stream 有 gap，不追求补齐每个 chunk，先等待带 `runtime.streamWatermark` 的 snapshot 覆盖缺口，再继续接后续 stream。

这和现有 realtime sync 文档一致：replayable stream 负责断线恢复期间的运行态连续性，snapshot 负责最终一致性和大 gap 对齐。

### P1: Relay 层增加连接代际和可观测性

目标：区分正常重连、旧连接迟到、单向通路和路由错配。

建议 relay / app payload 加安全元数据：

- `connectionId`
- `connectionGeneration`
- `lastPairMatchedAt`
- `lastHeartbeatAckAt`
- device 和 terminal 的 `mid` 路由 shard
- relay close reason 分类

mobile 和 desktop 日志用这些 ID 关联一次断线。

### P2: 控制请求和 stream frame 分级

目标：链路拥塞时优先保证用户操作响应。

建议：

- 给 app payload 增加 priority：
  - high: permission response, stop generation, workspace switch
  - normal: bootstrap, workspace list, platform request
  - low: stream mirror batch
- relay 如果支持队列，优先转发 high / normal。
- desktop main 发送 mirror batch 时继续合并，必要时在 mobile 不可见时暂停 mirror，仅保留 snapshot invalidation。

### P2: PWA / 安装态优化

目标：改善入口和前台体验，但不要把它当后台保活方案。

建议：

- 增加 Web App Manifest，让用户可添加到主屏幕。
- standalone 模式下减少浏览器 UI 干扰。
- 保存最近一次远控恢复状态。

边界：

- iOS / Android 的 PWA 也不能保证后台 WebSocket 长期存活。
- PWA 不能替代原生 App 的后台执行能力。

## 推荐实施顺序

1. **诊断日志先行**：先加 visibility、close code、pending request、pair status 日志，确认用户断线主要发生在哪类场景。
2. **mobile close 不刷新**：把已配对 close 改为 `reconnecting`，保留失败页只给不可恢复错误。
3. **前台恢复状态机**：实现 visible / pageshow / online 自动恢复，并恢复 workspace/task。
4. **Wake Lock**：减少前台息屏导致的断线。
5. **relay 可观测性**：补 connection generation 和 shard 日志。
6. **payload 分级和恢复协议**：优化高频 stream 与控制消息抢通道的问题。

## 验收标准

### 手动场景

1. 手机扫码进入远控，切到其他 App 30 秒后返回，应自动恢复到同一个 workspace/task。
2. 手机扫码进入远控，锁屏 1 分钟后解锁，应自动恢复或显示明确的可重试状态。
3. 手机 Wi-Fi / 蜂窝网络切换后，应自动重连，不应直接进入永久失败页。
4. desktop 端 relay 短断后恢复，mobile 不应必须重新扫码。
5. 另一个手机扫码踢掉当前手机时，当前手机应显示 session conflict，不应无限重连。

### 自动化测试

建议补充单测：

- paired 后 close 进入 reconnecting，而不是 reload。
- `visibilitychange hidden -> visible` 触发 recover。
- `online` 事件触发 recover。
- 幂等 request 在 recover 后 replay。
- `KICKED` 不重连。
- `AUTH_FAILED` 不重连。
- pending RPC frame 不盲目 replay。

### 观测指标

建议统计：

- mobile terminal socket close 次数和 close code 分布。
- hidden 后断线比例。
- visible 后自动恢复成功率。
- recover 平均耗时。
- bootstrap / workspace-list / workspace-bridge-open 超时率。
- relay `waiting` after paired 次数。
- relay 单向通路疑似次数：mobile request sent，desktop response logged sent，但 mobile timeout。

## 面向用户的说明建议

可以在远控页面或帮助文档中明确说明：

> 手机 Web 远控适合前台实时操作。切换 App、锁屏或网络切换时，手机浏览器可能暂停连接；回到页面后 ZCode 会自动恢复到最近的 workspace 和 task。为了获得更稳定的体验，远控过程中请尽量保持页面前台打开，并允许保持屏幕常亮。

这比承诺“不断线”更符合移动 Web 的真实边界，也能降低用户误解。

## P0 落地状态

已实现首批 P0 稳定性优化：

1. mobile terminal transport 新增 `reconnecting` / `suspended` 状态。
2. 已配对 socket close 不再整页刷新，改为原地重连并在重新 paired 后触发 bootstrap。
3. `/remote` 监听 `visibilitychange` / `pagehide` / `pageshow` / `online` / `freeze` / `resume`，页面隐藏时暂停心跳，回到前台或网络恢复时重建 terminal socket。
4. 诊断日志只记录安全元数据：状态流转、close code/reason/wasClean、visibility、online、hidden 持续时间和 pair status，不记录 QR URL、hash、passHash 或业务 payload 正文。
5. 补充自动化测试覆盖 paired close 不刷新、hidden suspended、visible/pageshow/online recover。

暂未实现 Wake Lock、relay connection generation、payload priority 和完整 request replay；这些需要 UI 开关或 relay/app payload 协议扩展，建议按 P1/P2 独立推进。
