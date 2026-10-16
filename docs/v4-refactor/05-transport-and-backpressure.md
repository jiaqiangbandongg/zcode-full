# 传输与背压：subscriber 隔离、1 MiB 物理帧与原子 resync

> 当前事实（V4 wire v3）：profile filter、coalesce、有界 subscriber buffer、物理分片和恢复是同一条发送管线。任何限额都按 UTF-8 序列化后的真实 wire bytes 计算，不能按 JavaScript 字符数估算。

## 1. 分层边界

```text
CLI 权威 event log / projection
          │
          v
per subscription publisher
  profile filter -> coalesce -> 计算 op/UTF-8 bytes
          │
          ├─ ≤500 ops 且 ≤max(1 MiB, snapshot 上界) ──> logical TopicFrame
          └─ 超限 ──────────────────────────────> 清空 buffer + needsResync
                                                    下一次只生成最新 snapshot
          │
          v
wire v3 encoder
  logical ≤ physical budget ──> complete envelope
  oversized snapshot/resume ──> fragment envelopes（每个 ≤1 MiB）
          │
          v
connection transport
  onSaturated / onDrained、ACK、心跳、短断重放
          │
          v
owning attachment port only
```

触发信号在 connection/transport 级，conversation 的降级裁决在 subscription publisher 级：

- transport 只报告 `onSaturated/onDrained`，不解析 topic、seq 或 snapshot；
- publisher 知道哪些 delta 可合并、何时必须 snapshot；
- relay/main 只透传流控信号和 payload，不持有 conversation buffer 或恢复状态；
- 一个 subscription 的 buffer、resync 或 assembly 永远不能阻塞另一个 subscription。

publisher 不在“生成 logical frame”时推进水位。它必须保留一个稳定
reservation，只在全部 physical envelopes 被 transport 接受后 commit：

```text
committed sentSeq=N
  -> reserve R(frame=(N,M], logicalFrameId=L)
  -> encode R -> wire[0..k]
  -> emit every wire
       sync enqueue failure: keep R, sentSeq remains N
       all admitted to this connection queue: commit R, sentSeq becomes M
```

同一 reservation 在 commit 前重试必须保持 `logicalFrameId` 和 logical JSON 不变。
新事件进入 post-reservation buffer；旧 reservation 不得引用可变 buffer。退订或
重订通过 generation token 使迟到 commit 失效。`Writable.write() === false` 只表示
背压，不表示拒收；enqueue 后才出现的异步 EPIPE 会直接终结 connection epoch，旧
subscription 不会在新 attachment 继续发送，新连接从 subscribe/resync 恢复。

### 1.1 每订阅编码与 workflowRuns 的增长上界

保留日志里存 native op。每个 subscription 记住自己握手时是否声明了 `workflowRunDeltas`
（[10-protocol-spec.md](./10-protocol-spec.md) §2），编码在扇出时按订阅决定，与 profile 正交：

- 声明方直接收 `workflowRun.updated / workflowRun.removed`（同文档 §4.5）。
- 未声明方在每批里被抹平：该批全部 `workflowRun.*` op 丢弃，并在其中最后一个的位置放入一条整键
  `state.updated{workflowRuns}`，值取当前权威投影并按旧界钳位——每个 run 只保留前 256 个 node 和前
  256 个 actor，裁到任何东西就置 `truncated: true`。「前 N 个」正是旧 reducer 拒新语义的产物，旧读端
  的 `.max(256)` 因此恰好通过。发给未声明方的 snapshot 帧套用同一个钳位。
- 从保留日志重放时，被取用的「当前」状态比历史 op 新：可接受——终态一致，只是跳过中间态，与 coalesce
  一贯的做法相同。

两端的差别在编码而不在 profile：同一编码下 continuous 与 replayable 的终态仍逐字段一致（§2）。

