# V4 重构评审稿：Conversation 状态同步与多端协议收敛

- 会议目标：评审 v4 重构方向是否能系统性解决 conversation 状态不同步、弱网恢复和远控/本地协议分叉问题。
- 讨论范围：conversation 产品投影、command 模型、订阅恢复、传输背压、desktop continuous 与 web remote replayable 的统一协议边界。
- 不讨论范围：具体 UI 视觉改版、单个字段的最终 TypeScript 命名、relay 业务化改造。

## 背景

过去 conversation 的大量 bug 看起来分散：消息重复、timeline 错位、刷新后半截消息丢失、stop 状态不一致、手机远控重连后权限弹窗消失、queued prompt 丢失或重复发送。但它们背后是同一个结构性问题：**conversation 的产品事实没有唯一权威源**。

现在 renderer、service、host、desktop main、mobile replay mirror 都在不同层级维护一部分运行态。stream 和 snapshot 又分别写入 UI 内存，UI 需要事后合并、补偿和猜测。这个模型在本地短链路下还能靠补丁维持，但到了 web、手机远控、远程 workspace、秒级 RTT、刷新/断线频繁的网络环境里，会把时序差异放大成产品 bug。

v4 的目标不是给每类 bug 加新的兜底，而是把 conversation 改成：

```text
CLI / agent runtime 是唯一事实源
  -> 生成 Conversation Product Projection
  -> host 只做转发、缓冲、背压和恢复调度
  -> desktop / web / mobile 都只渲染投影并提交 command intent
```

核心变化一句话：**客户端从“状态 reducer”降级为“投影渲染器 + command 提议者”。**

## 之前的问题与对应改进

| 之前的问题 | 造成的现象 | v4 对应改进 | 评审验收点 |
| --- | --- | --- | --- |
| renderer 内存是 conversation 真相之一，stream 和 snapshot 双写同一份消息数组 | 刷新后漏消息、重复消息、timeline 错位、turn 分组需要补丁修补 | CLI 侧生成 `ConversationProductProjection`，rows、turn、actionAvailability、sessionControl 都是权威投影；客户端收到 snapshot 整体替换，收到 delta 只做连续 apply | UI 不再从 flat messages 自行推导 turn 和按钮状态；同一事件 replay 后 rows 稳定 |
| action guard 散落在 UI 和 operation 里 | `canStop`、`canFork`、queue 路由、多端按钮状态不一致 | 所有会改变 conversation 的动作统一为 command intent；CLI 按 projection revision 和规则模块裁决，返回 ACK | 任意客户端看到相同 actionAvailability；重复 stop/权限响应幂等收口 |
| 断线恢复有多条路径，且 base 水位和 UI 状态不同生共死 | 手机 replay gap 后把旧 snapshot 和新 stream 拼成不存在的状态 | 统一 `subscribe(topic, base?)`：base 有效就续传，base 失效就 snapshot；`logEpoch + seq + subscriptionId` 明确代际 | 旧订阅迟到帧静默丢弃；断档只触发 single-flight resubscribe |
| 高频 delta 直接穿过 relay 和 IPC，客户端侧才合批 | 弱网下帧数暴涨、RTT 放大、手机耗电和掉帧 | 合批前移到 host 通道层，topic 声明 coalesce/resync；帧级只负责 ACK、心跳、重连重放和拥塞信号 | 一轮输出从“每 delta 一帧”收敛为按窗口投递；溢出时走 snapshot 而不是随机丢帧 |
| desktop continuous 与 mobile replayable 是两条代码路径 | 本地和远控行为不一致，修一端容易破另一端 | 用同一套 topic / snapshot / delta / command 协议，差异只保留为 delivery profile 参数 | 客户端 apply 逻辑不分 profile；desktop 默认 continuous，mobile 默认 replayable，但终态一致 |
| remote controller 依赖额外 bridge/mirror 语义 | 手机端像一个“旁路客户端”，容易绕过本地 host/runtime 边界 | 远控保持 shared-host attachment：relay 和 desktop main 只透传 `rpc-frame`，手机 attach 到桌面已有 local/remote host | relay/main 不下沉 task、stream、queue、snapshot 业务状态 |
| queued prompt 和 optimistic UI 由本地内存维持 | 刷新丢队列，ACK 丢了 pending 不收口，重复提交靠启发式去重 | command 带 `commandId`，权威 row/queue item 带 `sourceCommandId`；overlay 只按 commandId 展示，永不进入真实数据 | 发起端也必须从订阅流读到自己的权威结果，overlay 由投影收口 |
| workspacePath 被用于身份隔离语义 | SSH/WSL/Docker 等远程 workspace 同路径时互相串状态 | 所有身份/隔离 key 使用 `workspaceIdentity?.trim() || workspacePath`，路径执行仍只用 `workspacePath` | 远程 workspace bridge、snapshot、queue、owner command 都带 workspace identity |
| 当前 bug 缺少可复现的协议级证据 | 修复依赖手工复现和 UI 猜测，回归容易漏 | 建黄金测试和网络混沌装置：snapshot 原子性、profile 终态一致、重复/迟到帧处理、guard 与 projection 同源 | 每类历史 bug 对应一个协议不变量或 reducer case |

