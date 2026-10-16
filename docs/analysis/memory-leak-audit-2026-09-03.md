# 内存泄漏静态审计（2026-09-03）

背景：用户反馈桌面端内存持续增长。本次对全仓做只读静态审计，按进程边界分 6 路（desktop main/host、services、UI store/hooks、UI 组件、agent CLI、rpc/server/shared），共约 90 万行源码（不含测试）。每条发现均已阅读上下文确认清理路径缺失，纯 grep 命中未收录；标 ✔ 的条目由主审二次核实源码。

审计结论只定位风险，不含代码修改。修复前需先在 spec 层面确认设计取舍（见「需要决策的设计问题」）。

## 进程视角：内存都涨在哪

```
 Renderer (每个窗口)                Local Host (每个窗口)             Agent CLI (每个 workspace)
 ┌──────────────────────┐         ┌──────────────────────┐        ┌──────────────────────────┐
 │ shiki tokensCache    │         │ bots watchTaskStream │        │ InMemorySessionEventStore│
 │ task snapshot 缓存   │         │ pty / fs.watch 悬空  │        │   每 token 一条事件       │
 │ rows.window 只增     │         │ per-session 镜像状态 │        │   append O(n) 拷贝        │
 │ workspaces 桶不删    │         │ 远端断连 handle 不释放│        │ 子 session publisher 不释放│
 └──────────────────────┘         └──────────────────────┘        │ backgroundTasks / registry│
                                                                  └──────────────────────────┘
 Main (单例)
 ┌────────────────────────────────────────────┐
 │ will-download 监听挂 defaultSession，关窗即漏 │
 │ TaskRealtimeBus.streamBatches 非终态不删     │
 │ cron 终态订阅 / 心跳 interval 可能永驻       │
 └────────────────────────────────────────────┘
```

## 一、高危（每条都能独立解释「持续增长」）

### CLI-H1 ✔ 生产 session 用内存 event store，逐 token 事件永久驻留，append 全量拷贝

- `apps/zcode-cli/packages/adapters/src/storage/index.ts:26-60`：`eventsBySession: Map<SessionId, SessionEvent[]>`，`append` 做 `set(id, [...events, storedEvent])`，O(n) 拷贝；只有 `deleteSession` 能删，core/bootstrap 无任何调用方。
- `bootstrap/src/zcode-protocol/server-operations.ts:3493`、`bootstrap/src/app/create-app.ts:558`：每个协议 session record 都 `createInMemorySessionEventStore()`。
- `core/src/runtime/methods/model-streaming-event.ts:11-12` → `events.ts:101`：每个 `ModelStreaming` delta 和 `ToolCallProgress` 都进 store；compact（`core/src/compact`、`core/src/context`）不引用 eventStore，不会裁剪。
- 增长：每 token / 每 tool progress 一条，session 驻留期内只增不减；`[...events, x]` 制造 O(n²) 短命垃圾加剧 GC；`rebuildProjection()`（`message-persistence.ts:509`）在 turn 内多处全量 reduce 该数组。
- 注意：`events.ts:79-82` 注释说明 live sink 依赖 eventStore 补号的 `sequenceNumber` 作为唯一顺序事实，因此「瞬态事件不入 store」需要同时保证 seq 分配，属设计变更。

### CLI-H2 Subagent 子 session 的 V4 publisher 永不释放

- `bootstrap/src/zcode-protocol/server-operations.ts:3225` 把子 sessionId 事件路由到 `v4Gateway.ingestDetachedLiveSession`（`v4-gateway.ts:810-816`），为子 id 创建 `ConversationTopicPublisher`（完整 projection + 2000 条日志）、`rawSequenceStates`、`detachedLiveSessions`、telemetry normalizer。
- 唯一释放路径 `cleanupSessionRuntime(sessionId)`（`v4-gateway.ts:1988-2041`）的所有调用方传的都是父 id，没有父→子映射。
- 增长：每次 subagent 运行泄漏一整套 publisher，父 session 关闭/去激活后仍驻留到进程退出。违反 `docs/session-idle-deactivation.md` 第 5 条不变量。

