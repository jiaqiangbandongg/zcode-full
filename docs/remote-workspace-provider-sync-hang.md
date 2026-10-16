# 远程 workspace 选目录卡死：RPC 永久 pending 毒化 provider 同步 in-flight 缓存

> 事故取证 + 修复设计。对应分支 `fix/ssh-hang-2`。
> 事故版本：3.8.1（commit `99f955e2`）；取证材料：用户日志包 `zcode-logs-full-20260821-100852-ssh-hang`（2026-08-21，本地时区 UTC+8）。
> Provider Refactor 已整体删除涉案的 Registry 同步功能，因此本文只描述 3.8.1 事故和通用 RPC
> dispose 不变量，不再适用于当前 Provider 架构。历史符号和日志原样保留用于取证。

## 0. 修复分析结论（速览）

**结论：confirmed —— 根因已确认，修复方案就绪。**

- **问题本质**：被违反的不变量是「远程 scope 的每一次 RPC 调用，要么收到回包，要么在其传输载体终结时以错误 settle」。`ChannelClient` 在传输死亡时对挂起请求既不 fail 也不 close（`packages/rpc/src/channelClient.ts:233-242` 的 `dispose()` 不 reject pending），模块级 in-flight 缓存（`packages/ui/src/lib/remoteWorkspaceProviderSync.ts:245-248`）把一次永久 pending 放大为该 workspaceKey 所有后续打开全部静默挂死。这与 r1 架构文档已声明的契约直接冲突（`docs/architecture/r1-single-window-host-refactor.md` L109「旧 generation 的异步结果不得覆盖新连接」、L232「换代 fail-closed」）——属实现未兑现既有设计契约，不需要新的产品决策。
- **证据**：09:57:44 `updateProviderRegistry` 已达远端后 0.3 秒连接关闭且 host 无完成记录（对照当天 11 条正常 `OK/FAIL (~2s)`）；10:01 受害流程在快照读取后零后续、同连接文件 RPC 秒级成功（排除传输故障）；`unregisterRemoteWorkspaceSession` 只清理已 bind 的 key 而 sync 先于 bind（中毒残留有代码路径级解释）；红信号断言 6 项两次通过。详见 §2。
- **影响范围**：3.8.1 全量、SSH/WSL/Docker 通用；连接死于 provider 同步窗口即毒化该 workspaceKey，向导/侧栏重连/历史入口全部挂死，仅重启 app 可解。隔离论证：手机 `web-remote-replayable` 的 bridge session 不注入 disposer（store 改动对其 no-op）；`remote.ts` 重连走 `replaceSocket` 不触发 dispose（重放语义不变）；不触碰 `@zcode/protocol` 与持久化格式。
- **推荐修复**（最小完整变更，两点缺一不可，详见 §4）：
  1. **A1** `ChannelClient.dispose(reason?)` reject 全部挂起的 Promise 请求（5 处生产 dispose 调用点已逐一审计，全部是连接终结路径）；
  2. **A2** renderer 侧补上传输终结出口：`messageport.ts` 新 helper 返回 `{services, dispose}`，`RemoteWorkspaceSession` 增可选 `dispose`，store 在 unregister/换代替换时调用，desktop 注册时注入并复用错误码 `ZCODE_REMOTE_WORKSPACE_DISCONNECTED`。
  - 已否决：加超时（掩盖症状、与慢链路冲突、违背"不堆兜底"准则）；仅清 in-flight map（当次流程仍挂死）；仅修 host 侧（回包路径与 attachment 同时断的竞态会漏掉 renderer 挂起）。
- **为什么风险最低**：在不变量的所有权边界（RPC 客户端）修复，上层 sync/向导/重连的既有 catch 路径原样接管（它们本就为 rejection 设计）；`call()` 在 disposed 后本就 reject，A1 只是让 in-flight 与之一致，无 API 语义分叉；dispose 可选注入使 web/手机端零变化；无协议、无持久化、无 UI 变更；单 commit 可整体回滚。
- **验证与剩余风险**：回归测试复刻 09:57→10:01 中毒场景（修复前必须失败），邻域单测 + 门禁 + E2E 候选见 §5；剩余风险（teardown 期 rejection 可见化、服务端早退未闭合）见 §6。

## 1. 症状

用户经远程连接向导连接 SSH 项目（`demo@203.0.113.10:22`），第 4 步「选择目录」中连接成功、目录列表正常显示，点击「选择目录」后按钮永久停在「加载中...」（`selecting=true`），持续 7 分钟以上直到用户提交反馈。关闭弹窗重试同样卡死；只有重启 app 才能恢复。

## 2. 取证结论（已确认）

### 2.1 事件链

