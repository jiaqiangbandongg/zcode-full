# Web 远程控制概览与外部 Relay 架构

本文描述当前有效实现。旧的仓库内 relay、窗口 control socket、bridge token、HTTP bootstrap API 已移除，不再作为兼容路径。

## 产品概览

手机 Web 远控让用户在浏览器中访问目标桌面窗口已经打开的工作区和任务。桌面应用承载
实际服务与 Agent runtime，手机通过外部 relay 接入同一 Host 的 workspace scope；手机页面
不启动独立 Host 或 Agent，relay 只负责鉴权、配对、心跳和消息透传。

### 使用流程与页面

1. 在桌面打开 Web 远控对话框，启动远控并取得二维码或连接链接；手机浏览器打开链接后完成配对。
2. 窄屏首次扫码默认进入任务首页：首页与桌面共用项目侧栏，可按项目或跨项目时间线浏览任务；
   Relay V2 连接时侧栏最顶部（“新建任务”之上）显示当前电脑行，整行点击即“切换设备”。二维码携带的初始任务用于选中和定位，不直接跳进聊天页。
3. 点击任务进入聊天；项目或全局的新建任务入口进入对应草稿页。跨工作区操作先切换 bridge，
   再访问目标工作区服务。返回首页保留任务选中态；聊天页刷新可以根据浏览器 history state 恢复聊天页。
4. 手机选中的工作区和任务独立于桌面选中态，不会使桌面切换 tab/task。
5. 网络恢复或页面回到前台时恢复连接，并按 replayable 协议重新同步任务状态；
   断开的远程工作区可从首页触发桌面已有重连流程，连接成功前不能打开或新建其中的任务。

窄屏使用独立的首页/聊天两页 shell，聊天内容复用现有 V4 会话组件。宽屏远控使用侧栏布局，
任务列表同样来自桌面同步的跨工作区索引。手机主题使用浏览器本地偏好，与桌面主题独立；
无本地偏好时默认使用 `zai-dark`。

### 能力与边界

- 可浏览目标窗口已有的工作区与任务、打开会话、发送输入、新建任务，并处理会话中的权限和交互请求。
- 远程工作区复用桌面已有连接与服务 scope；首页重连恢复已有工作区，不提供手机新建
  SSH/WSL/Docker 连接或管理其他桌面窗口工作区的入口。
- 同一 task 仍由既有 runtime owner 执行。桌面使用 `desktop-continuous`，手机使用
  `web-remote-replayable`；手机恢复不会改变桌面的 continuous 主链路。
- 手机服务和工具能力受 attachment/capability 约束，不因复用桌面 UI 而自动获得全部桌面能力。
  终端暴露边界见下文“启动调用边界与 Office XSS 关系”。

```text
手机浏览器（独立选中态、replayable）
  -> 外部 relay（透传）
  -> Desktop main（attachment 调度与 RPC 桥接）
  -> 目标窗口共享 Host 的 workspace scope -> 同一 task runtime owner
                          ^
桌面 renderer（continuous）─┘
```

### 专题导航

| 内容                               | 文档                                                                 |
| ---------------------------------- | -------------------------------------------------------------------- |
| 手机首页、聊天、新建任务与页面状态 | [手机任务首页](./mobile-task-home-design.md)                         |
| 手机任务时间线与排序               | [移动端任务时间线](../ui/web-remote-control-mobile-task-timeline.md) |
| 宽屏任务列表、搜索与归档           | [宽屏任务列表](./wide-screen-task-list.md)                           |
| 手机主题与浏览器表面               | [主题控制](./mobile-theme-control.md)                                |
| 远程工作区断开与重连               | [工作区重连](./mobile-remote-workspace-reconnect.md)                 |
| 实时同步、snapshot 与 gap 恢复     | [任务实时同步](./task-realtime-sync.md)                              |
| 输入 admission、队列与跨端命令路由 | [任务命令队列](../web-remote-control-task-command-queue.md)          |
| V4 静态资源发布                    | [V4 部署](./remote-v4-static-deployment.md)                          |
| 独立 OAuth 登录入口                | [Web Remote Login](./web-remote-login.md)                            |

下文描述当前技术实现；[最小跑通规划](./web-remote-control-minimal-plan.md)仅作为历史记录，
其中的仓库内 relay、专用 mobile host 和旧联调命令不适用于当前链路。

## 入口