publisher ingest 一条 workflow 进度事件时不必整份 `JSON.stringify` 权威 snapshot 才能判断 16 MiB 上限：
`snapshot 字节上界 + 本次 op 的 UTF-8 字节 + 常数 <= 上限` 时按上界放行并就地累加（一次 upsert/patch 最多
让 snapshot 涨自身那么多字节，上界因此成立），否则回落到精确计量的慢路径，由它重新校准上界。这是既有
流式追加快路径的同一条口径，不是第二套记账。

## 2. Delivery profile 由可信连接注入

UI 和 subscribe 参数不包含 profile。connection-scoped facade 根据 host 注入的可信 `clientMode` 选择唯一 profile：

```ts
const DELIVERY_PROFILES = {
  continuous: {
    // desktop，包括 SSH/WSL/Docker 窗口
    flushWindowMs: 30,
    streamPaths: { text: true, inputText: true, "output.text": true, summaryText: true },
    streamOutputCapBytes: 262_144,
    toolProgress: false,
  },
  replayable: {
    // mobile remote / WebSocket
    flushWindowMs: 150,
    streamPaths: { text: true, inputText: false, "output.text": false, summaryText: false },
    streamOutputCapBytes: 0,
    toolProgress: true,
  },
} satisfies Record<string, DeliveryProfile>;
```

profile 只影响中间帧，不影响 schema、command/ACK、guard、恢复算法或终态。相同权威事件序列跑 continuous/replayable，允许中间帧不同，但最终客户端状态必须逐字段一致。被 profile 过滤的流式事件必须被不可过滤的完成态 `row.upserted` 或 snapshot 收口。

## 3. Subscriber buffer 的硬边界

每个 subscription 独立维护易失 buffer；计数时机固定为 **profile filter 之后、coalesce 之后**：

```ts
const MAX_BUFFER_OPS = 500;
const MAX_BUFFER_BYTES = 1_048_576; // 1 MiB
```

正常 drain 的充要条件是两个边界同时满足：

```text
coalescedOps <= 500
AND serializedLogicalPayloadUtf8Bytes <= min(max(1 MiB, wireSnapshotBytesUpperBound), 16 MiB - 64 KiB)
```

`500/501 op` 与字节上限的 `前一字节/正好/后一字节` 均按上式机械裁决。多字节 UTF-8 字符必须用编码后的 byte length；禁止用 `string.length`。

字节上限取 `min(max(1 MiB, wireSnapshotBytesUpperBound), 16 MiB - 64 KiB)`（2026-09-30 修订）：

- `wireSnapshotBytesUpperBound` 是 publisher 为 16 MiB assembly 闸门维护的当前 wire snapshot
  （尾部 60 行）logical frame 保守上界。外层再钳到 `16 MiB - 64 KiB`（即
  `PROJECTION_TERMINAL_RESERVE_BYTES` 预留），保证 buffer 加上帧外壳后打出的 deltas logical frame
  仍 `<= 16 MiB` assembly 上限；超过物理帧时照常走 fragment。
- 修订原因：overflow 的全部意义是“用一份更小的 snapshot 换掉积压的 delta”。单条大 delta（例如 3 MiB
  bash 输出的 tool row upsert）本身就超过 1 MiB 时，替换它的 snapshot 只会更大（同一行还在尾部窗口里），
  却会让客户端整份替换、丢掉已分页加载的历史行，turn navigator 随即重新全量分页；长 session 中每轮都
  这样循环（实测 host CPU 100%，每轮 15 s+）。snapshot 不比 buffer 小时降级没有收益，只有代价。
- 只有 buffer 真正大于 snapshot 上界（例如积压的更新落在尾部窗口之外的大量行上）时才降级。op 上限
  不变。

任一边界超限时执行一个原子状态迁移：

```text
draining
   │ buffer > limit
   v
needsResync
   ├─ 立即清空该 subscription 的 delta buffer
   ├─ 丢弃此前待发 logical delta frame
   ├─ 禁止继续发 delta
   └─ onDrained/可发送时只取最新权威 snapshot
          │ snapshot 成功写入 transport
          v
draining（新水位之后续流）
```