## 状态所有权

v4 先把“谁拥有状态”讲清楚。状态不同步的根源不是缺少同步代码，而是多个层都觉得自己可以写 conversation 事实。

```text
CLI / agent runtime                              # conversation 的唯一事实源，负责把原始事件裁成产品可见状态
|-- canonical transcript                         # 权威对话记录，包含用户输入、assistant 输出、tool 结果等可持久恢复内容
|-- runtime facts                                # 当前运行态事实，例如 active work、pending permission、token usage、后台任务
|-- event log / logEpoch / seq                   # 增量恢复水位，用来判断客户端能否续接 delta，还是必须重新拉 snapshot
|-- command guard and idempotency                # command 的串行裁决、幂等去重和 guard 判断，避免多端各自决定能不能执行
`-- Conversation Product Projection              # 面向 UI 的权威产品投影，把 transcript/runtime facts 归一成可渲染视图
    |-- rows                                     # timeline 行列表，解决 turn 分组、消息归属、虚拟滚动 key 的权威来源
    |-- actionAvailability                       # 当前可用动作集合，例如 canStop/canFork/canRetry，避免 UI 自己扫状态猜按钮
    |-- inputRouting                             # 输入路由裁决，决定新输入是立即执行、进入 queue，还是被 guard 拒绝
    |-- sessionControl                           # session 顶层控制态，例如 phase、sessionEnded、stopState、lastError
    |-- queue / pendingInteractions / backgroundWorks # 队列、待用户响应项和后台工作列表，刷新/多端都从同一投影恢复

Host / service                                   # app 侧连接和服务层，负责传输、订阅、缓冲，不新增 conversation 产品语义
|-- topic subscription registry                  # 记录每个连接订阅了哪些 topic，以及对应 subscriptionId/visibility/profile
|-- per (connection, topic) flush buffer         # 每个连接每个 topic 的短暂发送缓冲，用于合批、限流和断开即丢的软状态
|-- coalesce / conflation / backpressure         # 按 topic 规则合并 delta、保留最新态，并根据传输拥塞调整发送节奏
`-- no new conversation product decision         # 明确禁止 host/service 再判断 turn 归属、按钮可用性或 session 产品状态

Renderer / Web / Mobile                         # 客户端只负责展示和提交意图，不能成为 conversation 事实源
|-- render projection                            # 渲染 CLI 下发的 rows/sessionControl/actionAvailability 等权威投影
|-- send command intent                          # 把用户动作提交成 command，让权威侧裁决，而不是本地直接改事实状态
|-- optimistic overlay by commandId              # 用 commandId 做本地即时反馈，等权威 row/queue item 回来后收口
`-- local-only UI state                          # 只保留不影响 conversation 事实的本地交互态
    |-- draft                                    # 输入框草稿，属于当前客户端本地体验，不参与多端事实同步
    |-- scroll anchor                            # 滚动锚点和可视范围，用 rowId 恢复阅读位置，不改变会话内容
    |-- hover / focus                            # 鼠标悬停、焦点、选中等瞬时交互状态，只影响当前界面
    |-- pane layout                              # 分屏、面板展开收起等布局偏好，属于客户端本地显示状态
```

这条边界的收益是：conversation 的产品语义只需要在 CLI reducer 和协议测试里证明一次。desktop、web、mobile 不再各自写一套“如何把 stream 拼成对话”的逻辑。

## 订阅、恢复与弱网

这一节要解决的问题：**客户端断过、刷新过、或者是新设备第一次打开时，怎么重新跟 CLI 的权威状态对齐。**

v4 不再为“刷新”“断线重连”“手机新扫码”分别写三套恢复逻辑。所有客户端都只做同一个动作：订阅当前 conversation topic。区别只在于客户端手里有没有一份可信的旧状态。

```text
客户端本地状态                         订阅请求                         CLI 裁决
------------                         --------                         --------
没有旧状态
  例如刷新、新设备打开         ->      subscribe(topic)            ->    发完整 snapshot

