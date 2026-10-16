# Web 远程控制概览与外部 Relay 架构

本文描述当前有效实现。旧的仓库内 relay、窗口 control socket、bridge token、HTTP bootstrap API 已移除，不再作为兼容路径。

## 产品概览

手机 Web 远控让用户在浏览器中访问目标桌面窗口已经打开的工作区和任务。桌面应用承载
实际服务与 Agent runtime，手机通过外部 relay 接入同一 Host 的 workspace scope；手机页面
不启动独立 Host 或 Agent，relay 只负责鉴权、配对、心跳和消息透传。

### 使用流程与页面

1. 在桌面打开 Web 远控对话框，启动远控并取得二维码或连接链接；手机浏览器打开链接后完成配对。
2. 窄屏首次扫码默认进入任务首页，可按工作区分组或跨工作区时间线浏览任务。
   二维码携带的初始任务用于选中和定位，不直接跳进聊天页。
3. 点击任务进入聊天；工作区的新建任务入口进入该工作区的草稿页。跨工作区操作先切换 bridge，
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

Desktop 和 mobile web 只在标准 test endpoint 上切换到测试 relay，production 与其他自定义
endpoint 继续使用生产 relay：

```bash
production/default: wss://zcode.z.ai/ws
test endpoint:       wss://zcode.z.ai/ws
```

`ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL` 仍是最高优先级的显式调试覆盖。没有覆盖时，仅当规范化后的
endpoint origin 为 `https://zcode.z.ai` 才使用测试 relay；production 与 localhost/custom
endpoint 保持生产 relay，避免扩大自定义 endpoint 的既有语义。二维码页面 URL 仍由 App 版本在
`/remote/v3` 与 `/remote/v4` 之间派生；`ZCODE_WEB_REMOTE_CONTROL_URL` 只用于显式调试覆盖。

开发时可以把手机页指向本地 web：

```bash
ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL=wss://zcode.z.ai/ws \
ZCODE_WEB_REMOTE_CONTROL_URL=http://localhost:5173/remote \
pnpm dev:desktop
```

## 静态部署

手机远控页是 `packages/web` 的 Vite SPA，不使用 Next.js 静态导出，也不存在
`remote.html` 这类页面文件。生产部署只需要把 `packages/web/dist` 交给 nginx 托管，并把入口路径
映射回 `index.html`。

当前保留四条静态部署链路：

```text
v2:
  -> pnpm run build:web-remote-control
  -> packages/web/dist
  -> Dockerfile.web-remote-control
  -> uhub.service.ucloud.cn/tianqi/zcode-remote-mobile-v2
  -> zcode/frontend/deployment-remote.yaml
  -> /remote

v3:
  -> pnpm run build:web-remote-control:v3
  -> packages/web/dist
  -> Dockerfile.web-remote-control-v3
  -> uhub.service.ucloud.cn/tianqi/zcode-remote-mobile-v3
  -> zcode/frontend/deployment-remote-v3.yaml
  -> /remote/v3

v4:
  -> pnpm run build:web-remote-control:v4
  -> packages/web/dist
  -> Dockerfile.web-remote-control-v4
  -> uhub.service.ucloud.cn/tianqi/zcode-remote-mobile-v4
  -> 外部基础设施的 zcode/frontend/deployment-remote-v4.yaml
  -> /remote/v4

test:
  -> pnpm run build:web-remote-control:test
  -> packages/web/dist
  -> Dockerfile.web-remote-control-test
  -> uhub.service.ucloud.cn/tianqi/zcode-remote-mobile-test
  -> zcode/frontend/deployment-remote-test.yaml
  -> /remote/__test__
```

v4 的 test 与 production 线上部署共用同一个 Dockerfile 和 `/remote/v4` 资源基址，但由独立 Jenkins
Job、镜像和 Deployment 隔离。两个 Job 必须分别显式传入 `ZCODE_ENV=test` 与
`ZCODE_ENV=production`；Dockerfile 在 builder stage 校验后交给 Vite 注入 endpoint。域名本身不会在
浏览器运行时改写已经编译进 JS 的产品环境：

```text
test:       zcode.z.ai/remote/v4 -> wss://zcode.z.ai/ws
production: zcode.z.ai/remote/v4         -> wss://zcode.z.ai/ws
```

`/remote/__test__` 仍是独立的静态资源验证入口，不代替标准 test 产品环境的 `/remote/v4`。

`/remote` 是旧资源入口，发布脚本仍更新 `deployment-remote.yaml`。
`/remote/v3` 是旧版本 App 资源入口，发布脚本只更新 `deployment-remote-v3.yaml`。
`/remote/v4` 是 `3.4.0` 及以上正式版本 App 的资源入口，发布脚本只更新
`deployment-remote-v4.yaml`。
`/remote/__test__` 是测试资源入口，发布脚本只更新 `deployment-remote-test.yaml`。
四条链路使用独立 Dockerfile、nginx 配置、镜像名和 k8s deployment 文件，避免新资源发布覆盖旧版本 App 仍在使用的资源。