```
09:57:20  旧实例退出，新实例(pid 92739)启动
09:57:34  自动重连 demo  requestId=733d0a9a → remoteSessionId=dde16ff8
09:57:43.914  bind workspace context (/home/demo)
09:57:43.937  getProviderRegistrySnapshot OK
09:57:44.03   updateProviderRegistry 发出 ──► 远端已收到并开始处理
                （[remote pid 561744] "为只读会话控制面启动 ZCode agent"、
                 "开始请求 workspace/updateProviderRegistry"、agent started）
09:57:44.499  ✗ 连接关闭（stream.onClose 路径 = 远端 zcode-server 进程退出，
              无 backend-disconnect 详情）──► 回包永不可达
              ├─ ChannelClient 不 reject 挂起请求 → updateProviderRegistry Promise 永久 pending
              ├─ syncTask 永久 pending，滞留在模块级 remoteWorkspaceAppGlobalSyncInFlight
              │  （key = remote:ssh:203.0.113.10:22:demo:/home/demo）
              └─ unregisterRemoteWorkspaceSession 只按"已 bind 的 key"清理；
                 该 session 死于 bind store 映射之前 → 清到 0 个 → 【中毒残留】
10:00:00  用户移除该条目（setting 写入 + credential.delete）
10:00:58  用户经向导重连  requestId=28bf1fee → remoteSessionId=afb4e4d9
10:01:22.875  握手成功(3.8.1) → 第 4 步；10:01:23.6 目录列表加载正常
10:01:25.95≈  用户点「选择目录」(/home/demo)
10:01:25.972  file.resolvePath OK (22.1ms)   ← 新连接完全健康
10:01:25.973  bind OK（attachment 04fe4b07 换代为 36c16718）
10:01:25.994  getProviderRegistrySnapshot OK (0.6ms)
              ──► await 中毒的 09:57 in-flight Promise → 【永久挂起】
              （updateProviderRegistry 从未发出：远端零接收日志；
               commit 从未执行：10:04:25 的 lastWorkspaceSession 写入不含 demo；
               tab 从未创建；无任何报错）
10:08:10  用户打开反馈 → 10:08:43 工单创建 → 10:08:52 导出日志
```

### 2.2 判定依据（事实）

- 正常完成的对照：当天 09:04–09:35 共 11 条 `zcode-session.updateProviderRegistry OK/FAIL (~2s)` host 完成记录；09:57 与 10:01 两次均无完成记录。
- 卡死窗口（10:01:26 → 10:08:52）内：零 `zcode-session/zcode-task` RPC 完成、零 `[remote]` 日志、零 demo 持久化——6 项红信号断言两次运行全部通过。
- 卡死期间同一连接上 `file.readdir`（147ms）、`file.resolvePath`（22ms）秒级成功 → 排除传输层故障。
- renderer 侧「先注册 store 新 services、后 ACK」（`packages/desktop/src/renderer/src/main.tsx` `registerRemoteWorkspaceServicePort`，v3.8.1 同序）→ 排除"发到已换代的死端口"。

### 2.3 复发面

08-21 当天 27 次 bind：4 次 `updateProviderRegistry FAIL`（~2s 完成、用户可见报错，非本缺陷）；1 次确认级中毒+卡死（本事件）；另一个旧实例 的 09:32:00 / 09:37:04 两次 bind 无完成记录（疑似同型，推断级）。该服务器当天反复掉线（00:34–00:55 对 /home/demo 有 8 次重 bind），属高危触发环境。

### 2.4 未知（客户端侧无法闭合）

远端 zcode-server 在启动后 ~1 秒退出的原因（历史记录同型："远程连接已断开 exitCode=0"）。需要远端机器 `~/.zcode/server` 日志或系统日志定性；这是触发器，不是根因。

## 3. 根因分层

| 层级                 | 定性                                                                                                                                             | 位置                                                                                                                                                                                                           |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 触发器               | 远端 zcode-server 启动后即退（环境/服务端，本修复不处理）                                                                                        | 203.0.113.10                                                                                                                                                                                                  |
| **根因（设计缺陷）** | RPC 挂起请求在传输终结时永不 settle：`dispose()` 不 reject pending，`send` 失败静默吞掉，全链路无超时                                            | `packages/rpc/src/channelClient.ts:233-242`                                                                                                                                                                    |
| 放大器               | 模块级 in-flight 缓存把"一次永久 pending"放大为"该 workspaceKey 的所有后续打开全部挂死"（跨连接、跨向导/重连入口）                               | `packages/ui/src/lib/remoteWorkspaceProviderSync.ts:68-76,245-248`                                                                                                                                             |
| 清理盲区             | `unregisterRemoteWorkspaceSession` 只清理已 bind 的 workspaceKey；sync 先于 bind（选目录与重连两条流程皆然），死于 sync 中的 session 无 key 可清 | `packages/ui/src/store/remoteWorkspaceSessionStore.ts:133-148`；流程顺序见 `packages/ui/src/root/useRemoteWorkspaceHistory.ts:582-597`、`packages/ui/src/root/reconnectRemoteWorkspaceHistoryEntry.ts:161-182` |
| 症状载体             | `selecting` 永不复位 → 按钮永久「加载中...」；重连流程同理（spinner 永挂、finally 不执行）                                                       | `packages/ui/src/SSHDialog.tsx:372-416`、`packages/ui/src/RemoteConnectionDialogContent.tsx:486-497`                                                                                                           |

