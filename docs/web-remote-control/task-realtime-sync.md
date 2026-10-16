# Task Realtime Sync

> 状态：V4 wire v3 当前有效说明。
>
> 桌面和手机 attach 到同一个 host/service/CLI runtime，但连接、订阅和 delivery profile 相互隔离。
> `TaskRealtimeBus` 继续承担 owner lease、stale-run 与跨 host 命令路由；它不保存第二份
> conversation queue、projection 或 replayable 业务状态。

本文描述 ZCode task/session 的实时订阅、snapshot/resync、跨端输入和断线恢复边界。

## 核心不变量

- 本地桌面与 SSH/WSL/Docker 桌面窗口固定为 `desktop-continuous`，走完整 direct continuous 数据流。
- 手机 `/remote` 与 Web remote 固定为 `web-remote-replayable`，走 replayable gap/snapshot 恢复流。
- `clientMode` 和 profile 由 host attachment 可信注入；UI-facing subscribe 不得选择或覆盖。
- 每个 connection 有独立 subscription registry、buffer、fragment assembly 与 resync lifecycle。
- 所有端已提交的 busy/running 输入按 CLI 串行 admission 顺序进入一个 `CommandInbox` FIFO。
- relay/main 只做鉴权、配对、心跳、`rpc-frame`/app payload 与连接级流控信号透传。
- owner/lease/stale-run 继续保证单 owner、阻塞请求和跨 host command 正确，但不拥有 conversation 事实。

最终输入不变量：每条已提交输入必须且只能处于 `queue / guided row / transcript /
explicit rejected|failed|discarded` 之一。

## Process Model

```text
Desktop attachment A                       Mobile /remote attachment B
{connectionId=A, desktop-continuous}       {connectionId=B, web-remote-replayable}
            │                                           │
            │ MessagePort                                │ relay rpc-frame
            └─────────────────┐             ┌────────────┘
                              v             v
                    one Window Host owning local/remote workspace scopes
                    ├─ connection facade A -> sub-a*
                    ├─ connection facade B -> sub-b*
                    ├─ owner / lease / stale-run routing
                    └─ services -> one CLI runtime
                                      ├─ event log / projection
                                      └─ CommandInbox FIFO
```

手机只 attach 到目标桌面窗口唯一 Window Host 中已存在的 local/remote workspace scope；不能另起 Agent runtime、
Host 或 SSH/WSL/Docker session。手机断线释放短生命周期 attachment，不销毁仍在运行的 Host/CLI。

远程 workspace 链路必须贯穿 `workspaceIdentity` 和 `remoteSessionId`。身份 key 使用
`workspaceIdentity?.trim() || workspacePath`；文件读写和进程 cwd 才使用 `workspacePath`。

- relay 只做配对、心跳和 `data.payload` 透传，不解析 task、session、stream、permission 或 snapshot。
- desktop main 只做 workspace bridge、MessagePort attachment、RPC frame 路由和 realtime bus 协调，不直接读写 task repo。
- 手机重连释放的是短生命周期 `BridgeAttachment`，不能销毁仍在运行的 `HostEntry`、services 或 Agent runtime。
- 只有真实关窗、app quit、update install 进入 Host shutdown barrier；最小化到托盘和手机 attachment 断开均不进入。
- 本地 workspace 与远程 workspace 都 attach 到窗口唯一 Host；远程 scope 先由 `remoteSessionId + workspaceIdentity/workspaceKey` 定位 logical session，再由 Host registry 验证 path/identity。多个 SSH logical session 可以共享同一个窗口 Host 内的连接，但手机不能跨 logical session 访问另一个 workspace，也不能新建 SSH/WSL/Docker session。
- 窗口 Host 在 `TaskRealtimeBus` 中只注册一个 `hostId`；owner/lease/session route 继续按 `workspaceKey + taskId` 隔离，session bind/detach 时重新派生 scope，不把 replayable 状态下沉到 main。

## Trusted Connection And Owned Subscription

host 为每个 attachment 分配独立 `connectionId`，并把可信连接上下文注入 V4 service facade：

| attachment                   | trusted clientMode      | profile      |
| ---------------------------- | ----------------------- | ------------ |
| 本地/SSH/WSL/Docker 桌面窗口 | `desktop-continuous`    | `continuous` |
| 手机 `/remote` / Web remote  | `web-remote-replayable` | `replayable` |

`hello/clientHello` 用于协商 wire v3、确认连接身份和记录稳定 `clientId`；客户端上报值不能覆盖 host
注入的 connection/profile。registry 至少维护：

```text
connectionId -> subscriptionId -> {topic, profile, state}
subscriptionId -> owning attachment port
```