四份 nginx 配置都必须把各自构建基址下的 `assets/`、`material-icons/` 和
`pdfjs/cmaps/` 显式映射到 `/usr/share/nginx/html` 内对应的构建产物。PDF.js CMap 实际位于
`/usr/share/nginx/html/pdfjs/cmaps/`；带 `/remote`、`/remote/v3`、`/remote/v4` 或
`/remote/__test__` 前缀的请求不能进入 SPA fallback，否则 nginx 会用 `index.html` 的 200 响应
伪装成静态资源成功。Docker smoke 必须比较代表性 `.bcmap` 的实际响应体，不能只断言 HTTP 200。

本地验证：

```bash
pnpm run typecheck
pnpm run lint
pnpm run build:web-remote-control
bash scripts/test-web-remote-control-docker-build.sh
pnpm run build:web-remote-control:v3
bash scripts/test-web-remote-control-v3-docker-build.sh
pnpm run build:web-remote-control:v4
bash scripts/test-web-remote-control-v4-docker-build.sh
pnpm run build:web-remote-control:test
bash scripts/test-web-remote-control-test-docker-build.sh
```

构建并推送：

```bash
export DOCKER_REGISTRY_PASSWORD='***'
bash scripts/docker-build-and-push-web-remote-control.sh --tag 202604291800
bash scripts/docker-build-and-push-web-remote-control-v3.sh --tag 202604291800
bash scripts/docker-build-and-push-web-remote-control-v4.sh --tag 202604291800
bash scripts/docker-build-and-push-web-remote-control-test.sh --tag 202604291800
```

`zcode/frontend/deployment-remote-v4.yaml` 和 `zcode/frontend/deployment-remote-test.yaml` 都是外部基础设施
仓库内的约定路径，不在当前仓库，也不由本功能创建。发布脚本默认使用
`K8S_REPO_DIR=~/workspace/cgx-dev-k8s` 更新对应 deployment 文件并创建 MR；如果传入 `--skip-mr`，
脚本只构建并推送镜像，不更新外部仓库。

Desktop 默认二维码 URL 不指向 `/remote/__test__`。需要验证测试资源时，通过环境变量覆盖：

```bash
ZCODE_WEB_REMOTE_CONTROL_URL=https://zcode.z.ai/remote/__test__ pnpm dev:desktop
```

nginx 只负责静态资源和 SPA fallback，不代理 relay。浏览器端根据构建时 endpoint 直接连接对应 relay：
production 使用 `wss://zcode.z.ai/ws`，test 使用 `wss://zcode.z.ai/ws`。Desktop App 正式版本大于等于 `3.4.0` 时，二维码 URL 使用
`https://zcode.z.ai/remote/v4?...`；低于 `3.4.0`、`3.4.0` 自身的预发布版本或无法解析的版本继续使用
`https://zcode.z.ai/remote/v3?...`。高于该门槛的预发布版本（例如 `3.5.0-beta.1`）使用 v4；显式
`ZCODE_WEB_REMOTE_CONTROL_URL` 覆盖值不会被版本逻辑改写。

四份 `Dockerfile.web-remote-control*` 都使用 Node builder 在容器内执行过滤安装和 Vite 构建：
`pnpm install --frozen-lockfile --filter @zcode/web... --ignore-scripts`。runtime stage 只保留
`nginx:alpine` 和静态 `dist`，不包含 Node runtime。发布脚本不在宿主机重复构建，保证最终镜像资源
只来自 Docker builder。

## Transport

外部 relay 只负责传输层：

1. desktop 以 `device` 角色连接当前 endpoint 对应的外部 relay，可通过 `X-Device-ID` 传 `device_mid`
2. mobile web 以 `terminal` 角色连接同一 endpoint，浏览器通过 query `mid=<device_mid>` 传 routing hint
3. relay 完成 `device_register_init`、`auth_init`、`auth_challenge`、`auth_response`、`auth_ack`
4. 双端用 `pair_status_query` / `pair_status_ack` 做平均 10 秒、有界 8~12 秒 jitter 心跳；最近一次 ACK 超过 30 秒未更新时由本地 watchdog 触发重连，watchdog 触发的重连再增加小幅随机延迟以避免重连尖峰
5. ZCode 业务消息全部放在 relay `data.payload`，relay 不解析 payload

Task 实时同步也遵守这个边界：relay 只转发 mobile 与 desktop main 之间的 `rpc-frame`，不解析 task、session、workspace 或 ZCode realtime 事件。手机远控页面不拥有独立 Host，也不会启动独立 Agent runtime。desktop main 在收到 `workspace-bridge-open` 后，为手机 bridge 创建新的 `MessagePort` attachment，并挂到目标桌面窗口唯一 Window Host 中对应 local/remote workspaceKey 的 service/CLI scope。relay 只透传 `rpc-frame`，不解析 ZCode task、stream 或 workspace 业务语义。

### 心跳调度与失联恢复

心跳只属于 desktop device transport 与 mobile terminal transport 的本地传输状态，relay 不保存或广播客户端的调度时间：