### UI-H1 ✔ shiki token 缓存无上限，流式 Edit 预览每个 chunk 写一条

- `packages/ui/src/lib/shikiHighlighter.ts:59` `tokensCache`，写入 `:173`，全文件无 delete/clear/上限。key 含 `code.length + 首尾 100 字符`。
- 调用链 `ToolCallBlocks/renderers/edit.tsx` → `EditInlineDiffContent.tsx:77` → `highlighted-lightweight-diff-preview.tsx:66`；`fileSummaries.ts:234-238` 用 `input.old_string/new_string` 现场合成 diff，工具输入流式投影时每个 chunk 生成新 patch 新 key，每个中间态都被 tokenize 并永久缓存。单条最多 120k 字符，`tokens` 是二维 ThemedToken 数组，体积数倍于源文本。
- 两路 UI 审计独立指认同一条。

### UI-H2 ✔ task snapshot 内存缓存无上限

- `packages/ui/src/hooks/useZCodeTaskService.ts:15-18`：`snapshotCacheByService: WeakMap<service, Map<key, {etag, snapshot}>>`，外层 key 是 app 级单例等于永久；内层 value 是完整 `ZCodeTaskSnapshot`（含 messages）。只在 `:276` snapshot 为空时删。持久层同文件有 20 条 / 2MB / 256KB 三重上限，内存层没有。
- 增长：每打开一个 task +1，同 task 换 messageLimit/model/thoughtLevel 再 +1。

### MAIN-H1 ✔ `will-download` 监听挂在进程级 defaultSession，关窗必漏

- `packages/desktop/src/main/browserView/browserGuestManager.ts:2931-2932`、`:3651`、`:3661`。webview 未设 partition（文件内无 `partition`），`guest.session` 即 `defaultSession`。`detachGuest` 里 `if (!guestDestroyed) tab.downloadCleanup?.()`，guest 已销毁则跳过，随后 `finally` 把 `downloadCleanup` 置 undefined，再无机会清理。
- `index.ts:2388` `win.on("closed") → closeWindow()` 必然命中（窗口关闭时 guest 已随 embedder 销毁）。每关一个窗口泄漏 N 个闭包（N = tab 数），闭包持有 tab/owner/manager；>10 个触发 `MaxListenersExceededWarning`。
- 修复：`setupDownloadTracking` 先 `const guestSession = guest.session`，cleanup 用该引用 `removeListener`，`detachGuest` 无条件调用。

### MAIN-H2 ✔ `TaskRealtimeBus.streamBatches` 非终态结束的 run 永不删除

- `packages/desktop/src/main/taskRealtimeBus.ts:129`，delete 仅 `:508`、`:532` 两处且都要求 `event.terminal`；`releaseLease`（`:353`）/`releaseLeasesForHost`（`:369`）只 `flushBatch` 不删；`unregisterHost` 不碰。
- host 侧 `host/index.ts:1297-1310` 在 `finally` 无条件 release lease，中断/取消/`sendPrompt` 抛错/远端断连均不产生终态事件。
- 增长：每个非终态结束的 run 泄漏一个 `PendingStreamBatch`（replay 上限 60 批 / 512KB）；`registerHost` / `updateHostWorkspaceKeys`（`:739`）遍历全部残留 batch 向新 host 重放，开窗越多滚雪球。

### SVC-H1 ✔ bots `watchTaskStream` 的 per-task 状态只在流内终态事件释放