Desktop 和 mobile web 使用当前 endpoint origin 的 Relay V2 入口；HTTPS 对应 WSS，HTTP 对应 WS：

```bash
production/default: wss://zcode.z.ai/api/v1/remote/ws2
test endpoint:       wss://zcode.z.ai/api/v1/remote/ws2
local/custom:        ws://localhost:3030/api/v1/remote/ws2
```

`ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL` 仍是桌面 relay 的最高优先级显式调试覆盖，必须指向 V2
入口。没有覆盖时，localhost/custom endpoint 同样从各自 origin 推导 relay。当前桌面版本生成
`/remote/v4` 二维码；`ZCODE_WEB_REMOTE_CONTROL_URL` 用于显式调试覆盖。

开发时可以把手机页指向本地 web：

```bash
ZCODE_WEB_REMOTE_CONTROL_URL=http://localhost:5173/remote/v4 \
pnpm dev:web-remote-control
```

## 静态部署

手机 V2 页面只通过 OSS 多版本流水线发布，无需入口变量。在主流水线手动运行 `upload:remote:test`、`upload:remote:prod`，或各自的 `:latest` job；环境、版本选源与生产限制见 [OSS 多版本部署](./remote-v4-static-deployment.md#gitlab-ci-测试与生产-oss-多版本产物)。

```text
选定 commit/tag → 按 app 版本构建 /remote/v4/<version>/ 资源
              → prepare 校验环境与清单 → OSS 版本目录
              → 网关按 app_version 选择 index、按目录选择静态资源
```

页面路由固定为 `/remote/v4`。旧 `/remote`、`/remote/v3`、`/remote/v4` Docker 单版本部署冻结在最后一次 V1 镜像；仓库已删除相应构建、推送、验证入口，不得覆盖旧部署。`/remote/__test__` 的独立测试链继续保留，使用方式见[静态部署文档](./remote-v4-static-deployment.md)。

OSS 的版本选择、环境隔离、latest 规则、网关路由及验收见[多版本部署](./remote-v4-static-deployment.md)。发布前必须完成 [Relay V2 外部依赖与真机验收](./relay-v2-pairing.md#外部依赖与发布顺序07)。

## Transport

桌面 device 使用 [Relay V2 配对与状态机](./relay-v2-pairing.md#桌面-device-生命周期03)：main 用当前账号 JWT 懒注册设备，每次建连前申请一次性 role=device token，再连接当前 endpoint 的 `/api/v1/remote/ws2?token&mid`。不发送 X-Device-ID；`auth_init` 只携带 SID、meta 和秒级 client_ts。

V2 心跳为每轮重新抽样的4~6秒 pair_status_query（不带 SID），独立15秒 ACK watchdog 判定失联。网络/5xx 指数退避，401 停止并报 auth-required，KICKED 在60秒内仅允许一次2~5秒延迟恢复。二维码为 `/remote/v4?app_version=<ver>&sid=<sid>&mid=<mid>&name=<hostname>`，不含 hash/t 或 JWT/token。手机 terminal 同样使用 V2 token/auth_init，共享层只导出 V2 relay 契约。

Relay 只负责认证、配对、心跳和 data.payload 透传，不解析 task、session、workspace 或 rpc-frame 内部业务。main 按 workspaceKey 把手机 bridge attachment 挂到已有 Window Host，桌面 continuous 与手机 replayable 的 owner 和恢复边界保持不变。

## App Payload

`data.payload` 使用 `zcode_type` 区分业务消息：

- `bootstrap-request` / `bootstrap-response`
- `workspace-list-request` / `workspace-list-response` / `workspace-list-updated`
- `workspace-bridge-open` / `workspace-bridge-ready` / `workspace-bridge-error`
- `platform-request` / `platform-response`
- `mobile-view-state-update`
- `rpc-frame` / `rpc-frame-ack`（transport-only；relay 不解析）
- `app-error`

04D-3 已让 desktop main/mobile web 同时使用 shared acknowledged adapter；全局 app parser 正式接受
新 strict fragment/ACK，并删除 legacy 单片 branch。raw Channel message 不能直接做一次 base64 后塞入
单个 `rpc-frame`，而要切成带 `messageSeq/fragmentIndex/fragmentCount/messageBytes/CRC32` 的物理片；每片连最终
`{type:"data",payload,client_ts,server_ts}` 未压缩 JSON 必须不超过 1 MiB。单 logical raw
message 上限 16 MiB / 64 片，接收侧只 staging 一个 message 并在完整校验后原子交付一次。
`rpc-frame-ack` 是 raw transport 的 cumulative ACK，不是 command ACK，也不携带 conversation
业务事实。

production adapter 的 transport 状态是对称且 bridge-scoped 的：TX 在首片发送前保留整批 immutable
fragment，并按最终 outer JSON bytes 维护 `1 MiB / 256 KiB` flow edge、`8 MiB / 45s` replay
边界；RX 在完整 assembly 和同步 Channel delivery 成功后才排队 cumulative ACK。ACK 优先 flush。
同一 bridge 每次重新 send-ready 时都重放未 ACK batch，包括本地 WebSocket 未换代、但心跳重新确认
`matched` 的 `same-socket` 场景；对端 peer 可能已经换代，不能把本地 socket identity 当成交付证明。
重放复用原 immutable batch 且不刷新其 queued age；new bridge、terminal fault 或 dispose 清空旧
transport 状态。首个 queued ACK 也受 45s deadline 约束，后续更高 cumulative ACK 只替换值而不刷新 age。
这些状态不包含 task/session/topic/command 事实。desktop/web transport 为 payload 创建唯一 immutable
final outer JSON，adapter 的 meter 与实际 send 共用同一 serializer/cache；同 bridge replay 复用相同
bytes。raw frame/ACK 不进入 desktop main 的普通 50 项 app payload buffer。两端在 `JSON.parse` 前按
未压缩 UTF-8 `<=1 MiB` 硬闸，compression 开关不影响 admission；永久 oversize 与临时 unavailable
分流，raw fault 只触发一次 hard bridge recovery。跨端只传通用
`bridge-degraded: rpc-transport-fault`，具体 typed reasonCode 留在 owning 端安全日志。

`mobile-view-state-update` 除了 `activeWorkspaceKey`、`activeTaskId`、`updatedAt`，还可以携带
`deviceInfo`。该字段由手机浏览器端采集，只包含浏览器可稳定获得的受控信息：`platform/version/name`、
`userAgent`、语言、`navigator.platform`、viewport、screen、timezone、online 和采集时间。Desktop main
只把它保存在当前 window runtime，并通过 `getWebRemoteControlStatus()` 暴露给桌面端；它不参与
workspace identity、session 绑定、缓存 key 或 relay 配对判定。

Desktop 和 mobile 收到 relay `data.payload` 后必须先走 `parseWebRemoteControlAppPayload()`。无效 payload 只记录安全元数据，不记录原始 JSON。

`workspace-list-updated` 只用于 desktop renderer 已经通过 `syncWebRemoteControlTasks` /
`syncWebRemoteControlWorkspaces` 同步新快照后，把同一份 `WebRemoteControlWorkspaceListResult`
推给已连接的手机端。它不改变 relay 和 desktop main 的职责：relay 仍只透传 `data.payload`，desktop main
仍只组合并转发 renderer 已同步的 workspace/task 索引，不持有 ZCode task、stream、queue 或 snapshot 业务状态。

`bridge-degraded` 不属于普通可丢 app response。Desktop main 为当前 bridge generation 保留一个不含业务
snapshot 的 invalidation latch：Source logical session 换代或 raw transport fault 后立即释放旧手机
attachment，并在 relay 再次 paired/send-ready 时补发，直到新 `workspace-bridge-ready` 成功后清除。
这只是连接级可靠通知，不把 task/session/queue/snapshot 事实下沉到 main。Mobile 收到后用新
`bridgeSessionId + bridgeGeneration + recoveryId` 重建；首次重建失败后只允许按 1s/2s/5s 有界退避继续
尝试，同一 recovery flight 保持 `recoveryId`、每次使用新的 bridge generation。任一次成功后清空预算；
预算耗尽后必须先销毁旧 bridge protocol 与 service registration，再进入明确的
`connection-recovery-timeout` 非 active 终态，并提供由用户触发的整页重试。不能继续把已 degraded 的旧
bridge 显示为 active，也不能由 relay/main 保存业务状态来掩盖恢复失败。

## Desktop Main

`packages/desktop/src/main/webRemoteControlManager.ts` 负责：

1. 通过独立 `WebRemoteControlDeviceTransport` 连接 V2 relay，握手、重连与心跳见 [桌面生命周期](./relay-v2-pairing.md#桌面-device-生命周期03)
2. main 直接用 Node fetch 调用注册/token 接口；`webRemoteControlRelayV2Device` 保存非敏感 `{deviceSid, userId, endpointOrigin}`，V1 sid/passHash 首次迁移时清除，不写新 credential
3. 根据 `workspaceKey = workspaceIdentity?.trim() || workspacePath` 匹配 workspace
4. 为当前 mobile bridge 创建新的 `MessagePort` attachment
5. 用 shared acknowledged adapter 把 host `MessagePortProtocol` 的 RPC message 编码成有界
   `rpc-frame` fragments，并消费 cumulative ACK
6. 不解析 ZCode task 业务语义，不参与 task stream、permission 或 workspace task list 的同步逻辑

### 桌面应用重启后的启用状态恢复

桌面端把“上次是否开启 Web 远控”解释为用户的启用意图：一次远控启动成功后记录最后目标；
用户明确点击停止后清除该记录。窗口销毁和应用退出会释放本次运行的 transport / attachment，
renderer reload 可以继续复用窗口级 runtime；这些生命周期事件都不得把启用意图改写成关闭。
这样应用正常退出或意外退出后都能恢复，而用户主动关闭后不会在下次启动时重新打开。
endpoint 切换等配置变化可以暂停当前 runtime，但同样不代表用户关闭了远控功能。

持久化目标只保存 `workspacePath`、可选 `workspaceIdentity` 和可选 `initialTaskId`。
`remoteSessionId` 属于本次进程内的远程连接身份，禁止跨应用重启持久化。新进程必须等待
renderer 把当前窗口已恢复的 workspace 上下文同步到 main，再按
`workspaceKey = workspaceIdentity?.trim() || workspacePath` 匹配最后目标，并使用当前进程的
`remoteSessionId` 启动 device relay；启动前还必须读取有效登录 JWT。无 JWT 时保持
`auth-required`，保留启用目标，等待 renderer 登录通知后重读凭据并重试。登出立即停止
所有远控 runtime，但不清除启用目标。JWT 已就绪而目标尚未恢复到任一窗口时保持 `idle`，不得为自动恢复
另起 local host、远程 session 或 Agent runtime。

```text
上次启动成功 ──> 保存 enabled target ──┐
                                         v
新 desktop main -> 等待窗口 workspace sync -> workspaceKey 匹配 -> 等待 JWT -> 启动 device relay
                                         |
                                         +-> 不匹配：保持 idle，继续等待后续窗口同步

登录通知 ──> 重读 JWT + 已同步 workspace ──> 重试恢复
登出通知 ──> abort 启动 / 停止 runtime ──> auth-required（保留 enabled target）
用户明确停止 ──> 清除 enabled target ──> 下次启动保持 idle
```

自动恢复只重建 desktop device relay。手机仍通过 `web-remote-replayable` attachment 进入现有
shared host；桌面 renderer 仍保持 `desktop-continuous`，不得把 replayable snapshot / gap 恢复
语义扩散到桌面主链路。

外部 relay 不再提供 `bridgeToken` 或 `wsUrl`。`WebRemoteControlExternalWorkspaceBridge` 只描述 workspace 身份和 `bridgeSessionId`。

手机远控页面不拥有独立 host process，也不会启动独立 Agent runtime。desktop main 在收到
`workspace-bridge-open` 后，为手机 bridge 创建一个新的 `MessagePort` attachment，
并把该 attachment 挂到目标桌面窗口唯一 Window Host 的 local/remote workspace scope。
relay 只透传 `rpc-frame`，不解析 ZCode task、stream 或 workspace 业务语义。

Desktop renderer 和 mobile Web remote control 通过不同 RPC client 连接同一个 host/service/runtime。每个 attachment 由 host 分配独立 `connectionId` 和可信 `clientMode`：本地及 SSH/WSL/Docker 桌面窗口都是 `desktop-continuous`，手机 `/remote` 是 `web-remote-replayable`。host 为每个 attachment 建立 owned-subscription registry；下行帧只能写给拥有该 `subscriptionId` 的 MessagePort，禁止 workspace 广播后让手机丢弃桌面帧。

手机 raw adapter 的 high/low 边沿只通过 owning attachment 的 MessagePort sideband 上行；control object
在 Channel parser 前消费，不会成为 RPC request/event：

```text
mobile adapter high/low
  -> desktop main（无 topic/session state）
  -> owning host attachment only
  -> trusted connection scope（serial + dedupe）
  -> existing workspace CLI: v4/connection/flow
  -> pause/resume only mobile connection B

desktop connection A ───────────────────────────────> continues draining
```

main/relay 不能指定任意 connectionId；host scope 从 owned subscription 生成 workspace/connection route。
remote host relay 对下游 id 做长度前缀 namespace。port close 串行发送 `closed` 后再 dispose owned
subscriptions，旧 SAT/DRN/timer 不得复活。

`zcode-server /ws` 对所有普通连接固定为 replayable；旧的
`x-zcode-rpc-client-mode` header 会被忽略，不能把浏览器或普通 WebSocket 升格为
continuous。desktop server-remote 的 Node host 先通过受现有 server auth middleware
保护的 `POST /api/rpc-host-capability` 获取短期、一次性随机 capability，再在 Node-only
header 中携带它连接专用 `/ws/host`。服务端消费成功后才创建 continuous trusted relay
attachment，最终 `connectionId` 仍由 server 逐连接生成。open/no-token server 也保留同一
“显式申请 ticket → 一次消费”的边界；无 ticket、无效 ticket、过期或重放均拒绝。

```text
Desktop Node host
  │ POST /api/rpc-host-capability（沿用现有 auth）
  v
短期 capability ── 首次消费 ──> GET /ws/host ──> continuous trusted relay
       │                              │
       └─ 过期 / 重放：拒绝          └─ server 生成 connectionId

Browser / 任意普通 client
  └─ GET /ws（旧 mode header 被忽略）──────────> replayable terminal
```

每个 attachment 的 subscribe 在调用 CLI 前先建立 pending ownership。CLI server 用 request-scoped
post-response outbox 固定按 `ACK response -> initial notification` 写出；即便两行在同一 read 中到达，
ACK 前早到的 physical wire 仍只进入有界 staging，ACK 绑定 `subscriptionId`
后才按原序释放给唯一 owner 的 incremental assembler。ownership 过滤先于 assembly；
foreign subId 不占内存。staging 上限为 1,024 wires / 32 MiB，溢出清空整批并显式
标记 `fault.subscription.initialFrameStagingOverflow`，禁止 shift 单片。attachment close /
stale generation / unsubscribe 清空 staging 与 assembly。unsubscribe 则由 owned
registry 生成完整 `{ topic, subscriptionId, connectionId }` route，CLI 只删除三者完全匹配的
publisher entry，避免相同裸 `subscriptionId` 跨 topic 或连接误删。

CLI publisher 的 initial/online 帧均使用 non-destructive reservation：全部 physical
notification 在当前 transport 被接受后才推进水位；中途失败重试相同
logical id/content。topic encoder 按 CLI NDJSON、Channel binary 与旧 mobile outer 的保守上界
切片；production mobile Channel message 随后还会经过 raw adapter 的独立精确 final-envelope
meter/fragment，因此实际 relay JSON 同样不超过 1 MiB。附件另走
`begin -> <=512KiB decoded chunk -> commit/abort` 业务事务；renderer→host Channel 与 host→CLI
NDJSON 分别实测 envelope，禁止 full-data `attachment/put` fallback。relay/main 仍只看 opaque
`rpc-frame`，不保存 upload staging、checksum 或 artifact ref。
每个 subscription 同时持有单调 `logicalFrameOrdinal`；host/renderer assembler 用它
阻断迟到 replay 与反向 supersede，完成/fault/timeout 的 tombstone 只在
unsubscribe/换代时清除。

task messages、assistant stream、tool call、permission、plan、runtime status 和 task list 的真实元数据都来自同一个 CLI/runtime。composer draft、scroll/focus/panel 等未提交状态保持 renderer-local；一旦输入被提交，无论来自桌面还是手机，都直接进入同一个 CLI `CommandInbox`/runtime FIFO。手机 V4 不再经过 `enqueueTaskCommand` 的 host runtime command queue，桌面也不保留 renderer-local accepted queue；UI 只保留 pending optimistic overlay 并用 projection/`commands/query` 对账。

远程 workspace bridge 只允许 attach 到桌面窗口已经存在且未关闭的 `remoteSessionId`。`remoteSessionId`
由 Window Host 内的 registry 分配，仍是 workspace 级 logical session；main 只持请求关联并转发 scope，
最终由 Host 校验 session 已绑定的 `workspacePath + workspaceIdentity` 后创建独立 attachment。手机端不能创建新的 SSH / WSL /
Docker remote session，也不能借 session A 访问同 Host 下的 workspace B；身份隔离继续使用
`workspaceIdentity?.trim() || workspacePath`。

桌面 renderer 在远程目录选择或重连确定 canonical path 与 identity 后，必须通过
`BindRemoteWorkspaceSessionContext` 把同一组 `workspacePath + workspaceIdentity` 绑定回 main/Host 的
logical session。tab、远程历史与手机可见 workspace 列表使用的值若与 main descriptor 不一致，bridge 会以
`REMOTE_WORKSPACE_IDENTITY_MISMATCH` 拒绝（3.12.0 曾因新建连接后缺少这次 bind 导致手机端连不上远程项目）。

进程回收仍由桌面生命周期触发：真实关窗、app quit、update install 会关闭 attachment 后回收对应或全部
Window Host；手机 bridge/relay 断连、页面刷新和 replayable 重连只释放短生命周期 attachment，不能销毁
Window Host 或仍被其他 owner 使用的 remote connection。该边界不改变 `workspaceIdentity + remoteSessionId`
路由，也不把 replayable 状态下沉到 main。

## Task Message Streams

桌面端和手机端连接的是同一个 service/runtime，但 delivery profile 由可信 attachment 决定，不是 UI 参数：

- 桌面端（包括远程 workspace 桌面窗口）固定 `continuous`，保持完整实时数据流。
- 手机 Web 远控固定 `replayable`，用于断线重连、页面刷新、晚订阅和 gap 恢复。

replayable 不是 relay 级别的重放。relay 仍只透传 `rpc-frame`；connection-level
saturated/drained 由 desktop main 通过 owning MessagePort sideband 传给 host/CLI。topic seq、subscriber
buffer、fragment assembly、gap/resync 和 snapshot 都由 host facade 与 CLI publisher/client apply 维护，
relay/main 不持有 conversation 业务状态。

手机端 gap 或 attachment 重建后的恢复顺序是：

1. 重新 attach bridge，完成 V4 `hello/clientHello`，获得新的可信 connection context。
2. 自动按活跃 topic 重订阅；有合法 `{logEpoch, seq}` 时尝试 resume，否则 snapshot。
3. snapshot 完整分片 assembly 后整体替换；`toSeq <= localSeq` 静默丢弃。
4. gap 只触发一次 `v4/conversation/resync`；resume 再断档强制 snapshot。
5. 从 projection 恢复 permission/elicitation、queue/guided row 与 pending command summary；ACK 不明时用 `commands/query` 对账。

CLI runtime restart 会改变 `logEpoch` 并触发 snapshot。上一进程已 admitted 但未进入 transcript 的输入明确返回 `fault.command.inputDiscardedOnRestart` 及持久 `delivery`；旧 runtime 的 `queue/guide` 静默结算，只有未进入 transcript 的 `startNow` 或 `unknown` 提示用户确认重发，不能自动重放。手机网络断线但 runtime 未换代时，仍由 replayable snapshot 恢复权威 queue，不依赖 renderer localStorage。

阻塞类事件不能按普通 owner-only 内容流过滤。`permission_request`、`elicitation_request`、对应 response、terminal 和 snapshot invalidation 必须对同 task 的在线客户端可见，或至少触发 snapshot 对齐。

## Web

`/remote/v4` 是 V2 登录与 QR 直连入口，回调模式先于登录门禁。开发/构建别名沿用路由配置，全部使用 V2。

Mobile web 连接流程：

1. 识别 code/state 回调并保存登录态回跳；否则先过 JWT 登录门禁，再解析 sid/mid/name/app_version。无 SID 时读取当前账号设备列表，最近设备仍在线则直连，否则展示可刷新的设备列表；选择在线设备后回写 URL。
2. 通过 `WebRemoteControlTerminalTransport` 申请 role=terminal token，连接 ws2?token&mid，再发送 V2 auth_init(device_sid)；401 回登录，AUTH_FAILED 显示账号归属失败与切换账号动作。
3. paired 后发送 `bootstrap-request`；v4 使用响应中的可选 `desktopAppVersion` 校验 URL。
   首次不一致时校正并导航，已进入页面时保留页面并提示确认后重新加载；旧桌面缺字段时保持原行为。
   重连/回前台时即使 bridge 健康也重新校验，具体边界见 [v4 版本同步](./remote-v4-static-deployment.md#v4-url-与桌面实际版本同步)。
4. 按 `mobileViewState -> initialViewState -> first workspace` 选择初始 workspace
5. 若目标远程工作区尚不具备 bridge 条件，渲染 home-only `Root`，保留工作区列表与重连入口；
   此时不创建 workspace bridge，也不开放依赖工作区服务的任务操作。没有可选工作区时显示错误页。
   工作区列表由 ProjectSidebar 在没有 projectService 时从 `listWorkspaces` 与推送读取，行为见
   [虚拟项目 §6.0.3](../superpowers/specs/2026-09-09-virtual-project-design.md#603-手机项目新目录的-shared-host-admission)。
   home-only 空服务沿用 `ProxyChannel` 命名契约：`onXxx` 是永不触发的 Event，`onDynamicXxx(arg)` 同步返回该 Event，
   其他未显式实现的方法异步返回 `undefined`。home-only `Root` 挂载后与 bridge `Root` 一样标记 ready，
   之后的配对状态变化只更新横幅，不再替换为加载页或重挂首页。
   已打开的同一远程会话随后断线时则注销失效 services、保留当前 Root 的只读内容与草稿，并显示断线横幅；详见[工作区重连](./mobile-remote-workspace-reconnect.md)。
6. 目标可建立 bridge 时发送 `workspace-bridge-open`，用 `createAcknowledgedWebRemoteControlRelayProtocol()`
   将 `rpc-frame` / `rpc-frame-ack` app payload 适配为 `IMessagePassingProtocol`，维护分片、ACK 与传输恢复。
7. `connectViaProtocol()` 后渲染 `Root`；窄屏由 `WebRemoteControlMobileShell` 管理首页/聊天页，
   宽屏使用远控侧栏。初始 workspace 的选择与页面落点是两种状态，不能把选中 task 等同于自动进入聊天。

手机 V1/HMAC、`/web-remote` 路由、已登录等待页和 `remoteControlToken` / `relayOrigin` 的旧 HTTP bootstrap 均移除。认证/连接 owner、错误恢复与时序见 [Relay V2](./relay-v2-pairing.md#手机首次进入与恢复05)。

## Feature Exposure

当前 Desktop main 使用 `createWebRemoteControlFeatureGate()`，其默认值为 `true`，
不按 production/development 环境自动禁用远控。生产环境可以通过既有远控入口启动并获取连接信息；
不能再把“生产构建”视为启动 IPC 被拒绝或 status 隐藏二维码的保证。

`WebRemoteControlFeatureGate` 仍保留显式禁用能力：注入 `false` 时 manager 拒绝启动，
status 不返回有效远控连接信息。该 gate 是功能开关，不替代下文的调用来源校验与内部票据边界。
当前接线见 `packages/desktop/src/main/index.ts`，开关实现见
`packages/desktop/src/main/webRemoteControlFeatureGate.ts`。

## 启动调用边界与 Office XSS 关系

打开 `WebRemoteControlDialog` 是用户进入 Web 远控的既有入口。当前目标没有可复用 runtime 时，
renderer 通过登录门禁后发送启动 IPC；二维码不再提供刷新配对操作。Desktop main 不叠加原生二次确认。

```text
WebRemoteControlDialog open (signed in)
        │
        ▼
Desktop main: window/source check
        ▼
Manager: issue internal one-time ticket (short TTL)
        │
        ▼
Manager: consume ticket exactly once -> start relay
```

manager 仍生成绑定 `windowId + workspaceKey + remoteSessionId` 的短 TTL、一次性内部票据，其中
`workspaceKey = workspaceIdentity?.trim() || workspacePath`；
票据不得进入 renderer 可写的共享协议，也不得写入日志、遥测或普通设置。它用于约束
`startAuthorized` 的调用和目标一致性，但因为同一个 IPC 请求会立即签发
票据，所以它不是用户授权，也不能阻止已被攻陷的 renderer 调用启动 IPC。

IPC handler 的 manager 依赖类型只暴露 `authorizeStart`、`startAuthorized`、
`notifyAuthStateChanged`、`stop` 和 `getStatus`。直接 `start` 属于 manager 内部生命周期实现，
不能进入 renderer 可达的 IPC 依赖接口；刷新配对 IPC 已删除。认证通知只包含状态，main 重新读取凭据。公共返回类型保留 `cancelled` 兼容分支，当前 Desktop 启动不会产生该终态。

启动、窗口关闭、用户停止和票据超时都必须使未消费票据失效。应用启动时恢复
“上次已启用”仍是内部生命周期操作，不得绕过 workspace/session 绑定。

Office 文档 XSS 的根因边界由 `docs/ui/office-file-preview.md` 定义：不可信链接必须经过协议白名单、
DOM 净化、点击拦截和受控外链打开。移除原生远控确认不改变这些根因修复；代价是如果未来出现新的
renderer XSS 或上述边界被绕过，攻击代码可以再次直接调用远控启动 IPC，内部票据不会提供用户在场
证明。安全评估不得把该票据当作 Office XSS 的补偿控制。

`web-remote-replayable` 默认不应获得终端能力。若产品仍需手机终端，必须通过独立的
workspace/session/device 绑定 capability、短 TTL、owner/lease 和断线回收来暴露，不能把通用
`services.exposeOnChannelServer()` 视为授权。

## Workspace Hook Trust Review

Workspace Hook Trust 不在 relay、desktop main 或 renderer 中复制业务状态。Desktop continuous 与 Mobile/Web
replayable attachment 共享同一个 CLI Runtime review registry：

```text
project Hook discovery
  -> CLI Runtime immutable snapshot
  -> Runtime review registry (唯一权威)
       ├─ continuous delta -> Desktop Settings
       └─ replayable snapshot/delta -> Mobile/Web Settings

Settings decision
  -> trusted connection facade
  -> sendConversationCommandV4
  -> CLI CommandInbox
  -> task/run/remoteSession/workspace/bundle/generation validation
  -> Trust mutation or fail-closed reason
```

约束：

- Host capability `workspaceHookReview` 和 Client UI capability `workspaceHookReviewUi` 必须分别声明；缺失等价于 false。
- review request 作为 `pendingInteractions[kind=workspaceHookReview]` 投影，手机 refresh、gap/resync 或 attachment 重建只恢复 presentation，不 settle Runtime request。
- command target 绑定 `taskId + runId + remoteSessionId? + workspaceIdentity + bundleDigest + reviewFlowId + generation + interactionId`；任一不匹配都在 store mutation 前拒绝。
- renderer pending-command registry 只保存 sensitive command digest/ACK 状态。ACK 不明时可以 `commands/query`，不得持久化或自动重放原始 Trust decision。
- Runtime restart 产生新的 run epoch；旧 interaction、Allow once 和 pending sensitive command 不能跨 epoch 复用。
- `workspaceHookTrustEnabled=false` 时 Runtime 不读取 Trust store、不创建 review；Protocol Host 可在 trusted bootstrap 边界关闭该字段回滚到 hard block。
- managed deny 始终高于 UI/CLI 建立的 Trust；relay/main 只路由 opaque command 和 projection，不持有 policy、Trust store 或 lease 的副本。

### 2026-09 虚拟项目目录导航

手机 home 复用 ProjectSidebar，经当前 base attachment 读取 Host 项目行集合；手机 shell 仅拥有 home/chat 与浏览器返回状态。`workspace-bridge-open.project` 是严格的 projectId/hostId 意图，由 main 转交窗口 Host 的 ProjectService 准备执行目录。它允许在已在线物理 Source 上创建或复用目录 logical scope，不允许隐式新建物理连接、Host 或 Agent。准备前后检查连接成员代际、项目入口与物理连接对象；main 只保留当前导航的 RPC promise，同一 bridge identity 的重试不重复分配目录，取消/关窗/后续导航使迟到结果失效。

Host 返回可信 workspaceIdentity、remoteSessionId、cwd 后沿原 shared-host attachment 建立手机 replayable bridge。项目/provider/初始输入只在 Web 的 Root 交接中传递，main 不存草稿或任务业务状态。桌面 direct continuous、手机 snapshot/gap 恢复、owner/lease 和 CLI CommandInbox 的单队列规则保持不变。

手机未提交项目草稿复用 Renderer 既有 composer 持久化：按 workspaceKey 的 `__draft__` scope 保存可选 projectId，与正文/模型一起恢复。Root 重建或页面 reload 在 prewarm 前恢复该选择；显式新建未归类草稿写 NULL，明确 taskId 的历史打开优先。提升为持久任务后不把 projectId 复制到 session composer scope；已提交任务的归属仍只由 Host app 库拥有。main、relay 和 shared-host transport 均不持有这份草稿。