这里的“丢弃”发生在进入 RPC transport 之前，并由 snapshot 恢复；transport 已接受的 physical frame 不做语义丢弃。若连接持续 saturated，publisher 只保留 `needsResync` 标志，不为它积压多个 snapshot。

## 4. TopicWireFrame：logical 与 physical 分离

`TopicFrame<S,D>` 仍表达一个可原子 apply 的 logical frame。wire v3 使用 `TopicWireFrame` 物理信封：

```ts
type TopicWireFrame<S, D> =
  | {
      wireVersion: 3;
      kind: "complete";
      logicalFrameId: string;
      logicalFrameOrdinal: number;
      topic: string;
      subscriptionId: string;
      frame: TopicFrame<S, D>;
    }
  | {
      wireVersion: 3;
      kind: "fragment";
      logicalFrameId: string;
      logicalFrameOrdinal: number;
      topic: string;
      subscriptionId: string;
      fragmentIndex: number; // 0-based
      fragmentCount: number;
      logicalBytes: number; // canonical logical JSON 的 UTF-8 byte 数
      checksum: { algorithm: "crc32"; value: string }; // 传输完整性，不用于安全认证
      dataBase64: string; // canonical logical bytes 的当前分片
    };
```

规范性限额：

- 每个物理 JSON/RPC frame **连同完整 envelope** 的 UTF-8 序列化大小必须 `<= 1_048_576` bytes。计量值取三条实际承载的最大值：CLI NDJSON notification（含换行）、Channel/Socket event binary、mobile relay `data.payload.rpc-frame` 外层 JSON（Channel bytes 再 base64）。
- mobile relay 是目前最严格的外层。encoder 必须用真实 envelope meter/二分搜索决定分片；`bridgeSessionId/recoveryId` 等 transport id 最长 256 字符，计量使用该上限和最坏数字宽度。
- encoder 必须先计算 envelope 开销，再决定 `dataBase64` 分片长度；不能先切 1 MiB payload 再套信封。
- 正常 delta logical frame 由 subscriber buffer 的字节上限约束：通常 `<=1 MiB` 发 `complete`；单条大 delta 使 buffer 超过 1 MiB（但不超过 snapshot 上界）时与超大 snapshot 一样走 `fragment`。
- 超大 snapshot 或 resume logical frame 使用 `fragment`；fragment 只改变物理承载，不改变 `(fromSeq,toSeq]` 或 apply 语义。
- 单个 logical frame 最多包含 `1_024` 个 fragment；schema、encoder 与 reassembler 都必须 fail closed，避免伪造 `fragmentCount` 触发无界 missing-index/assembly 分配。
- publisher 为每个 subscription 分配从 1 开始严格递增的 `logicalFrameOrdinal`；同一 reservation 重试 ordinal/id 均不变。低于已接纳 ordinal 的迟到 wire 静默丢弃；同 ordinal 换 `logicalFrameId` 是 typed protocol fault。
- 同一 logical frame 的 fragment 必须具有相同 `logicalFrameId/logicalFrameOrdinal/topic/subscriptionId/fragmentCount/logicalBytes/checksum`。
- encoder 可以在 logical UTF-8 byte stream 的 code point 中间切片；每片独立做合法 base64，客户端必须先拼回原始 bytes 再一次性 UTF-8 decode，禁止逐片解码文本。

## 5. Assembly 的原子性与 16 MiB 上限

客户端按 `(topic, subscriptionId)` 保持唯一 active assembly，并以
`(logicalFrameOrdinal, logicalFrameId)` 识别 logical frame，最大允许：