按连接协商的能力与 `clientMode` 走同一条注入路径：host 在 `hello` 宣告 `workflowRunDeltas`，客户端只在
host 宣告过时于 `clientHello` 声明，facade 再把结论注入该连接的 subscribe。它与 `clientMode`/`deliveryKind`
正交——`continuous` 和 `replayable` 都可能是声明方或未声明方。未声明的订阅者（如版本守卫尚未把用户换到
新 bundle 的旧手机页面）继续收整键 `workflowRuns`，并按旧的每 run 256 条界钳位，因此它的严格帧校验照常通过。
钳位保留的是**还在动的那些**：状态不是 `completed` 的 actor 与尚未结算的 node 先留，余额按表序补最早的条目，
输出仍按原表序（[presentation.md](../dynamic-workflow/presentation.md)「The run state the pane draws」）。

同一 connection 重订阅同 topic 只替换自己的旧 subscription。CLI 下行 frame 只写给 owning port，
禁止 workspace 广播再由手机按 subId 丢弃桌面帧。port 关闭时一次性 unsubscribe 该 connection 的所有
subscription，并释放 buffer/assembly。一个慢手机 subscription 不能影响桌面或另一 pane。

## Buffer、Frame 与 Resync

publisher 在 profile filter 与 coalesce 后计算每个 subscriber 的 buffer：

- `<= 500 ops` 且 `<= 1 MiB`：正常 drain。
- 任一上限超出：立即清空该 subscriber buffer、标记 resync，下一次只发送最新 snapshot。
- 每个物理 JSON/RPC frame 连 envelope 必须 `<= 1 MiB`；超大 logical snapshot/resume 使用分片。
- topic encoder 对 CLI NDJSON、Channel/Socket 与 mobile relay base64 outer JSON 的实际 envelope 取最大值，因此 desktop continuous 与 mobile replayable 均不会接收超 1 MiB topic notification。
- fragment assembly 单帧上限 16 MiB / 1,024 片，每消费者最多 32 个并发、32 MiB staging、30s；每 subscription 的 `logicalFrameOrdinal` 严格单调，旧 ordinal replay 静默丢弃、同 ordinal 换 id 报冲突，fault/timeout 后保留 tombstone；缺片、冲突、checksum/schema 不符或超限时丢弃整个 assembly，禁止部分 apply。
- publisher 使用 non-destructive reservation：全部 physical wires 被 transport 接受后才 commit 水位；中途失败重试相同 logical id/content，不会把新事件一并清掉。

`onSaturated/onDrained` 是连接级信号。手机链路可经 relay/main 透传到 owning attachment，但
relay/main 不解释 topic、seq 或 snapshot。desktop main 只把 adapter edge 写成 owning MessagePort 的
`connection-flow-v1` sideband；host scope 串行、去重后，以可信 `connectionId` 调
`v4/connection/flow`。CLI saturated 时只跳过该 connection 的 reserve/flush，ingest 和 desktop
continuous sibling 继续；drained 只恢复该 connection，closed 清 pause 并由 owned registry 退订。

客户端 apply 规则：

1. snapshot 完整 assembly 后整体替换，绝不 merge。
2. `toSeq <= localSeq` 的迟到/重复 frame 静默丢弃。
3. `fromSeq != localSeq` 时只发起一个 same-sub 的在途 `v4/conversation/resync`；owned registry
   决定 topic/profile，客户端不能覆盖。
4. recovery flight 持续到 logical frame 成功 apply；resume recovery 再次断档时在同一 flight
   内升级一次 `forceSnapshot`，禁止在 ACK 时清 flight或无限 resume。
5. attachment 重建或 CLI `logEpoch` 改变后，自动重订阅所有活跃 topic。

subscribe ACK 的 `logEpoch` 仅是 admission metadata，不会创建 base；已有 projection 仅可在
ACK=`resume` 且同 epoch 时保留，ACK=`snapshot` 会使它失效到完整 snapshot apply。无 valid base 的
delta 不 apply，fault/overflow 必须 `base:null + forceSnapshot:true`；完整 online snapshot 仍可建 base。
ACK 后 30s 没有完整 recovery logical frame 时 resume 升级一次 force，force 再超时则 UI 明确 ERROR、
task-index topic-local fresh-subscribe。recovery apply 后同批 residual online gap 会启动 successor flight。

conversation、sessions-index 与 workspace-config 使用独立水位和 recovery flight；手机某一 topic
的 gap/fault 不得暂停桌面 sibling 或清空健康的 index/config topic。runtime restart 只失效旧
runtime/subscription，承载该 workspace scope 的 Local/Remote Host frame emitter 保持存活，让现有 listener 驱动 full
re-subscribe；真正 workspace teardown 才释放 emitter。

## Blocking Events And Owner Routing

permission、elicitation、terminal 和 snapshot invalidation 会阻塞 runtime 或决定 UI 收口，必须通过
owned subscription 对同 task 的在线连接可见，或触发 snapshot 对齐，不能被普通 owner-only 内容过滤吞掉。

需要路由给 runtime owner 的命令包括：

- `stop_generation`
- `respond_permission`
- `respond_elicitation`
- remote workspace / bot / proxy fallback 的 conversation command

