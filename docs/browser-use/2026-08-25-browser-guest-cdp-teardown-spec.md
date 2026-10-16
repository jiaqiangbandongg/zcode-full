# Browser Use guest CDP teardown 与销毁顺序规格

> 状态：实现中
> 适用范围：Desktop `desktop-continuous` 的 Browser / Browser Use `<webview>` guest。
> 不适用：手机 `web-remote-replayable` 的独立恢复语义、relay/main 中的 session/stream 业务状态。

## 1. 背景与根因

工单 `ZCT-2092076135526567936` 的 `v3.9.1` 构建中，连续 Playwright/CDP 自动化期间出现
ZCode 主进程 native access violation。崩溃前日志同时出现：

```text
detachGuest cdp message cleanup failed ... Object has been destroyed
detachGuest cdp still attached on destroyed guest ...
```

这表明 guest WebContents 已经销毁，但 native DevTools session 尚未主动 detach；在途 CDP 通知随后
访问已析构的 `client_`，触发 Electron/Chromium 侧 UAF。`destroyed` 事件到达后再调用
`debugger.detach()` 已经太晚，不能作为安全兜底。

## 2. 目标与非目标

### 2.1 目标

- guest 的每条销毁、替换、换代路径都必须先经过 main 的 CDP teardown handshake。
- teardown 开始后拒绝新的 CDP dispatch，并使旧 guest command 不能发送到替代 guest。
- renderer 只有在 main 确认 CDP 已断开后，才能卸载或替换 `<webview>`。
- teardown 失败时 fail closed：保留旧 guest 或进入明确错误态，不继续打开已知的 native UAF 窗口。
- 记录 `tabId`、`guestId`、`guestGeneration`、teardown reason、pending CDP 数量和结果，便于和 minidump 关联。

### 2.2 非目标

- 不把手机端 `web-remote-replayable` 的 snapshot/queue 恢复语义引入桌面 continuous 主链路。
- 不通过降低 Playwright 频率、增加 timeout 或裁剪模型返回值来掩盖 native 生命周期问题。
- 不在 `destroyed` 之后尝试“补救” native detach；该事件只用于收尾和异常打点。

## 3. 生命周期状态机

```text
attached(generation=N)
        |
        | acquire CDP lease / pendingCommands++
        v
  command dispatch
        |
        +-----------------------------+
        |                             |
        v                             v
 beginGuestTeardown(reason)      command settled
        |
        ├─ state = detaching
        ├─ reject new command dispatch
        ├─ abort tab-scoped running requests
        ├─ wait pending commands to settle (bounded)
        ├─ debugger.detach() and confirm detached
        └─ resolve detached ACK
                        |
                        v
             renderer replaces/unmounts <webview>
                        |
                        v
                 destroyed → cleanup only
```

同一 tab 的 teardown 必须 single-flight；旧 guest 的 generation 与新 guest 的 generation 不得复用。

## 4. 实现合同

### 4.1 Main 侧 guest teardown

`BrowserGuestManager` 为每个 `ManagedTab` 增加 teardown 状态、generation、teardown promise 和
pending CDP 计数。所有以下入口统一调用 `beginGuestTeardown`：

- `render-process-gone`
- renderer 替换 `<webview>` 前的显式 ACK
- close tab / close window / close session
- residency eviction / suspend
- scope mismatch / guest rebind
- guest recovery

`detachGuest` 只负责状态清理；若它观察到 `destroyed + cdpAttached`，必须保留严重异常记录，不能将其
视为一次成功的 native detach。

### 4.2 CDP command lease

`toControlledView().cdp.send()` 不得直接调用 `guest.debugger.sendCommand()`。必须：

1. 校验当前 guest、generation 和 lifecycle 状态；
2. 增加 pending CDP 计数并注册 finally 收口；
3. teardown 后拒绝新的 command；
4. 旧 command 只能作用于原 guest，不能跨 generation 发送。

### 4.3 Renderer handshake

`UnifiedBrowserView` 的任何可能导致 `<webview>` 消失的状态变化都必须等待：

```text
renderer request replacement
        → main beginGuestTeardown
        → main confirms debugger.detach
        → detached=true ACK
        → setWebviewGeneration / unmount
```

ACK 失败时不得递增 `webviewGeneration`，不得直接卸载旧节点。

### 4.4 Scope/rebind

沿用 `2026-08-23-browser-guest-scope-recovery-spec.md`：tab 冻结 owner scope，attach 返回 typed result，
scope mismatch 使用单飞、有界 rebind；拒绝的 incoming guest 必须清理，避免 orphan WebContents 参与后续
CDP 生命周期。

## 5. 验收标准

### 5.1 单元测试

- teardown 开始后，新 command 返回 `stale_guest` 或 `backend_unavailable`，不调用 debugger。
- 并发 teardown 只执行一次 `debugger.detach()`。
- pending CDP command 期间 teardown 能取消或有界等待，并最终收口计数。
- guest A 换成 guest B 后，旧 command 不会 dispatch 到 B。
- `destroyed + cdpAttached` 被标记为异常，不被记录为正常 detach。

### 5.2 Electron Windows 回归

- forcefully crash / replacement / direct webview unmount 三类路径都先 detach 再 destroyed。
- 连续 1000 次 Playwright locator、DOM snapshot 和 tab 切换不产生新的 native dump。
- 日志不再出现 `cdp still attached on destroyed guest`。
- teardown 失败时 UI fail closed，不出现主进程闪退。
- 桌面 continuous 链路不改变手机 replayable 链路的恢复边界。

## 6. 实施顺序

1. 先补 `BrowserGuestManager` 的 lifecycle/lease/teardown 单测。
2. 实现 main 侧 single-flight teardown 与 CDP send wrapper。
3. 将 renderer 替换和其它销毁入口接入 ACK。
4. 增加 Electron Windows 真实 guest replacement 回归。
5. 通过受影响测试、`pnpm typecheck`、`pnpm lint` 后再进入发布验证。