```ts
const MAX_LOGICAL_ASSEMBLY_BYTES = 16 * 1_048_576;
const MAX_LOGICAL_ASSEMBLY_FRAGMENTS = 1_024;
const MAX_CONCURRENT_ASSEMBLIES = 32;
const MAX_STAGED_DECODED_BYTES = 32 * 1_048_576;
const ASSEMBLY_TIMEOUT_MS = 30_000;
```

```text
fragment 0 ─┐
fragment 2 ─┼─> staging assembly（store 不变）
fragment 1 ─┘        │
                     ├─ 全片 + bytes + checksum 正确 ─> parse/schema validate ─> 原子 apply
                     └─ 缺片/冲突/超限/校验失败 ─────> 丢整个 assembly ─> resync
```

以下行为一律禁止：先 apply 部分 snapshot、把 fragment 当独立 seq 帧、assembly 超限后截断、checksum 失败仍尝试 merge。

incremental assembler 每个 fragment 只 base64 decode 一次，用固定分片槽累计，
最终只拼接一次，因此总复杂度为 O(n)。超时从首片计时，重复片不延长；
完成、fault、超时与 consumer fail-closed abort 都必须保留该 route 的 ordinal
tombstone，直到 unsubscribe/代际清理，禁止迟到旧片复活。更高 ordinal 可淘汰旧 active
assembly；之后迟到的低 ordinal 不能反向 supersede。
相同重复片 no-op，冲突重复片释放该 assembly 并产生 typed fault。同
`topic/subscriptionId` 到达新 `logicalFrameId` 时，旧 assembly 以
`proto.frameAssemblySuperseded` 显式收口；并发数、总 staging budget 或单 logical
上限超限都 fail closed，禁止默默驱逐健康 assembly。

新输入/附件 admission 会使可传输权威 projection 超过 16 MiB 时，CLI 必须在接纳前明确返回 `rejected` 或 `failed`（`proto.payloadTooLarge` 或对应 fault）。运行中产生的大 tool/model output 不能靠截断整个 snapshot 兜底：tool output 转 artifact ref 并保留协议规定的 head/tail，模型文本若仍突破上限则以明确 protocol fault 终止该 turn。任何路径都不能生成不可传输的半截权威状态。

## 6. Gap 与自动 resync

`v4/conversation/resync` 是生产路径，不是测试辅助方法：

```ts
interface ConversationResyncParams {
  subscriptionId: string;
  base: { logEpoch: string; seq: number } | null;
  forceSnapshot?: boolean;
}
```

触发条件包括 seq gap、fragment assembly 失败、publisher overflow 与 transport 重建。客户端规则：

1. `toSeq <= localSeq` 静默丢弃。
2. 首个 gap 只发起一次 resync；在途期间不重复请求。
3. resume 后再次 gap，升级 `forceSnapshot=true`。
4. attachment 重建或 CLI epoch 变化后自动重新 subscribe；新 subscriptionId 生效前不接收旧流。
5. snapshot 完整 assembly 后整体替换；任何 fragment 到齐前 store 不变。
6. `proto.frameAssemblyInvalidPayload`（schema 拒收）是**确定性内容失败**，不套用规则 2/3 的瞬态
   阶梯：直接发一次 `forceSnapshot=true`，仍被内容拒绝即停手并写
   `fault.subscription.contentRejected`。完整语义见 04-sync-and-recovery 封闭规则 11。

## 7. Mobile raw RPC 物理信封

topic wire 的 1 MiB 承诺不能替代 mobile raw Channel transport 自己的物理边界。
04D-3 已把 desktop main 与 mobile web 原子切到 shared acknowledged adapter：一个 Channel
message 在进入外部 relay 前必须先编码为以下 transport-only payload；全局 app parser 只接受
新 strict fragment/ACK，legacy 单片 `rpc-frame` 不再是 production 兼容分支。relay 继续只把它
当作不透明的 `data.payload`：