owner command 必须携带 `workspacePath`、可选 `workspaceIdentity`、`workspaceKey`、`taskId` 和当前
`runId`。main 按 `workspaceKey + taskId` 找 lease 并拒绝 stale run。shared-host 主路径通常直接命中同一
host manager，但不能因此删除 owner/lease；remote workspace proxy、跨 host owner、bot/proxy 和阻塞响应仍依赖它。

## Canonical Input Queue

V4 不再按端拆队列：

```text
desktop send ─┐
              ├─> CLI serialized admission -> CommandInbox FIFO
mobile send ──┘                  |
                                  ├─ queue item
                                  ├─ guided row
                                  ├─ transcript
                                  └─ explicit rejected/failed/discarded
```

手机 V4 绕过 `IZCodeTaskService.enqueueTaskCommand` 的 host runtime command queue；桌面 accepted busy
input 也不再留在 renderer-local queue。owner route 只负责把 command 送到正确 CLI，不改变 CLI admission
顺序。每个 `ConversationInputIntent` 自包含保存 `sourceCommandId`、`queueItemId`、`clientId`、kind、原文、
attachments、delivery、顺序和 steer/dispatch 状态。

guide 不适用、带附件、compact/verifier busy 或 runtime steer reject 时，以原字段 fallback 普通 queue。
empty、超限或 runtime reject 返回显式 `rejected/failed`；UI 保留文本与附件。`editQueueItem` 原地更新，
保留 ID、位置、attachments 与来源 command。

`sendQueuedNow` 固定执行：

```text
reserve(item) -> stop barrier -> start/promote(item) -> remove(item)
     |                                  |
     └─ timeout/failure -> release ─────┘  # 原项原位保留
```

多端或连续点击同一 item 只有一个 reservation owner。

## ACK 对账与进程重启

QueueItem 出现后，UI 仍保留 24 小时 pending-command 记录，直到 transcript、取消、失败或 discarded。
普通 text/goal 可保存可重发 payload；敏感 interaction 只保存 digest。

ACK 丢失或重连时，UI 调用 `commands/query`，每次最多 64 个 `{sessionId, commandId}`。CLI 查找顺序为：

```text
in-flight pinned -> live queue/guide pinned -> settled LRU (512/session)
  -> transcript / message anchor sourceCommandId
  -> timeline marker sourceCommandId
  -> fork child metadata sourceCommandId
  -> discarded input ledger
  -> unknown
```

同 key 查询和执行 single-flight，避免异步查重窗口重复副作用。

`commands/query` 与 execute 共用 `keyGate(sessionId|null, commandId)`；新命令再按固定顺序取得
per-session admission gate。in-flight 与 live input 不参与 LRU 淘汰，只有 settled 命令可被淘汰并回源；
同 session admission 串行，不同 session 可并行。持久化索引按 session 惰性构建、增量更新，并以
`workspaceIdentity?.trim() || workspacePath` 隔离，禁止每次查询全量扫描 transcript。

queue 只保证当前 CLI 进程内可靠。CLI restart 后未进入 transcript/终态的 admitted input 明确返回
`fault.command.inputDiscardedOnRestart` 及持久 `delivery`；`queue/guide` 在旧 runtime 失效后静默结算，
只有未进入 transcript 的 `startNow` 或 `unknown` 提示用户确认重发，绝不自动恢复或重放。普通网络断线
仍从 replayable snapshot 恢复当前 runtime 的权威 queue；relay、main 和 host 不通过私有队列掩盖边界。

## Running Stable Fork

primary turn、foreground subagent、goal continuation 或 goal verifier running 时，可以 fork 更早
`completedSuccess` product turn 的最后一段 completed assistant；compact 仍是 operation lock。

running fork 只复制稳定 transcript、fork 点配置和 fork 点前 goal 状态，不复制 queue、active/background
work 或 continuation inbox，不 rewind 共享 workspace；父 session 原样继续运行。同一 `sourceCommandId`
重试返回同一个 child。completed/idle 的既有 workspace checkpoint 行为本轮不扩大。

## Current Implementation Boundaries

关键落点：

- `packages/desktop/src/main/webRemoteControlSharedHostAttachments.ts`：手机 attach 到已有 host。
- `packages/desktop/src/host/windowRemoteConnectionRegistry.ts`：窗口内远端 connection/logical session 权威。
- `packages/desktop/src/host/windowHostAttachmentRegistry.ts`：可信 clientMode 与 scoped attachment 生命周期。
- `packages/desktop/src/main/taskRealtimeBus.ts`：owner lease、stale-run 和跨 host 路由。
- `packages/shared/src/zcode-protocol-v4/`：V4 wire、topic、command 与 runtime schema。
- `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/`：gateway、publisher、projection 与 CommandInbox。
- `packages/services/src/zcode-agent/`：connection-scoped V4 service facade。
- `packages/ui/src/v4/`：owned subscription client apply、pending-command 对账与 projection store。

relay/main 不得新增 session/task stream、queue、snapshot 或 fork 业务状态；这些状态必须能从 CLI
projection/event log 与 command lookup 恢复。