- `packages/services/src/bots/botsService.ts:762` `streamSubscriptions`、`:777` `runningTasks`、`:778` `liveStatusProgressByTaskId`、`:772-776` `typingTargets/typingIntervals`；唯一释放点 `:4827-4877`（`task_complete`/`task_error`）和 `:7416` 整体 dispose。`streamSubscriptions.delete` 全文件仅 `:4877` 一处。
- 不释放路径：`:5643-5661` prompt 失败只删 `runningTasks`；远端 workspace 断连/远端 host 重启后终态永不到达；UI 侧删除任务、CLI 崩溃；`:4833` `writeContext` 抛错跳过 dispose。
- 泄漏对象：stream 订阅 + 整个 `handleStreamEvent` 闭包（整轮 `assistantParts`、`toolCalls` Map、`streamingCardBlocks`）。配套 `:2727-2732` Telegram/微信 typing `setInterval` 每 4s 打网络请求，永不停止。

### SRV-H1 web server `remoteConnections` 与 RemoteConnection 永不释放

- `packages/server/src/http.ts:116, 336-355, 405-431`：`POST /api/connect-remote` 拉起 SSH/Docker/WSL 子进程后 `set(id)`，只在 `/ws/remote/:id` 被消费时 `delete`，无 TTL。被消费后 `socket.onClose`（`:109-112`）从不调用 `connection.dispose()`（`remote/connect.ts:295`），远端 server 子进程、stdio ChannelClient、stderr 监听随每个 web 远程会话累积。

## 二、中危

### 结构性根因 A：services 层缺「按连接归属回收」 ✔

`packages/rpc/src/ipc.ts:137-141` 断连只 `channelServer.dispose()`；services/desktop/server 全目录无 `onDidRemoveConnection` 使用者。凡通过非 Event RPC 创建、按 id 存入注册表的 OS 级资源，客户端异常断连后全部悬空：

- `terminal/terminalService.ts:325, 393-401`：`terminals` Map + node-pty shell 子进程。
- `fileWatcher/fileWatcherService.ts:40, 108-115`：`watchers` Map + `FSWatcher`（`.git` 递归监听）+ debounce timer。

### 结构性根因 B：services 层缺「session 终态 / close 边界」清理

`zcodeAgentService` / `zcodeTaskServiceAdapter` 多组 per-session/per-task 镜像状态只在 workspace client 换代或整体 dispose 才清，`closeSession`/`closeTask`/`deleteTask`/`session.removed` 都不触碰：

- `zcode-agent/zcodeAgentService.ts:1385, 2119-2137` `sessionEventSequenceStates`（单 entry 上限 1 万 id，约 1~2MB/繁忙 session）。
- `:1388-1389` `pendingPermissions`/`pendingUserInputs` 只写不读（死代码泄漏，每次权限请求一条）。
- `:1333, 1879-1888, 2107-2117` `sessionEmitters` 只增不减，且 `emitWorkspaceEvent` 全表线性扫描；同文件 `pluginOperationProgressEmitters` 已用 `onDidRemoveLastListener` 自回收，可照搬。
- `:1398-1399` `runtimeModelConfigBySessionKey`、`:1444` `sessionTraceIdBySessionKey`（`listSessions` 每次灌入整个 workspace 历史）。
- `zcode-agent/zcodeTaskServiceAdapter.ts:263, 512-530, 553-575` 失败的 host command 永留 `runtimeCommands`（含 content + base64 附件），且让 task 永远「活跃」。
- `:269, 994-1010, 4344-4353` `toolProjectionMemoryByTaskKey` 持有完整工具输入（Write/Edit 整文件），只在 tool result 到达时 forget；`clearToolProjectionMemory`（`:1008`）是死代码。
- `:259-272` `taskEmitters`/`globalTaskEmitters`/`overlays`/`taskTargets`/`apiRetryByTaskKey`/`backgroundTaskControlsByTaskKey`/`legacySnapshotTaskKeys` 只有 disposeAll 才清。
- `:267-268, 595-598` adapter 不订阅 runtime lifecycle，CLI 崩溃后 `activePromptInputIds` 残留，`drainRuntimeCommands` 永远早退，后续 enqueue 命令持续累积。

### 结构性根因 C：main→host 缺「本地 workspace 关闭」消息