### 被违反的不变量

`docs/architecture/r1-single-window-host-refactor.md` 已声明：

- L109：「连接取消、late completion、重复 dispose 必须幂等；**旧 generation 的异步结果不得覆盖新连接**」
- L232：「Host generation 换代继续 **fail-closed**」

当前实现对死亡传输上的挂起请求既不 fail 也不 close——**悬置**。修复即在 RPC 客户端这一所有权边界上把"悬置"改为"fail-closed"：

> **不变量：远程 scope 的每一次 RPC 调用，要么收到对端回包，要么在其传输载体（attachment MessagePort / SSH stream）终结时以错误 settle。**

## 4. 修复设计（最小完整变更）

两个改动点恢复同一条不变量，缺一不可（只修 host 侧会因"回包路径与 attachment 同时断"的竞态而漏掉 renderer 侧挂起；只清 in-flight map 无法解除当次流程自身的挂死）。

### 4.1 A1 — `ChannelClient.dispose()` reject 全部挂起的 Promise 请求

`packages/rpc/src/channelClient.ts`：

- 新增 `pendingRejections: Map<number, (err: Error) => void>`，在 `requestPromise` 入口登记（**不是**在 `doRequest` 内——覆盖 dispose 早于 Initialize 的排队请求），请求 settle 时随 `handlers.delete(id)` 一并删除。
- `dispose(reason?: Error)`：逐一 reject（默认 `new Error("ChannelClient disposed")`，`name="ConnectionClosed"`）。签名向后兼容 `IDisposable`。
- 事件监听 handler（`requestEvent` 注册的 emitter）不在 reject 范围内——`handlers` map 混存两类，必须用独立 map 区分。
- `call()` 在 disposed 后本就返回 reject（`channelClient.ts:42-44`），本改动使 in-flight 语义与其一致。

**dispose 调用点审计**（全部为连接终结路径，reject 语义正确）：

| 调用点                                                         | 场景                                                                                                        |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `packages/server/src/remote/connect.ts:247`（`beginDisposal`） | host↔远端连接终结（本事故 09:57:44 即此路径）→ 顺带解除 host 侧代理 handler 悬置                            |
| `packages/rpc/src/ipc.ts:138-139`                              | IPCServer 检测到 client 断开                                                                                |
| `packages/rpc/src/ipc.ts:259-260`、`305-306`                   | IPCServer / IPCClient 整体销毁                                                                              |
| `packages/rpc/src/remote.ts:325`                               | 重连客户端最终销毁（注意：中途重连走 `replaceSocket` 复用同一 ChannelClient，不触发 dispose，重放语义不变） |

### 4.2 A2 — renderer 侧 remote session 换代/注销时终结旧传输

现状：`connectViaMessagePort`（`packages/client/src/messageport.ts:20-29`）创建的 `ChannelClient` 与 `MessagePortProtocol` 无人持有、无释放出口；attachment 换代或 session 关闭后旧 client 永远悬置（`MessagePortProtocol.disconnect()` 已存在但无人调用，`packages/rpc/src/protocol.ts:391-396`）。

- `packages/client/src/messageport.ts`：新增导出 `createMessagePortServiceConnection(port): { services: IServiceAccessor; dispose(reason?: Error): void }`，dispose = `client.dispose(reason)` + `protocol.disconnect()`。保留 `connectViaMessagePort` 供窗口生命周期的 base services 使用（不释放，非目标）。
- `packages/ui/src/store/remoteWorkspaceSessionStore.ts`：`RemoteWorkspaceSession` 增加可选 `dispose?: (reason?: Error) => void`；`unregisterSession` 与 `registerSession`（同 sessionId 替换且对象不同——即换代）时调用**被移除条目**的 dispose。依赖注入，store 不接触传输实现。
- `packages/desktop/src/renderer/src/main.tsx` `registerRemoteWorkspaceServicePort`：改用新 helper 并把 disposer 注入注册；reject reason 携带既有规范错误码 `ZCODE_REMOTE_WORKSPACE_DISCONNECTED`（`packages/ui/src/lib/remoteWorkspaceServiceError.ts:1-2`；`channelClient.ts:84-97` 的 `code` 透传路径已存在），与"断连代理"对后续调用的报错保持同码。

### 4.3 修复前后时序

