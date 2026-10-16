# 进程拓扑：连接隔离与 CLI 权威事实

> 当前事实（V4 wire v3）：桌面与手机共用同一个 session/runtime 事实源，但拥有彼此隔离的连接、订阅与投递策略。relay、desktop main 和 renderer 都不是 conversation 事实源。

## 1. 一条事实链，两种投递边界

```text
Desktop renderer / SSH/WSL/Docker window
  attachment A
  { connectionId=A, clientMode=desktop-continuous }
  profile=continuous
          │
          │ owned subscriptions only
          v
┌──────────────────────── Host process ────────────────────────┐
│ connection-scoped service facade                            │
│   A registry: sub-a1, sub-a2                                │
│   B registry: sub-b1                                        │
│   route(frame) -> owner(subscriptionId) 的 attachment port   │
│                                                              │
│ owner / lease / stale-run: 只负责跨 host 命令和阻塞请求路由 │
│ relay/main: 鉴权、配对、心跳、payload/拥塞信号透传           │
└──────────────────────────┬───────────────────────────────────┘
                           │ stdio / @zcode/protocol-v4
                           v
┌──────────────────────── CLI runtime ─────────────────────────┐
│ event log -> Projection -> per-subscriber publisher          │
│ CommandInbox FIFO -> queue/guided row/transcript             │
│ transcript / marker / child metadata: sourceCommandId        │
└──────────────────────────────────────────────────────────────┘
                           ^
                           │ shared-host attachment（不另起 runtime）
Mobile / Web remote        │
  attachment B             │
  { connectionId=B, clientMode=web-remote-replayable }
  profile=replayable
```

同一个 session 可以被 A、B 同时订阅。两端看到的中间帧可以因 profile 不同而不同，但最终投影必须逐字段一致；任何一端的慢消费、重订阅或关闭都不得替换或污染另一端。

## 2. 可信连接上下文

每个 RPC attachment 建立时由 host 创建不可伪造的连接上下文：

```ts
interface TrustedConnectionContext {
  connectionId: string;
  clientMode: "desktop-continuous" | "web-remote-replayable";
  deliveryProfile: "continuous" | "replayable";
}
```

映射是固定产品边界，不按 UI 参数或底层 socket 类型猜测：

| attachment                            | 可信 `clientMode`       | profile      |
| ------------------------------------- | ----------------------- | ------------ |
| 本地桌面窗口                          | `desktop-continuous`    | `continuous` |
| SSH / WSL / Docker 桌面窗口           | `desktop-continuous`    | `continuous` |
| 手机 `/remote` shared-host attachment | `web-remote-replayable` | `replayable` |
| Web remote / relay WebSocket          | `web-remote-replayable` | `replayable` |

`zcode-server /ws` 对所有普通连接固定使用 replayable；即使调用方携带旧的
`x-zcode-rpc-client-mode` header，也不能把连接升格为 continuous。桌面
server-remote 的 Node host 必须先向受现有 server auth middleware 保护的
`POST /api/rpc-host-capability` 申请短期、一次性随机 capability，再把它放入
Node-only header 连接专用 `/ws/host`。服务端消费 capability 后才建立 continuous
trusted relay attachment，并仍为该 attachment 分配新的 `connectionId`。open/no-token
server 也走相同的显式申请与一次消费流程；单独伪造角色 header 或重放 capability 都不能获得
trusted role。

```text
Desktop Node host
  │ POST /api/rpc-host-capability（沿用 server auth）
  v
短期 capability ── 首次消费 ──> GET /ws/host ──> continuous trusted relay
       │                              │
       └─ 过期 / 重放：拒绝          └─ server 生成 connectionId

Browser / 任意普通 client
  └─ GET /ws（旧 mode header 被忽略）──────────> replayable terminal
```

`hello/clientHello` 只完成 wire v3 协商、连接身份确认和遥测身份注册。客户端可上报稳定 `clientId`、版本与展示用途的 `clientKind`，但不能覆盖 host 注入的 `connectionId/clientMode/profile`。UI-facing `subscribe` 不再接受 `deliveryProfile` 或 `clientMode`。

远程 workspace 的连接、订阅、命令与缓存继续贯穿 `workspaceIdentity` 和 `remoteSessionId`。身份 key 一律为 `workspaceIdentity?.trim() || workspacePath`；文件读写与进程 cwd 才使用 `workspacePath`。

## 3. 连接级订阅注册表