- `host/windowHostControllerService.ts:278-329`、`host/index.ts:1178-1210, 1370-1390, 2693-2696`、`hostRemoteWorkspaceProxyState.ts:38-70`：`removeSource/disconnectSource` 仅对 remote 调用，本地 workspace source（三份 task meta + 事件订阅 + sessions-index observer）与 `taskMetaById` 永不删除。

### 其余中危

| 位置 | 问题 |
| --- | --- |
| `host/windowRemoteConnectionRegistry.ts:390-411` | 远端意外断开后 `handleConnectionClosed` 不调 `disposeEntry`，整套 ServiceCollection/SSH backend 持到用户关 tab |
| `host/index.ts:791-840, 552-578`、`host/cronRunLifecycle.ts:40-58` | cron/off-peak 终态订阅只在 `inputId === traceId` 时释放；session 删除、agent 崩溃、并发 prompt 覆盖 inputId 都永不命中；manual run 额外一个 60s SQLite 心跳 interval |
| `main/browserView/browserPlaywrightLocatorExecutor.ts:1114-1155` 等 | 每条 CDP 命令 `Page.createIsolatedWorld` 新建 V8 context 并全量重注入 Playwright runtime，SPA 不导航则持续累积（guest renderer 内存） |
| `main/browserView/electronBrowserWebmRecorder.ts:286` | 每次录屏 `session.fromPartition(随机名)`，Electron partition 无销毁 API |
| `main/cuaPermissionDragPanel.ts:128-183`、`desktopCuaPermissionIpc.ts:194-222` | `destroy()` 后迟到的 `show()` 重建 BrowserWindow + 150ms interval，无人再销毁 |
| `main/appTelemetryRuntime.ts:34,85` | `rendererContexts` 按 webContents.id 只增不删 |
| `main/desktopHostProcess.ts:695-731` | reload-respawn 时旧 host exit 回调按共享 key 反注册，误删新 host（正确性缺陷） |
| `bots/botRemoteWorkspaceBridge.ts:56, 208-244, 268-276` | `runtimeServicesByWorkspaceKey` 断连/重连都不失效，pending 永不 settle，dispose 直接 clear 不 resolve |
| `ui/v4/conversationProjectionStore.ts:696-704` + `shared/zcode-protocol-v4/apply.ts:78-83` | live 期间 `rows.window` 只增不减，每条 delta 全数组拷贝 + O(N) findIndex；`loadAllOlder`（`:1018-1150`）宽屏时把全量历史合入 window |
| `ui/store/zcodeSessionStore.ts` + `tabStore.ts:346` | `workspaces[workspaceKey]` 桶全仓无删除路径；`remoteTimelineTaskStore`/`remotePinnedTaskStore` 有 `clearWorkspace` 但无调用者 |
| `ui/store/taskQueryCacheStore.ts:472`、`hooks/useWorkspaceTaskLists.ts:320-322` | queryKey 含 `limit::version`，每次 bump/展开更多都新增 key 不删旧 |
| `ui/v4/windowControllerTaskListRegistry.ts:78, 218-228` | `queryCache` 以含搜索词的 key 缓存整份结果，搜索框每次击键 +1 |
| `ui/feedback/feedbackSubmissionJob.ts:115, 410` | 失败的 job 永不删，持有截图 base64 ×2 |
| `ui/v4/telemetry/ConversationTelemetryAttachment.tsx:222-240` | `useMemo` 内做 acquire 副作用，被丢弃的渲染无对应 release，refCount 永远 >0，supervisor 无法释放 |
| `ui/terminal/sidePaneTerminalSessionRegistry.ts:58` | 常驻 xterm 实例无上限，detached 状态 PTY 输出仍写 scrollback（设计如此，但持续吃内存） |
| `rpc/src/channelServer.ts:224-248, 270-277` | 未注册 channel 的 `pendingRequests`（含参数）超时不删；远端 host 不注册 `cuaPermissionService` 等 channel 时每次调用 +1 |
| `rpc/src/channelClient.ts:151-178` + `proxy-channel.ts:131-132` | 事件 handler 在创建时即注册，Proxy 每次访问 `service.onXxx` 都新建；同时有「取消订阅后再订阅收不到事件」的正确性 bug |
| `rpc/src/ipc.ts:119-145` | `IPCServer.disposables` 每连接只增不减（当前无生产调用方，潜伏） |
| `web/src/main.tsx:1865-1881, 2200-2232` + `client/src/websocket.ts:102-105` | Web 端 bridge 切换时 ChannelClient 无句柄 dispose，in-flight RPC 永不 settle；桌面端同类问题已修（`messageport.ts:19-24` 注释），web 未同步 |
| `rpc/src/remote.ts:294-321` + `persistent-protocol.ts:151-162, 274-285` | 重连不关旧 socket、可并发多条重连链、失败后两个 interval 仍跑（当前无生产调用方） |
| `shared/zcode-protocol-v4/wire-assembler.ts:146, 465-491` | `settledByRoute` tombstone 无上限，调用方从不 `discard()` |
| `cli adapters/src/exec/node-execution-adapter-base.ts:32` | `backgroundTasks` 永不删除，每条持完整 stdout（30K–150K 字符）+ AbortController |
| `cli core/src/runtime-task/registry.ts:97-137` | 终态 subagent/Workflow 保留完整 `output` + `prompt`；`removeRuntimeBackgroundTask` 对 `Agent` 返回 undefined 所以 `local_agent` 永不移除 |
| `cli core/src/tool/executor/background-tasks.ts:311, 250-301` | 每后台任务一个 1s `setInterval`，emit 失败无限重试；`ToolExecutorImpl` 无 dispose，session 关闭时可钉住整个 runtime |
| `cli core/src/tool/executor/impl.ts:57` + `handlers/read.ts:366` 等 | `readFileState` 存全文，key = path+offset+limit，只在 compact 时清 |
| `cli bootstrap/src/zcode-protocol-v4/persistent-command-index.ts:41,97` | `sessions` 在 close/去激活时不清理，注释所述 LRU 不存在 |
| `cli v4-gateway.ts:1955-1960` | `disposeSession` 传 `clearCommandInbox: false`，每个关闭的 session 留下 512 条 ack 桶 |
| `cli server-operations.ts:1861` + `session-residency.ts:79` | `legacyStreamSubscribed` 置位后永不清除（无 unsubscribe RPC），桌面端仍走此路径（`services/.../zcodeTaskServiceAdapter.ts:3306`），命中即整个 record 永不去激活，叠加 CLI-H1 成为持续增长 |