```ts
type WebRemoteControlRpcTransportPayload =
  | {
      zcode_type: "rpc-frame";
      bridgeSessionId: string;
      bridgeGeneration?: number;
      recoveryId?: string;
      seq: number; // physical fragment seq
      messageSeq: number; // raw Channel message seq
      fragmentIndex: number; // 0-based
      fragmentCount: number;
      messageBytes: number;
      checksum: { algorithm: "crc32"; value: string };
      dataBase64: string;
    }
  | {
      zcode_type: "rpc-frame-ack";
      bridgeSessionId: string;
      bridgeGeneration?: number;
      recoveryId?: string;
      ackMessageSeq: number;
    };
```

规范性边界：

- schema 必须 strict；多余字段、非安全整数、非法 transport id/base64/checksum 一律拒绝；
- `bridgeSessionId/recoveryId` 最长 256 个 JSON-safe ASCII 字符；
- encoder 对最终、未压缩的
  `{type:"data",payload,client_ts,server_ts}` JSON 做真实 UTF-8 计量，并用二分搜索决定
  decoded chunk 大小；transport id 和数字都按协议最大宽度计量；
- 每个 final relay JSON `<=1_048_576` bytes；raw logical Channel message
  `<=16 MiB` 且 `<=64` fragments；
- 接收侧每个方向只允许一个 active raw message assembly，首片起 30s 超时；identity
  不匹配的 payload 在占用/推进 assembly 前拒绝；
- active/last-settled 的相同 fragment duplicate 是 no-op，冲突 duplicate、physical gap、
  metadata/length/base64/CRC 不符或超限均产生 typed transport fault；更早的 physical seq 只按累计
  delivery 水位 no-op，永不二次交付。只有全片校验成功后才原子交付一次 logical bytes。
- `seq/messageSeq` 到达 `Number.MAX_SAFE_INTEGER` 后只允许当前单片/消息收口；任何新片或新消息都以
  typed exhaustion fault 要求新 bridge generation，禁止在不安全整数上回绕或继续累加。

raw `rpc-frame-ack` 只确认完整 Channel message 已交给对端 parser/enqueue。它不是 V4
command ACK，也不能证明输入已 admission、清理 pending-command registry 或替代 topic resync。
首条 message 尚未完整交付时，active duplicate 只返回 no-op 且不产生 wire ACK；已有完成消息时才
重发最新的 positive cumulative `ackMessageSeq`。

### 7.1 Production acknowledged adapter

同一个 adapter 同时承载一个方向的 TX replay 与另一个方向的 RX assembly，但仍只保存 transport
事实。desktop main 与 mobile web 都直接把 owning bridge 的 MessagePort/Channel 接到该 adapter：

```text
Channel send(raw)
  -> encode immutable physical batch
  -> reserve exact final outer bytes before first send
  -> local transport accepts frames
  -> wait cumulative rpc-frame-ack

rpc-frame fragments
  -> one-message assembler
  -> complete + synchronous Channel delivery succeeds
  -> queue latest cumulative ACK (ACK always flushes before data)
```

- TX 先对整批最终 relay JSON bytes 做 admission，再保留 immutable batch；`send=false` 不改变
  `seq/messageSeq`，same-bridge resume 从未 ACK batch 的首片重放，且不刷新最老 reservation 时间。
- transport 为每个 payload 只创建一次 immutable final relay JSON；`measureFrameBytes` 与
  `sendFrame` 引用同一个 serializer/cache，未 ACK 重放复用同一字节串，禁止“计量一个 JSON、
  实际发送另一个 JSON”或因时间戳漂移改变账本。
- `unacknowledgedBytes` 是所有未累计 ACK batch 的最终未压缩 outer JSON bytes；默认 high/low 为
  `1 MiB / 256 KiB`，只在 `> high` 和 `<= low` 的状态边沿各通知一次。
- replay 同时受 `8 MiB` 与首条未 ACK 后 `45s` 限制；越界在发送半条 logical message 前进入 typed
  degraded。reserve/flush/replay 入口及每个 physical payload 发送前都必须同步检查 age，不能只依赖
  timer callback。RX 首片后的 `30s` assembly deadline 独立存在，duplicate 不续期。