有旧状态，且记得水位 W
  例如短暂断网后回来           ->      subscribe(topic, base=W)     ->    如果 W 还有效，只补 W 之后的 deltas

有旧状态，但水位太旧或代际变了
  例如断了很久、CLI 重启       ->      subscribe(topic, base=W)     ->    放弃旧状态，重新发完整 snapshot
```

这里的几个词可以先按口语理解：

```text
topic     = 订阅哪条会话，例如 conversation/<sessionId>
snapshot  = CLI 在某个时刻算出来的完整当前画面
delta     = 从上次水位之后发生的增量变化
seq       = CLI 事件流的水位，表示“我已经看到第几号事件”
logEpoch  = CLI 进程/事件日志的代际，代际变了说明旧 seq 不能再续接
base      = 客户端告诉 CLI：“我手里有 logEpoch=X、seq=W 时刻的一致画面”
```

真正关键的是这条不变量：**只有当客户端真的持有 seq=W 时刻的一致画面时，才允许拿 `base=W` 去续接增量。**

所以恢复链路长这样：

```text
短断网:

客户端仍保留画面(seq=120)
  -> 网络恢复后带 base=120 订阅
  -> CLI 判断 120 还在保留窗
  -> 只下发 121..now 的 deltas
  -> 客户端接上，画面不中断

刷新 / 新设备 / 长断线:

客户端没有可信画面，或 base 已失效
  -> 不带 base，或者带了也被 CLI 判 stale
  -> CLI 下发 snapshot(seq=now)
  -> 客户端整体替换本地投影
  -> 从新 snapshot 的 seq 后继续接 deltas
```

客户端收到帧以后也不猜、不补洞，只按这五条处理：

```text
1. subscriptionId 不匹配      -> 这是旧订阅的迟到帧，直接丢
2. payload 是 snapshot        -> 整体替换当前投影，不和旧数组 merge
3. toSeq <= local seq         -> 重复帧或迟到帧，直接丢
4. fromSeq != local seq       -> 中间断了一段，重新订阅拿 snapshot
5. fromSeq == local seq       -> 水位连续，安全 apply deltas
```

弱网下分两层恢复：

```text
几百毫秒到几秒的抖动
  -> @zcode/rpc 用 ACK / 心跳 / 重连重放解决
  -> conversation topic 不感知，seq 不断

刷新、长断线、relay/手机页面重建、CLI 代际变化
  -> conversation topic 用 subscribe(base) 解决
  -> base 可用就补 delta，base 不可用就 snapshot
```

这能避免现在最容易出错的情况：手机端拿着一份旧画面，却继续拼接新 stream，最后 UI 显示出一段 CLI 从来没有承认过的 conversation 状态。

## 协议合并：Replay 与 Continue

v4 要合并的是协议模型，不是把所有端的运行语义抹平。

```text
同一套协议:
  topic = conversation/<sessionId>
  snapshot = 当前完整投影
  delta = row/state patch
  command = 用户意图
  ack = accepted / rejected / stale / duplicate / failed

不同 delivery profile:
  desktop continuous
    - 本地 MessagePort 默认
    - 低延迟，高流式粒度
    - 保持 direct continuous 实时链路

  web remote replayable
    - relay / 弱网默认
    - 更大 flush window
    - tool output 等机器产物少流式，多用终态收口
    - 断线后走 snapshot + replay 恢复
```

也就是说，desktop 和 mobile 走同一个 `subscribe/apply/command` 语义，但 delivery profile 是一张参数表：

```text
模型事件流
  -> CLI reducer 生成权威 projection delta
  -> host 通道层按订阅者 profile coalesce
  -> @zcode/rpc 负责帧级 ACK / 心跳 / 重连重放
  -> 客户端用同一个 apply 算法渲染
```

这样可以同时满足两个约束：

- 桌面端不被手机 replayable 语义污染，仍是 continuous 主链路。
- 手机端不绕过 replayable 恢复边界，大 gap 后必须由 snapshot 对齐。

## 远控与本地链路边界

远控 v4 不应把 relay 或 desktop main 变成业务状态层。当前有效事实仍然是 shared-host attachment：

```text
mobile /remote
  -> external relay: auth / pair / heartbeat / payload relay
  -> desktop main: workspace bridge and rpc-frame routing
  -> existing host process
  -> services / runtime / task persistence
  -> CLI / agent runtime