## 三、低危（摘要）

- main：`closedTabIds` tombstone 无上限；`closeWindow()` 绕过 `closeTab()` 遗留 downloads/scope 表；`sessionRoutes` session 关闭不删；`desktopRemoteSessions` `PendingConnect` 无超时；`webRemoteControlManager.stopWindowRuntime` 不删 `availableTasksByWindowId`；`promptAttachmentTransferService` 未订阅的 emitter 永驻；host→main pending 请求无超时；`hostLogRelay.rawLogs` 首条结构化日志前无界；`fetchRemoteAppConfig` 无超时无大小上限；`applicationIcons` 永久缓存 null。
- services：`ZCodeAgentProcessManager.ownedProcesses` cleanup 失败永久保留；`attachmentFlowRoutes` commit/abort 不删；syncer per-workspace 状态无释放入口；`workspaceProviderRegistryByKey` 只增；feedback `uploadOssForm` 缺 error 监听 Promise 永不 settle；feishu `typingReactionIds` 模块级只在 DELETE 成功后删、`userDisplayNameCache` 不驱逐；`bindCodes`/`recentRemoteReconnectAtByKey` 不修剪；`cuaOperationTurnTracker.lastSeqBySession` session-closed 不清；`featureGates` 按 apiKey 累积。
- ui：`useComposerAttachments` 三个 Map ref 无卸载清理（在途上传不 abort）；`conversationProjectionStore.close()` 不清 listeners/snapshot；`optimisticCommands` 非 sendText 无 TTL；`useRemoteConnectionLogs` 无上限；`workspaceHomePathCache`/`statusCache` key 含重连 id；`ToolLayout.toolLayoutOpenState` 无界；`ConversationRowView` PDF 预览 blob/Abort 无卸载清理。
- cli：`sleep()` 正常唤醒不移除 abort 监听；协议 record 内 `seqBySourceEventKey`/`streamedToolCallIdsWithInput` 无界；`RawSequenceState.seenEventIds/appliedEventIds` 无界；`waitForBackgroundTask` 中止后残留续体；`requestClient` 重播每小时约 360 个 pending key；MCP telemetry 采样失败记录不释放；`node-repl` 闭包钉住首个 context。
- rpc/shared：`getChannel` filter 无匹配时监听器挂起；`EventMultiplexer.disposables` 连接断开不移除；`CancellationTokenSource` 只 cancel 不 dispose。

