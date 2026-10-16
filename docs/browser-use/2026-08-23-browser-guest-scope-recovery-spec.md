# Browser Use Guest scope 冻结与绑定自愈规格

> 状态：已实现
> 适用范围：Desktop `desktop-continuous` 的 Browser / Browser Use `<webview>` guest。
> 不适用：手机 `web-remote-replayable` 的独立恢复语义、relay/main 中的 session/stream 业务状态。

## 1. 问题定义

Browser Use tab 的 ownership 在 `BrowserViewReady` 创建时冻结为：

```text
(windowId, workspaceKey, remoteSessionId?, sessionId, browserId, browserGeneration)
```

其中：

```text
workspaceKey = workspaceIdentity?.trim() || workspacePath
```

`workspaceKey` 只用于身份与隔离；`workspacePath` 只用于执行和展示。已经创建的 tab 不得因为用户切换
当前 workspace、task 或 remote connection 而重新读取 ambient scope。

线上曾出现 renderer 以旧/当前 workspace scope 上报 guest，main 按 owner scope 拒绝后没有返回结构化
结果，调用方继续等待 attach timeout，最终把 scope 错误显示成 `browser guest not attached`。本规格把
scope 拒绝、guest recovery 和 stale command 防护收敛为一条状态机。

## 2. 状态与事件链路

```text
main owner scope W1/S1
        |
        | BrowserViewReady(W1/S1/tabId/generation)
        v
renderer side-pane tab 冻结 W1/S1
        |
        | did-attach + attachGuest(W1/S1/generation)
        v
main 校验并绑定 guest
        |
        +--> accepted -> resolve recovery flight -> 执行命令
        |
        +--> scope-mismatch / stale / destroyed
                |
                v
          标记当前 generation 失效
                |
                v
          request rebind（沿用 tab owner scope）
                |
                v
          renderer detach ACK -> 替换 webview generation
                |
                v
          新 guest did-attach -> 重新 attach
                |
                v
          一次有界重试；失败则返回 typed error
```

同一 tab 的并发命令共享一个 recovery flight。guest A 被 B 替换期间，捕获 A 的旧命令必须在实际 CDP
dispatch 前返回 `stale_guest`，不得把动作发送到 B。

## 3. 实现合同

### 3.1 scope 传递

- `BrowserUseSidePaneTab` 保存并使用创建时的 `workspaceKey`、`sessionId`、`remoteSessionId`。
- `AnimatedSidePanePanel`、`BrowserUseSidePaneContent`、`UnifiedBrowserView` 不从当前 active workspace
  回填已有 tab 的 identity scope。
- attach 去重 fingerprint 必须包含 guest id、active、workspaceKey、remoteSessionId、sessionId 和
  residency generation；scope 变化即使 guest id 不变也必须重新 attach。
- 远程 workspace 始终保留 `workspaceIdentity` 对应的 workspaceKey 与 `remoteSessionId`，不得只按 path
  判等。

### 3.2 attach 结果

`browserViewAttachGuest` 返回结构化结果。main 仍然 fail-closed，但 scope/session/generation 拒绝不得
静默吞掉或等到通用 timeout；被拒绝且不是当前 guest 的 incoming guest 必须清理，防止 orphan WebContents。

### 3.3 自愈边界

- main 为每个 tab 维护 attaching/recovering 的 single-flight；恢复成功后一次性唤醒所有 waiter。
- scope mismatch 只触发一次受控 rebind/attach retry；不允许无界循环。
- renderer 重建继续先等待 main 的 CDP detach ACK，再替换 webview。
- 正常 task/workspace 切换不卸载存活 guest；guest crash、eviction 或 attach timeout 才进入恢复。
- 完整应用重启不恢复 Browser Tab；32-tab residency 和现有 close 语义保持不变。

## 4. 验收用例

| Case    | 场景                            | 断言                                                        |
| ------- | ------------------------------- | ----------------------------------------------------------- |
| BGR-001 | Tab 属于 W1/S1，界面切到 W2/S2  | attach 仍携带 W1/S1，不发生 scope 漂移                      |
| BGR-002 | 同一 webContentsId 只改变 scope | attach fingerprint 变化，重新上报并由 main 校验             |
| BGR-003 | main 返回 workspace-mismatch    | renderer 收到 typed rejection，不等待通用 10 秒 timeout     |
| BGR-004 | 多个命令同时遇到 missing guest  | 只创建一个 recovery flight，成功后所有 waiter 收敛          |
| BGR-005 | Guest A 在命令等待期间被 B 替换 | 旧命令返回 `backend_unavailable`，不向 B dispatch           |
| BGR-006 | 一次 rebind 仍失败              | 有界 retry 后返回 `backend_unavailable`，tab shell 不泄漏   |
| BGR-007 | local/remote 相同 path          | workspaceIdentity/remoteSessionId 不串，命令与 tab 互不可见 |

## 5. 验证

实现必须通过受影响的 UI/main/IPC 单测、`pnpm typecheck`、`pnpm lint`。Windows Electron 真实回归需要
覆盖 guest idle 后激活、新建 tab、workspace/task 切换和 `render-process-gone`，并确认桌面 continuous
链路没有引入手机 replayable snapshot/queue 语义。