```

这意味着：

- relay 只透传 `rpc-frame`，不解析 task、session、stream、queue、snapshot。
- desktop main 只做 attachment 调度，不持有 conversation 业务状态。
- 手机不能为了远控另起独立 Agent runtime，也不能新建独立 SSH/WSL/Docker session。
- remote workspace 的桥接、snapshot、queue、owner command 必须贯穿传递 `workspaceIdentity` 和 `remoteSessionId`。

## Command 与 optimistic overlay

v4 的客户端不是写者，而是提议者：

```text
UI action
  -> command(commandId, clientId, sessionId, baseRevision, type, payload)
  -> CLI guard / dedupe / enqueue / execute
  <- ACK
  -> projection delta
  -> UI 用 sourceCommandId 收口 overlay
```

设计重点：

- `accepted` 只代表权威侧已受理，不代表 UI 本地可以写真实消息。
- overlay 只用于即时反馈，按 commandId 挂载，永不合并进 rows。
- 权威 userInput row、queue item、timeline marker 都必须带 `sourceCommandId`。
- 断线后未收口 command 用 `commands/query` 对账，不盲目重发。
- 多端并发由 CLI 串行裁决，不做 OT/CRDT。

这个模型可以统一“继续发送”和“恢复 replay”的边界：continue 是 command，replay 是订阅恢复。两者都围绕同一份 projection 收口，不再是一条本地队列加一条远控镜像流。

## 落地阶段

建议评审按四段确认：

| 阶段 | 目标 | 主要产物 |
| --- | --- | --- |
| Phase 0：协议定稿 | 固定状态所有权、topic 五件套、command ACK、delivery profile 和不变量 | 更新字段规范、case catalog、coverage matrix、golden test list |
| Phase 1：CLI projection | 把 rows、actionAvailability、sessionControl、queue 等产品事实移到 CLI reducer | reducer、schema、snapshot 原子性测试、sourceCommandId anchor |
| Phase 2：订阅恢复与传输 | 统一 subscribe/apply，生产化 ACK/重连/背压，远控仍保持 shared-host | topic runtime、coalesce、logEpoch、subscriptionId、chaos test |
| Phase 3：UI 收敛 | UI 删除本地 reducer 和推导逻辑，只渲染 projection + overlay | v4 chat store、虚拟滚动 rowId anchor、旧链路删除计划 |

## 评审重点问题

1. 是否认可“CLI projection 是 conversation 产品事实唯一权威源”？
2. 是否认可“协议合并 = 同一套 topic/command/apply，端差异只用 delivery profile 表达”？
3. 是否认可“不做 per-client 离线队列，长断/刷新统一 snapshot 恢复”？
4. 是否认可“relay 和 desktop main 不下沉 task/session/stream 业务状态”？
5. 是否认可 command inbox / queue 的生命周期口径：renderer 断线可恢复，host/CLI 进程退出不承诺继续执行，已落盘效果靠 `sourceCommandId` 幂等收口？
6. G-12 fault catalog 和 G-13 鉴权面是否作为 Phase 0 必补内容？

## 预期收益

- conversation bug 从“多端补丁”收敛为“协议不变量 + reducer 测试”。
- web 和手机弱网不再依赖 UI 猜测恢复，刷新和断线是常规订阅路径。
- remote controller 和本地链路共享同一套协议模型，同时保留 desktop continuous 与 mobile replayable 的差异边界。
- host/relay/main 的职责更轻，状态不再在转发层扩散。
- 后续新增端形态时，只需要实现 transport 和 capability，不需要重写 conversation reducer。

## 关联文档

- [V4 重构 README](./README.md)
- [ZCode Protocol v4 字段级规范](./10-protocol-spec.md)
- [订阅与恢复](./04-sync-and-recovery.md)
- [传输与背压](./05-transport-and-backpressure.md)
- [V4 重构设计 Review](./design-review.md)
- [Web 远程控制外部 Relay 架构](../web-remote-control/web-remote-control-architecture.md)
- [Task Realtime Sync](../web-remote-control/task-realtime-sync.md)
- [手机远控任务命令队列](../web-remote-control-task-command-queue.md)