## 四、已确认干净的区域（覆盖说明）

- main：窗口级 Map 在 `browser-window-created → closed` 统一删；per-host 监听随 UtilityProcess 消亡；BroadcastHub claims TTL+上限；TaskRealtimeBus 其余表有超时/上限；telemetry 族样本有上限；autoUpdater/OAuth/CUA/webRemoteControl transport timer 成对；preload 36 个 `on*` 均返回取消函数；全范围无 `setMaxListeners`、无 `fs.watch`。
- services：`zcodeStdioTransport`/`zcodeProtocolClient` pending 全路径 delete；`zcodeAgentProcessManager` 主表清理完整；`zcodeAgentConnectionScope` 1024 帧/32MiB 双限；coalescer 有界；git/process/repo-snapshot/repo-wiki/telemetryCore/settings-sync/plugin-sync/model-provider 全部 finally 清理；`node.ts` disposeAll 覆盖完整。
- ui：`logger.ts` 不缓冲；流式文本为字符串拼接不留 chunk 数组；`removeTaskState` 完整删除 7 个子表；时间线虚拟化 + 4000 条 LRU 行高缓存；所有 Observer 均 disconnect；createObjectURL 除 PDF 预览外均配对 revoke；streamdown 缓存 100 条；`v4` 注册表 keep-warm 后 dispose；`pendingCommandRegistry` 24h TTL。
- cli：`SessionResidentPool` 四条删除路径完整（但 eligible 条件被 legacy subscribe 钉死，见中危表）；provider 流式不留 SSE chunk，abort listener/linked controller finally 清理；http `maxResponseBytes` + `reader.cancel`；telemetry `maxActiveCalls=1000`、OTLP 队列 2000、trace writers 5000；MCP per-session lease 归零 30s 关闭；前台 Bash 输出有界、`activeExecutions` finally 清理；subagent runner abort/watchdog 全路径 dispose。
- rpc/server/shared：`ChannelClient`/`ChannelServer` 主表四路径删除；Logging/NetworkTelemetry 中间件无状态；`PersistentProtocol` 重放 8MiB/45s 双限；server `hostCapability` TTL；`remote/connect.ts` dispose 完整；web 远控 6 个 timer 成对、`pairedWaiters` 全路径删；renderer bootstrap 全部返回 cleanup。

## 五、需要决策的设计问题（修复前先定）