- `8MiB / 45s / 30s` 是 hard upper bounds；测试或调用方 options 只能收紧，不能放宽。
- ACK `K` 一次释放所有 `messageSeq <= K`；旧 ACK no-op，超过“整批 physical frames 已被本地
  transport 接纳”的最大 messageSeq 是 typed fault。ACK payload 本身不进入 replay accounting。
- complete bytes 只有在同步 `onMessage` delivery 正常返回后才可排队 ACK；delivery 抛错、fragment
  fault、future ACK、byte/age overflow 都只触发一次 terminal degraded。
- queued ACK 只保留最大 positive cumulative value并优先于 data flush；首个 pending ACK 同样受 45s
  age deadline 约束，后续更高累计值不得续期。send callback 可同步回入 ACK，adapter 必须串行处理
  该可重入路径，不能误判 future ACK 或删除正在发送的 batch。
- new bridge identity、terminal degraded 和 dispose 清掉旧 timer、assembly 引用、pending ACK 与 unacked
  batch；不得跨 bridge generation 自动 replay。

## 8. Connection 流控

transport 暴露只读拥塞接口：

```ts
interface ConnectionFlowControl {
  readonly unacknowledgedBytes: number;
  onSaturated(listener: () => void): Disposable;
  onDrained(listener: () => void): Disposable;
}
```

- `onSaturated`：暂停该 connection 的 publisher drain，继续在各 subscription 自己的限额内 coalesce；超限的 subscription 转 `needsResync`。
- `onDrained`：公平恢复 drain；`needsResync` subscription 优先发一个最新 snapshot，其他 subscription 不被重置。
- 手机 relay 把信号穿透到 shared-host attachment；relay/main 不保存未 ACK conversation 事件。
- 本地 MessagePort 可退化为永不 saturated 的直通实现，但仍使用相同接口和 owned routing。
- port close 必须清理 connection registry、buffer、assembly 和 listener。
- `PersistentProtocol` 仅声明结构满足公共 `ConnectionFlowControl`，production mobile 不改接它。
- production mobile flow edge 使用严格 sideband 贯穿到 CLI，不进入 Channel deserialize：

```text
raw adapter SAT/DRN
  -> desktop main owning MessagePortProtocol.sendFlowState
  -> host attachment MessagePort sideband（只消费 control object）
  -> ZCodeAgentConnectionScope per-scope serial chain
  -> trusted v4/connection/flow {connectionId,state}
  -> CLI pausedConnections
  -> 只 pause/resume 该 connection 的 conversation/index/config subscriptions
```

- sideband 只有 `saturated|drained`；host 在 port close 时补一次 `closed`。terminal RPC caller 不能直接
  调 transport-control method；remote trusted-host-relay 继续对下游 connectionId 做无歧义 namespace。
- `saturated` 清该 connection 的 pending flush timer，ingest/coalesce 继续；`drained` 只立即 drain
  该 connection，`needsResync` subscription 由 publisher 自然优先产最新 snapshot；`closed` 只清 pause
  state，owned facade dispose 继续负责 unsubscribe/registry 清理。
- 同一 scope 的快速 SAT→DRN→close 以 promise chain 串行，重复 state 不发 RPC；已 saturated 时新
  subscription ACK 后立即把当前 state 同步到其 trusted connection/workspace route。
- desktop main 的 50 项 pending buffer 只保留 bootstrap/workspace/platform 等小型 app payload；
  `rpc-frame`/ACK 由 adapter 独占 replay ownership，永不进入第二层 buffer。
- 两端在 `JSON.parse` 前按 raw UTF-8 bytes 做 `<=1 MiB` 硬闸。永久 oversize 与临时
  socket unavailable 是不同结果；oversize 立即 typed fault/hard bridge recovery，不能反复 buffer。