host 为每个 attachment 建立独立 registry，最小索引为：

```text
connectionId -> subscriptionId -> { topic, profile, visibility, state }
subscriptionId -> owning attachment port
```

规范性规则：

1. 同一连接对同一 topic 重订阅只替换该连接自己的旧 subscription；不同连接永不互相替换。
2. CLI 下行帧只能写入拥有该 `subscriptionId` 的端口。禁止先做 workspace 广播，再让手机按 subId 丢弃桌面帧。
3. attachment port 关闭、握手失败或连接被回收时，facade 必须一次性 unsubscribe 该 registry 的全部 subscription，并释放 fragment assembly 与 buffer。
4. attachment 重建或 CLI runtime epoch 变化时，客户端自动以当前合法 base 重订阅；epoch 不匹配时走 snapshot。
5. `onSaturated/onDrained` 属于连接级流控信号。手机链路可经 relay/main 透传到 owning attachment，但 relay/main 不解释 topic、seq、queue 或 snapshot。
6. subscribe 发出前先建立 pending ownership；server 把 initial frame 放入 request-scoped
   post-response outbox，connection 固定按 `response -> initial notification` 写 NDJSON。即便两行
   位于同一 read，host/UI/task-index 的 ACK 前早帧也只能进入有界 staging；ACK 绑定
   `subscriptionId` 后按原序释放给唯一 owner，close / stale generation 清空引用。task-index
   overflow 会清空该代 staging 并标记 recovery-needed；host/UI 的 physical staging overflow
   fault 语义留在 04B。UI transport 还必须等 store 写入 `subscriptionId` 并显式 activate 后再投递。
7. unsubscribe 必须由 owned registry 条目生成完整
   `{ topic, subscriptionId, connectionId }` route；CLI publisher 只删除三者完全匹配的订阅，不能按裸
   `subscriptionId` 向多个 topic 广撒网。

## 4. 权威状态的归属

| 状态                                    | 唯一权威位置                                         | 其他层职责                               |
| --------------------------------------- | ---------------------------------------------------- | ---------------------------------------- |
| session event log / projection          | CLI                                                  | host 仅路由与有界缓冲；UI apply          |
| 已提交 busy/running 输入                | CLI `CommandInbox` / runtime queue                   | UI 仅保留 optimistic overlay             |
| 未提交草稿、滚动位置                    | 当前客户端                                           | 不进入协议事实                           |
| command 幂等结果                        | CLI LRU + transcript/marker/child + discarded ledger | UI 24h pending registry 用于对账         |
| subscription buffer / fragment assembly | 每 connection/subscriber 易失状态                    | 关闭即丢，靠 resync 恢复                 |
| owner / lease / stale-run               | host 路由层                                          | 保证单 owner、阻塞响应和跨 host 命令正确 |

手机 V4 不再经过 host runtime command queue。所有已提交输入，无论来自桌面还是手机，都按 CLI 串行 admission 顺序进入同一个 `CommandInbox` FIFO。owner/lease 不能因 shared-host 主路径存在而删除：remote workspace、bot/proxy、跨 host fallback 和阻塞请求仍依赖它，但它不再拥有第二份 conversation queue。

## 5. Fork 的进程边界

running 时 fork 更早的稳定 assistant，只在 CLI 内复制稳定 transcript、fork 点配置和 fork 点之前的 goal 状态：

```text
parent runtime (继续 running) ── stable boundary ──> child transcript
shared workspace             ── 不 rewind / 不复制 checkpoint ──> 原样共享
parent queue/active/background/continuation ──X──> child
```

completed/idle fork 已有的 workspace checkpoint 行为本轮不扩大。running fork 不进入带 `ensureNoActiveTurn` 的 legacy bridge。

## 6. 三个实施门禁

本次闭环按依赖顺序交付，后一门禁不能以旁路前一门禁的方式上线：

1. **连接、订阅、帧与恢复**：可信 attachment 上下文、owned routing、1 MiB 物理帧、subscriber buffer 与自动 resync。
2. **权威输入、队列与幂等**：统一 CLI FIFO、`ConversationInputIntent`、`commands/query`、`sourceCommandId` 和 discarded 对账。
3. **稳定 assistant fork**：唯一 target resolver、running conversation-only fork 与 duplicate child 收口。

最终不变量：每条已提交输入必须且只能处于 `queue / guided row / transcript / explicit rejected|failed|discarded` 之一；不能出现“UI 已清空，但 CLI 权威层无记录”。