```
修复前（09:57 中毒 → 10:01 受害）：
  sync#1: updateProviderRegistry ──► SSH stream 死亡 ──► Promise 永久 pending
          in-flight[demoKey] 永久滞留（finally 不执行）
  sync#2(新连接): await in-flight[demoKey] ──► 永久挂起，UI 无错误

修复后：
  sync#1: updateProviderRegistry ──► stream 死亡 ──► session 关闭事件
          → unregisterSession → session.dispose() → ChannelClient reject
          → syncTask reject → finally 删除 in-flight[demoKey]
          → 重连流程 catch：落库 failed + toast（既有路径）；向导 catch：显示错误 + 复位按钮（既有路径）
  sync#2(新连接): 无 in-flight → 正常下发 → OK → 打开 workspace
```

### 4.4 不改什么（非目标）

- 不加 RPC 超时（掩盖症状且与慢链路合法耗时冲突，违背"不堆兜底"准则）。
- 不改 `@zcode/protocol`、持久化格式、host 换代/attachment 时序、向导 UI。
- 不动手机 `web-remote-replayable` 链路：`webRemoteControlWorkspaceBridgeSession.ts` 注册的 bridge session 不注入 dispose → store 改动对其为 no-op；其"同 sessionId 晚到 dispose"防护（对象身份比对）与 store 的替换判定同构，互不干扰。
- 服务端 zcode-server 早退：需用户提供远端日志另案处理；修复后该场景从"静默永挂"变为"可见失败 + 可重试"。

## 5. 验证方案（先写测试再实现）

1. **回归测试（复刻本事故）**：`remoteWorkspaceProviderSync` 单测——首次 sync 的 RPC 永不 resolve，触发 session 注销（dispose 注入的 reject）→ 断言 syncTask reject、in-flight 条目移除、第二次 sync 对同 workspaceKey 正常下发并成功。修复前该测试必须失败（第二次 sync 挂死）。
2. `packages/rpc` `channelClient` 单测：dispose reject in-flight；dispose 早于 Initialize 时排队请求同样 reject；事件监听不受影响；已 settle 请求不受影响；reason 透传。
3. `remoteWorkspaceSessionStore` 单测：unregister 调用 dispose；同 sessionId 替换只 dispose 被换下的旧对象；无 dispose 的 session（web bridge 形态）为 no-op。
4. 向导/重连边界：sync reject 时 `handleSelectDirectory` 显示错误并复位 `selecting`；`reconnectRemoteWorkspaceHistoryEntry` 落库 failed + 清理 spinner key（多为既有用例，补 poison 场景）。
5. 门禁：`pnpm typecheck`、`pnpm lint`、`pnpm test:unit:affected`。
6. E2E 候选（`docs/testing/ssh-remote-p0-e2e-plan.md` 追加）：SSH 连接在 provider 同步窗口内断开 → 重新打开同一远程目录成功、无残留卡死。

### 验证执行记录（2026-08-21）

修复提交 `a30f1f453a`（fix(remote): settle pending RPCs on workspace disconnect），验证结果：

- **测试落地**：§5.1–5.3 对应 `packages/ui/test/remoteWorkspaceProviderSync.test.ts`（毒化回归，250ms race）、`packages/rpc/test/channels.test.ts`（dispose reject in-flight / pre-Initialize / 事件订阅不误伤）、`packages/ui/test/useWorkspaceServices.test.ts`（unregister 终结、换代只终结旧代）、`packages/client/test/rendererLogging.test.ts`（disposer 幂等）；§5.4 对应 `packages/ui/test/sshDialogDirectorySelection.test.ts`（reject 后 selecting 复位 + 错误可见 + session 回收时回落设置步骤）。
- **红-绿验证**：临时还原修复前 store → 3 例失败；还原修复前 channelClient → 2 例失败且挂满 60s 超时（即事故行为）；修复态全部通过。
- **门禁**：`pnpm typecheck` 通过；`pnpm lint` 0 error（涉改文件无新增警告）；`pnpm test:unit:affected` 3536/3540 通过，唯一失败为 `repoWikiService.test.ts` 的 `vi.waitFor` 时序 flaky（与本改动无关，复跑及单独运行均通过）。
- **E2E 候选**：已登记为 `SSH-P0-LIFE-03`（candidate，spec 未编写），见 `docs/testing/ssh-remote-p0-e2e-plan.md`。

## 6. 剩余风险

- dispose-reject 会让原先"静默悬置"的路径（窗口/host 销毁时的 in-flight 调用）转为可见 rejection，最坏情况是 teardown 期间多几条 warn 日志；调用点已逐一审计均为终结路径。
- 未传 reason 的 dispose 调用点报通用错误而非 `ZCODE_REMOTE_WORKSPACE_DISCONNECTED`——不影响 settle 语义，仅文案一致性。
- 服务端早退根因未闭合（需远端 artifacts），修复只保证客户端 fail-closed。