- desktop 通知 mobile 重建 bridge 时只发送通用 `bridge-degraded: rpc-transport-fault`；checksum、gap、
  future ACK、oversize 等具体 typed reasonCode 只写安全本地日志，不能统一伪装成 frame gap。

### 8.1 附件上传不是 logical frame 分片

附件 bytes 走独立业务事务，不能把 20 MiB `dataBase64` 塞进一次 Channel/NDJSON request 后再指望
mobile raw adapter 二次分片：那只能约束 relay outer，不能约束 host→CLI NDJSON。

```text
UI high-level put(bytes)
  -> attachment/begin
  -> attachment/chunk x N       decoded <= 512 KiB / physical request <= 1 MiB
  -> attachment/commit
  -> artifact ref
```

- UI transport 的默认片长为 384 KiB（可被 3 整除，除末片外 base64 无 padding），给 workspace、
  Channel method/header 和 trusted carrier 留足 envelope 空间；协议硬上限仍是 512 KiB decoded。
- renderer→host Channel request 与 host→CLI NDJSON request 都按实际参数计量；任一超过 1 MiB 立即
  `proto.frameTooLarge`，不能把 oversized request 交给下层 relay 再拆。
- CLI staging 只持 decoded bytes，受 `20 MiB/upload`、active upload 数量和全局 staged bytes 三个硬限额；
  duplicate chunk 只保留 digest/既有 bytes，不重复计账。
- trusted `connectionId` 参与 upload key。`closed` 清该 connection，`disposeSession` 清该 session，
  TTL 清过期 transaction，CLI restart 由进程内存自然清空；这些清理都不生成 artifact。
- commit 校验完整 chunk count、totalBytes 与 SHA-256 后一次性写 session artifact；artifact 内容保持
  既有 provider 可读的 data-URL 形态，但该 base64 只在 CLI 内存/存储边界产生，不再经过 RPC。成功
  结果保留为 idempotency tombstone，commit ACK 丢失重试返回同 ref，不重复落盘。
- abort 幂等；上传失败由 composer 调用栈向上抛出，已提交 command 尚未发生，因此文本和附件必须保留。

RPC 的 ACK、心跳与短断重放只负责探测和换管道：同一条卡死 TCP/ws 上不原地重发；新 socket 上用同 msgId 重放未 ACK physical frame，对端去重。长断或宽限窗越界仍回到 subscribe/resync。

## 9. 验收边界

协议黄金测试至少机械覆盖：

- continuous/replayable 中间帧不同而终态逐字段一致；
- `workflowRunDeltas` 声明方的终态等于权威投影，未声明方的终态等于旧整键编码（钳位后），同一订阅的
  snapshot 与续流用同一份钳位；
- buffer `500/501 op`；
- physical JSON/RPC `1 MiB-1 / 1 MiB / 1 MiB+1`；
- mobile raw RPC 的 1/2/多片原子还原、duplicate tombstone、identity mismatch、
  `16 MiB/+1`、`64/65` 片与 30s timeout；
- 多字节 UTF-8 恰跨边界；
- fragment 乱序到达、重复同片、缺片、字段冲突、checksum 失败；
- assembly `16 MiB` 正好与超一字节；
- overflow 后只发最新 snapshot；
- 单条大 delta 超过 1 MiB 但不超过 snapshot 上界时继续发 deltas（不整份替换），客户端终态与全量重放一致；buffer 超过 snapshot 上界时仍降级；
- 两个 connection 同订阅同 session 时，慢手机 resync 不影响桌面，且手机链路从不出现桌面 `subscriptionId`。
- attachment 20 MiB exactly、20 MiB+1 pre-admission reject、逐片 Channel/NDJSON envelope `<=1 MiB`，
  以及 empty/missing/future/duplicate-conflict/checksum/ACK-loss/abort/TTL/close/restart 清理。

这些边界是协议正确性门禁，不是性能调优项。