1. **CLI event store 的职责**：`ModelStreaming`/`ToolCallProgress` 是否应入 store。若不入，live sink 的 `sequenceNumber` 需另行分配（`events.ts:79-82` 注释明确 seq 只能来自 store）。备选：入 store 后在 `ModelComplete`/`ToolCallResult` 时丢弃瞬态事件，并把 append 改为原地 push。
2. **legacy `session/subscribe` 钉死常驻**：需要新增 legacy unsubscribe RPC，或在消费者连接断开时清标记，否则 `SessionResidentPool` 对桌面端打开过的 session 形同虚设。
3. **main→host 本地 workspace 关闭消息**：`HostMessageTypes` 需新增一条，一次清掉 controller source、`workspaceProxyState`、`workspaceTaskTracker`，同时 services 层增加 `forgetSessionState(sessionKey)` / `forgetTaskState(taskKey)` 边界。
4. **RPC 按连接回收**：services 是否统一订阅 `IPCServer.onDidRemoveConnection` 回收 pty/fs.watch，还是给无订阅者资源加空闲超时。

## 六、建议修复顺序

1. 一行级、每次必漏：MAIN-H1（will-download）、MAIN-H2（streamBatches）、UI-H1（shiki LRU）、UI-H2（snapshot LRU）。
2. bots `releaseTaskWatch` 统一释放 + typing interval 上限（SVC-H1）。
3. CLI-H2 父→子 publisher 映射；CLI M5/M6 让 close/去激活真正无残留。
4. 设计决策 1、2（CLI event store + legacy subscribe），这是长会话「持续增长」最主要的根因。
5. 结构性根因 A/B/C 各补一个统一边界。
6. 其余中低危按模块顺带处理。

## 七、验证建议

- 修复前先抓运行时证据：renderer 用 DevTools heap snapshot 对比 `TokenizedCode`/`ZCodeTaskSnapshot` 实例数；host/CLI 用 `process.memoryUsage()` 定时打点 + `--heapsnapshot-signal`，对比 `SessionEvent`、`PendingStreamBatch`、`streamSubscriptions` 大小。
- 复现脚本：开关窗口 20 次看 main 进程 `defaultSession.listenerCount("will-download")`；一个 session 连续跑 30 轮流式输出看 CLI RSS 曲线；bot 场景断开远端 workspace 后观察 typing 请求是否停止。

## 八、2026-09-04 真机日志观察（诊断日志上线后）

- **event store 保留策略已验证**：父 session 下一 turn 开始时淘汰量与上一 turn 瞬态数完全一致；subagent 子 session 一次性 turn 靠 2 分钟时间兜底清掉（7554 行 → 254 行）。子 session record 完成后约 3~7 分钟被池子回收。
- **`v4.detachedLive` 每跑一次 subagent +1 且不回落**：审计 CLI-H2 成立，待修。
- **host 进程 RSS 反复冲到 1.5GB、externalKb 1.3GB，几分钟后回落**：时间点与 repo snapshot（checkpoint）capture 一致。原因是 `repoSnapshotFilter.ts` 对 `.git/` 内部文件无条件放行（绕过 1MB 单文件上限与全部排除规则），本仓库 `.git` 1.2GB，于是**每次 prompt 发送和每个 turn 结束**都打包、sha256、AES 加密并尝试上传一个 1.3GB 的 `.tar.gz.enc`；本 workspace `failureCount=9`，`~/.zcode/v2/checkpoints/*/pending` 下积压 1.77GB（8/27 起）、1.26GB、0.66GB 未上传产物，`~/.zcode/v2` 共 7.6GB。这是产品/spec 层问题（`repo-snapshot-sidecar.md` 要求完整 Git 元信息），不是泄漏；需决策：排除 `.git/objects/pack` 或给 `.git` 设总量上限，或 workspace 超阈值时跳过 capture。
- **远控 relay 互踢死循环**：两个桌面实例用同一账号连 relay，各约 22 次/分钟重连、无退避（另一实例当日 6000+ 次）。对应审计 `webRemoteControlTransport` 重连无退避项。
- **renderer 每 ~25s 一波 10 次 `listTaskList`**（整轮 1189 次），对应审计 UI M6 版本号失效放大。
- **main `taskBus.sessionRoutes` 2565 条**只增不减（约 250KB），对应审计 L4。