```text
auth_ack / matched
        │
        ▼
本地随机等待 8~12 秒
        │
        ▼
发送 pair_status_query ─────────────┐
        │                           │
        └─ 再随机等待 8~12 秒         │
                                    ▼
                         收到 pair_status_ack
                                    │
                         重置 30 秒 ACK watchdog
                                    │
                         30 秒无 ACK → 本地重连
```

心跳使用递归 `setTimeout`，每轮重新抽样，平均周期仍为 10 秒；不得补发页面后台或系统休眠期间错过的历史心跳。30 秒是时间型 ACK deadline，不按固定次数推断失败；watchdog 触发的重连增加小幅随机延迟，明确错误、用户停止和前台恢复等路径保持原有立即恢复语义。心跳 payload 与 relay 协议 schema 不变。

配对身份是 `device_sid`。QR URL 是：

```text
/remote/v4?sid=<device_sid>&hash=<pass_hash>&t=<timestamp>&mid=<device_mid>&name=<device_name>&app_version=<app_version>
```

`hash` 是 HMAC key material，只出现在 QR URL 和 credential 存储中，不写入日志、OAuth state 或 setting.json。

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

## Desktop Main

`packages/desktop/src/main/webRemoteControlManager.ts` 负责：

1. 通过 `WebRemoteControlDeviceTransport` 连接外部 relay
2. 通过 `WebRemoteControlRelayAuthStorageProvider` 把非敏感 `deviceSid` 存 AppSettings，把 `passHash` 存 credentialService
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
`remoteSessionId` 启动 device relay。目标尚未恢复到任一窗口时保持 `idle`，不得为自动恢复
另起 local host、远程 session 或 Agent runtime。

```text
上次启动成功 ──> 保存 enabled target ──┐
                                         v
新 desktop main -> 等待窗口 workspace sync -> workspaceKey 匹配 -> 启动 device relay
                                         |
                                         +-> 不匹配：保持 idle，继续等待后续窗口同步

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

`/remote`、`/remote/v3` 和 `/remote/v4` 是 QR 直连入口，先于 `/web-remote` OAuth 逻辑处理。

Mobile web 连接流程：

1. 解析 `sid/hash/t/mid/name/app_version`
2. 通过 `WebRemoteControlTerminalTransport` 认证为 `terminal`
3. paired 后发送 `bootstrap-request`；v4 使用响应中的可选 `desktopAppVersion` 校验 URL。
   首次不一致时校正并导航，已进入页面时保留页面并提示确认后重新加载；旧桌面缺字段时保持原行为。
   重连/回前台时即使 bridge 健康也重新校验，具体边界见 [v4 版本同步](./remote-v4-static-deployment.md#v4-url-与桌面实际版本同步)。
4. 按 `mobileViewState -> initialViewState -> first workspace` 选择初始 workspace
5. 若目标远程工作区尚不具备 bridge 条件，渲染 home-only `Root`，保留工作区列表与重连入口；
   此时不创建 workspace bridge，也不开放依赖工作区服务的任务操作。没有可选工作区时显示错误页。
6. 目标可建立 bridge 时发送 `workspace-bridge-open`，用 `createAcknowledgedWebRemoteControlRelayProtocol()`
   将 `rpc-frame` / `rpc-frame-ack` app payload 适配为 `IMessagePassingProtocol`，维护分片、ACK 与传输恢复。
7. `connectViaProtocol()` 后渲染 `Root`；窄屏由 `WebRemoteControlMobileShell` 管理首页/聊天页，
   宽屏使用远控侧栏。初始 workspace 的选择与页面落点是两种状态，不能把选中 task 等同于自动进入聊天。

`/web-remote` 仍是 ZAI OAuth 登录与等待页入口；`remoteControlToken` / `relayOrigin` 只属于旧 `/web-remote` 行为，不适用于新的 `/remote`、`/remote/v3` 或 `/remote/v4` QR route。

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
renderer 立即发送启动 IPC；刷新二维码继续使用 renderer 内原有的确认弹窗。为保持既有远控体验，
Desktop main 不再为启动或刷新叠加原生二次确认。

```text
WebRemoteControlDialog open / confirmed QR refresh
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
`startAuthorized` / `resetPairingAuthorized` 的调用和目标一致性，但因为同一个 IPC 请求会立即签发
票据，所以它不是用户授权，也不能阻止已被攻陷的 renderer 调用启动 IPC。

IPC handler 的 manager 依赖类型只允许暴露 `authorizeStart`、`startAuthorized`、
`resetPairingAuthorized`、`stop` 和 `getStatus`。直接的 `start` / `resetPairing` 只属于 manager
内部生命周期实现，不能进入 renderer 可达的 IPC 依赖接口。公共返回类型保留 `cancelled` 兼容分支，
但当前 Desktop 启动和刷新链路不会产生该终态。

启动、刷新配对、窗口关闭、用户停止和票据超时都必须使未消费票据失效。应用启动时恢复
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
