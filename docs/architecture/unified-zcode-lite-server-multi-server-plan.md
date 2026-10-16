# ZCode Lite / Server 统一多端架构实施计划

## 状态

- 类型：全新目标架构与实施计划
- 状态：产品边界已确认，等待分阶段实施
- 范围：Desktop、Browser Web、手机 Remote Controller、本机、SSH、WSL、Docker、Direct URL
- 当前事实依据：
  - `docs/architecture/zcode-code-architecture-overview.md`
  - `docs/architecture/message-flow.md`
  - `docs/architecture/rpc.md`
  - `docs/web-remote-control/web-remote-control-architecture.md`
  - `docs/web-remote-control/task-realtime-sync.md`
  - `docs/web-remote-control-task-command-queue.md`
  - `docs/remote-prompt-attachment-materialization.md`
  - `docs/ssh-remote-app-global-state-authority.md`
  - `docs/task/task-sqlite-index.md`
  - `docs/working-memory/provider-refactor/design/environment/environment.md`
  - `docs/working-memory/provider-refactor/design/registry/runtime.md`

本文重新定义目标架构，不把历史 SSH/Web 实现当成目标模型。实施期间允许保留兼容适配层，但最终必须收敛到本文的进程、身份、状态权威和通信边界。

### 当前临时产品边界

本文后续的 `Browser Web -> Lite Controller Runtime` 是目标架构，不是当前实现。当前普通 Web（包括开发环境 Web 入口和 `zcode-lite serve`）仍由浏览器直接连接 `@zcode/server` 的 `/ws`，没有 Desktop Window Host Controller。因此，在 Lite / Browser Controller Runtime 落地并完成多端回归前，普通 Web 暂不支持依赖 Window Host Controller 的左侧全局任务列表和多 source 聚合，也不在 renderer 中维护第二套 Controller fallback。

```text
当前：Browser Web -> @zcode/server /ws -> createLocalServices()
                                      -X-> Window Host Controller

目标：Browser Web -> Lite Controller Runtime -> Local / Remote Server sources
```

该临时边界不影响 Desktop 本地、Desktop 的 SSH/WSL/Docker/Server workspace，以及附着既有 Desktop Host 的手机 `/remote`。当前事实和具体范围以 `docs/zcode-lite-static-distribution.md` 的“当前普通 Web 支持边界”为准。

## 一、目标

同一套 ZCode Server 能力支持以下入口：

1. Desktop UI 管理本机和多个远端 Server。
2. Browser Web 通过一台 ZCode Lite 管理该机和多个远端 Server。
3. 一台 ZCode Lite 可以连接另一台 ZCode Lite。
4. 手机 Remote Controller 附着到已有 Desktop 或 Lite 控制端，复用它的多 Server 视图。
5. SSH、WSL、Docker、Direct URL 只影响连接建立方式，不改变上层 RPC、资源、Session 和任务语义。
6. 每台机器的同一 OS 用户、同一数据根目录最多运行一个逻辑 ZCode Server。
7. 每个 Workspace 最多运行一个 Agent CLI；一个 Server 可以同时管理多个 Workspace Agent。

## 二、明确不做

- 不引入中心化的 `ZCode Hub` 服务。
- 不让一个 Session 跨越多个 Server。
- 不自动同步不同控制端保存的 Server 连接列表。
- 不让手机独立建立 SSH/WSL/Docker 连接或启动 Agent。
- 不做多用户、角色或细粒度授权；完成鉴权的客户端拥有该 OS 用户范围内的完整 ZCode 权限。
- 不追踪 Workspace 路径移动或重命名；路径变化按新 Workspace 处理。
- 首期不处理 OS 重启后的自动启动与错过任务补跑；Server 启动后持续运行，直到用户手动关闭。
- 不同步 Provider 展示顺序、OAuth 登录态、当前连接选择或 UI 最近模型。
- 不为分组增加跨 Server 持久化；任务能聚合显示即可，跨 Server 排序采用最佳努力。

## 三、统一概念

### 3.1 ZCode Lite

ZCode Lite 是可安装产品，不等同于某一个 UI。它包含：

```text
ZCode Lite
├─ Stable Launcher
│  ├─ 监听、鉴权和稳定 Bootstrap Protocol
│  ├─ 版本协商、运行时缓存、安装和进程锁
│  └─ 启动一个当前 Server Core
├─ Versioned Runtimes
│  ├─ server/<version>
│  └─ connector/<version>
├─ Server Core
│  ├─ workspace / file / git / terminal
│  ├─ task / session / scheduler
│  ├─ model provider
│  ├─ plugins / skills / subagents
│  ├─ resource store
│  └─ workspace -> Agent CLI supervisor
├─ Browser Web 静态资源和 Web 控制入口
└─ 本机 TUI
```

TUI 只是 Lite 的本机 UI 能力。它直接附着本机 Server，不承担跨远端 UI 或传输职责。

### 3.2 ZCode Server

ZCode Server 是 `Launcher + 当前 Server Core + 数据目录` 组成的逻辑实例。

- 多个 Server runtime 版本可以同时安装在磁盘。
- 同一用户、同一数据目录同一时间只能有一个 Server Core 运行。
- Server 生命周期不跟随任意一个 UI 连接。
- 最后一个 UI 断开后 Server 继续运行，以保证定时任务和后台任务可执行。

### 3.3 Controller Runtime

Controller Runtime 是 UI 背后的连接管理器，不是中心 Hub，也不拥有远端业务数据。

```text
Desktop UI
  -> Desktop Controller Runtime
     -> Server A / B / C

Browser Web（由 Lite A 提供）
  -> Lite A Controller Runtime
     -> Server A / B

手机 Remote
  -> 附着 Desktop 或 Lite Controller Runtime
     -> 复用其 Server A / B / C 连接
```

Controller Runtime 负责：

- 保存本控制端的连接配置。
- 建立 Direct URL、SSH、WSL、Docker 连接。
- 选择兼容 Connector。
- 将多个 Server 的只读列表投影聚合给 UI。
- 将用户操作路由到对象所属的 Source Server。

Controller Runtime 不持久化远端 Session 正文、远端 task runtime、远端资源或远端配置副本。

### 3.4 Server、Workspace 和 Session 引用

```ts
interface ServerRef {
  serverId: string;
}

interface WorkspaceRef {
  serverId: string;
  workspaceIdentity: string;
  workspacePath: string;
}

interface SessionRef {
  serverId: string;
  sessionId: string;
}
```

- `serverId` 是 Server 数据根目录内持久化的随机身份，与 IP、域名、SSH 用户和连接方式无关。
- `workspaceIdentity` 是 Server 本机的 Workspace 隔离身份，禁止包含 SSH 账号、IP、域名或跳板链路。
- `workspacePath` 仅用于路径展示和实际 IO。
- 全局 UI 中的 Session、Task、Workspace key 都必须带 `serverId`。
- 同一 Server 内仍遵守 `workspaceKey = workspaceIdentity?.trim() || workspacePath`。

## 四、目标进程模型

### 4.1 Desktop 管理 A、B、C

```text
Machine C
├─ Desktop Renderer
├─ Desktop Controller Runtime
│  ├─ local connector ───────────────> Server C
│  ├─ SSH bootstrap + tunnel ────────> Server A
│  └─ Direct WSS / SSH tunnel ───────> Server B
└─ Bundled Lite Launcher
   └─ Server C
      ├─ Workspace C1 -> Agent CLI C1
      └─ Workspace C2 -> Agent CLI C2

Machine A
└─ Lite Launcher -> Server A
   ├─ Workspace A1 -> Agent CLI A1
   └─ Workspace A2 -> Agent CLI A2

Machine B
└─ Lite Launcher -> Server B
   └─ Workspace B1 -> Agent CLI B1
```

Desktop 本机也通过统一 Server 合同工作。可保留 MessagePort 或进程内快速通道，但它只是 `IMessagePassingProtocol` 的一种实现，不能形成另一套 Service 语义。

### 4.2 Browser Web 管理 A、B

```text
Browser
  -> HTTP/WSS -> Lite A Controller Runtime
                   ├─ local connector -> Server A
                   └─ SSH/Direct connector -> Server B
```

Browser 不直接执行 SSH。浏览器把连接意图提交给 Lite A 的 Controller Runtime，由 A 上的 Node 能力建立 SSH、WSL、Docker 或 Direct URL 连接。

### 4.3 手机 Remote Controller

```text
Mobile Web
  -> relay / direct paired transport
  -> 已存在的 Desktop 或 Lite Controller attachment
  -> Controller 已连接的 Server
```

- 手机没有独立 Host、Server、Agent 或连接目录。
- 手机看到所附着控制端的多 Server 聚合视图。
- 手机继续使用 `web-remote-replayable`。
- Desktop 和普通 Browser 控制链路使用 `desktop-continuous` 或对应的可信 continuous profile。
- `clientMode` / `deliveryKind` 由可信 attachment 注入，UI 不得伪造。

## 五、统一通信

### 5.1 统一的是消息和服务，不是物理链路

```text
Typed Channel / V4 Protocol / Resource Protocol
                       |
              IMessagePassingProtocol
       ┌───────────────┼────────────────┐
       v               v                v
 MessagePort       WebSocket       SSH/WSL/Docker tunnel
 in-process        Direct WSS      bootstrap 后承载同样帧
```

以下内容必须在所有传输上一致：

- 服务频道名、RPC command、event 和 schema。
- Conversation V4 command、ACK、snapshot、delta 和 subscription。
- Workspace、Session、Task 和资源引用。
- Chunk、checksum、取消、背压和错误码。
- capability、版本和 delivery profile。

SSH 只负责：

1. 找到或安装 Stable Launcher。
2. 建立安全 bootstrap 通道。
3. 获取短期设备凭据。
4. 建立到 Launcher 监听端口的 tunnel。

SSH stdio 不再承载一套不同的业务协议。迁移期可以把当前 stdio RPC 包装成统一 transport adapter。

### 5.2 多层跳板机

多层跳板属于 Controller 的 Transport/Bootstrap 层：

```text
Controller
  -> SSH Connector
     -> Jump 1
        -> Jump 2
           -> Target Launcher
```

- 跳板链只存在于连接配置和 SSH backend。
- Server、Workspace、Session、Task 和资源协议不感知跳板。
- 目标身份以握手返回的 `serverId` 为准，不能用跳板链生成身份。

## 六、版本协商

### 6.1 稳定 Bootstrap Protocol

Launcher 暴露小而稳定的协议：

```ts
interface BootstrapHello {
  launcherVersion: string;
  serverId: string;
  activeServerVersion?: string;
  supportedProtocolRanges: string[];
  capabilities: string[];
}
```

握手流程：

```text
发起端 Launcher/Controller
  -> 读取目标 BootstrapHello
  -> 当前 Connector 兼容：直接连接
  -> 本机有匹配 Connector：启动该版本
  -> 本机无匹配 Connector：校验签名后安装
```

目标端规则：

- 已有 Server Core 运行时，不能为新客户端切换版本或启动第二个 Server Core。
- 发起端选择与目标活动 Server 匹配的 Connector。
- 目标端没有 Server Core 时，Launcher 才从已安装 runtime 中选择兼容版本；没有时再安装。
- 数据 schema 只允许单调升级。不得为了兼容旧客户端降级 Server runtime 读取已升级数据。

### 6.2 Capability 优先于版本号判断

产品能力通过 capability 协商。Connector 负责版本适配，UI 根据 capability 控制入口。禁止在业务组件内散落 Desktop 版本号或 Server 版本号分支。

## 七、鉴权和监听

### 7.1 监听

- 默认监听 `127.0.0.1`。
- SSH、WSL、Docker 默认通过 tunnel 访问 loopback。
- 用户显式配置非 loopback 地址时才允许局域网或公网连接。
- 非 loopback 监听必须启用鉴权；公网 TLS 可以由 Launcher 或受支持的反向代理提供。

### 7.2 统一设备鉴权

```text
SSH/WSL/Docker
  -> 已有安全通道内签发设备 Token

Direct URL
  -> 一次性配对码
  -> 长期、可撤销设备 Token

本机 Web/TUI
  -> Launcher 签发本机 Session

手机 Remote
  -> 现有配对流程
  -> 同一设备 Token 语义
```

鉴权后的客户端拥有该 OS 用户下 ZCode Server 的完整权限。首期不增加 RBAC。

## 八、状态权威

| 状态                                | 权威位置                   | 聚合/镜像                           |
| ----------------------------------- | -------------------------- | ----------------------------------- |
| Workspace 文件、Git、Terminal       | Workspace 所属 Server      | UI 只投影                           |
| Session 正文和运行态                | Source Server 的 Agent CLI | UI continuous/replayable projection |
| Task 列表、标题、pin、archive、分组 | Source Server task index   | Controller 最佳努力聚合             |
| 定时任务和调度                      | Source Server              | UI 只管理                           |
| Plugin、Skill、Subagent             | 各自 Server                | 不跨 Server 合并                    |
| Provider 定义                       | 各自 Server                | 用户显式定向同步                    |
| OAuth、连接选择、最近模型           | 各自 Server/UI             | 不同步                              |
| Server 连接列表                     | 各 Controller Runtime      | 不自动同步                          |
| Theme、locale、草稿、滚动           | UI/Controller              | 不下沉 Server 业务层                |
| Prompt Resource                     | 消费它的 Source Server     | Controller 只上传                   |

统一 UI 的设置页必须有明确的 Server 选择器。能力菜单按当前 Task/Workspace 的 Source Server capabilities 构造，禁止把 A、B、C 的 Plugin、Skill 或工具做并集后提交给错误 Server。

## 九、模型 Provider 配置同步

同步是用户主动发起的有方向操作：

```text
Source Server A ──完整镜像──> Target Server B
```

### 9.1 同步内容

- 用户定义的 Provider 名称和启用状态。
- Base URL、Endpoint Paths 和 API format。
- 手工 API Key。
- 持久化 Headers；即使当前 UI 尚未提供 Headers 编辑入口，也属于 Provider 定义。
- 模型列表、模型 ID 映射、上下文和输出限制、reasoning、模态和工具能力等 Provider 模型配置。

### 9.2 不同步

- OAuth 登录态和 OAuth token。
- Z.ai / BigModel 当前连接选择、domain 和 family mode。
- UI 最近模型、thought level 和 Agent config。
- runtime-only headers。
- Provider 展示顺序。
- 系统派生的不可用原因、连接测试结果和临时 runtime 状态。

### 9.3 合并规则

- 用户必须先选择 Source 和 Target。
- 同 Provider ID：Source 覆盖 Target。
- Source 新增：写入 Target。
- 仅 Target 存在：从同步范围删除。
- Target OAuth/本地运行状态不受影响。
- 导入必须使用临时文件或数据库事务，校验通过后原子替换。
- 同步失败保留 Target 原状态，并返回可读报告。
- Secret 不写日志，不进入任务事件和 replayable snapshot。

## 十、统一 Resource Store

长文本自动转文件、拖拽图片、选择文件和手机附件使用同一资源协议：

```text
UI/Controller
  -> resource/begin
  -> resource/chunk*
  -> resource/commit(hash, size)
  -> Source Server Resource Store
  -> AttachmentRef(resourceId)
  -> Agent CLI 解析为本机可读路径
```

核心规则：

- Prompt 中不能把 Controller 本机 `localPath` 当成远端路径传递。
- 资源在发送 admission 前必须落到消费它的 Source Server。
- RPC/WS/SSH tunnel 传输相同的 chunk 语义；SFTP 可以作为上传 adapter 优化，但不能改变上层合同。
- `AttachmentRef` 使用 `resourceId`，本地物化路径只在 Source Server 内部生成。
- commit 校验 size/hash，失败不得让 prompt 进入 CLI。
- commit 成功后由 Session/queue 采用资源；未采用上传由 janitor 回收。
- 手机上传继续通过所附着 Controller 路由到 Source Server，不在 relay/main 保存资源业务状态。

## 十一、多 Workspace Session

一个 Session 可以关联多个 Workspace，但不能跨 Server：

```ts
interface SessionWorkspaceBinding {
  primary: WorkspaceRef;
  secondary: WorkspaceRef[];
}
```

约束：

- `primary.serverId === secondary[i].serverId`。
- Primary 创建后不可变。
- Secondary 可增删和排序。
- Agent CLI 运行在 Primary Workspace。
- Task 只在 Primary Workspace 的列表中出现。
- Secondary 只扩展同一 Server 内文件、Git、Terminal 和工具访问范围。
- 提交绑定时 Server 必须校验所有 WorkspaceRef 属于自身；跨 Server 请求直接拒绝。

## 十二、现状差距

| 领域          | 当前实现                                                                              | 目标                                                               |
| ------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| SSH 生命周期  | Desktop 启动并持有远端 stdio `zcode-server`                                           | 用户级持久 Launcher + 一个 Server                                  |
| Server 入口   | `entry-stdio.ts` 与 `entry-http.ts` 分离                                              | 共用 Server Core，入口只是 transport adapter                       |
| Desktop 本机  | 每窗口 Local Host                                                                     | 本机统一 Server，窗口只是客户端                                    |
| SSH Host      | 窗口级共享 Remote Host                                                                | Controller 连接到目标用户级 Server                                 |
| 身份          | remote route + workspace path 参与 identity                                           | persistent serverId + server-local workspaceIdentity               |
| Provider 权威 | 每个当前 Environment 自己持有 Config、Credential 与 Registry；Desktop 不下发 Registry | 每个 Server 继续自己权威，未来显式 A→B Provisioning 写入目标 Store |
| 附件          | host-local path eager stage 到远端路径                                                | Resource Store + resourceId                                        |
| Web           | 主要是手机 `/remote` 静态客户端                                                       | Lite 提供完整 Browser Web + 多 Server Controller                   |
| 手机          | 附着单个已有、承载目标 workspace scope 的 Local/Remote Host                           | 附着 Controller，复用其多 Server 视图                              |
| 版本          | deploy 当前 Desktop bundle 后直接启动                                                 | 稳定 Launcher + versioned Connector/Server runtime                 |

## 十三、实施阶段

### Phase 0：测试基线和协议冻结

先补文档和测试，不改默认路径：

1. 在 conversation case catalog 和 coverage matrix 增加多 Server、资源上传、版本协商和手机 attachment 用例。
2. 为当前 stdio、HTTP/WS、server-remote、remote prompt attachment 建立契约测试。
3. 保存 Desktop continuous 与手机 replayable 的现有网络/日志基线。
4. 建立 Docker SSH 测试拓扑：Controller、Jump 1、Jump 2、Target A、Target B。

退出条件：当前行为在测试中可重复，后续每阶段能证明没有改变 V4 conversation 语义。

### Phase 1：共享身份和连接合同

1. 在 `packages/shared` 增加严格 schema：
   - `ServerDescriptor`
   - `ServerRef`
   - `WorkspaceRef`
   - `SessionRef`
   - `ServerCapabilities`
   - `BootstrapHello`
2. 新增 Controller 侧 `IServerConnection` / `IServerDirectory` 接口。
3. 所有全局 UI key 改为至少包含 `serverId`。
4. 现有连接通过兼容 adapter 生成临时 descriptor，但不立即修改持久化。

退出条件：一个 UI 可同时持有两个相同 `workspacePath`、不同 `serverId` 的任务且不会串状态。

### Phase 2：Stable Launcher 和版本管理

1. 实现 Launcher 进程、稳定 bootstrap endpoint 和数据根锁。
2. 实现 runtime manifest、签名校验、下载、缓存和清理。
3. 实现 Connector 版本选择。
4. 目标无活动 Server 时选择兼容 Server runtime。
5. 目标已有活动 Server 时只切换发起端 Connector。

退出条件：版本矩阵中不会启动第二个 Server，也不会用旧 runtime 降级读取新 schema。

### Phase 3：合并 Server Core 入口

1. 从 `entry-stdio.ts`、`entry-http.ts` 抽出同一个 `createZCodeServerCore()`。
2. stdio、WS、MessagePort 只负责提供 `IMessagePassingProtocol`。
3. Server Core 持有 service collection、scheduler、workspace registry、task index 和 Agent supervisor。
4. UI 断开只释放 attachment，不退出 Server。
5. Desktop 本机先通过兼容 local connector 接入统一 Server。

退出条件：Desktop 退出或 Browser 关闭后，Server 和已安排的定时任务仍存活；用户手动关闭时才退出。

### Phase 4：Controller 多 Server 连接

1. 抽取 Desktop Controller Runtime。
2. 在 Lite 中装配同一 Controller Runtime，供 Browser Web 使用。
3. 实现 direct、SSH、WSL、Docker transport adapters。
4. SSH 支持 ProxyJump/多跳，但只在 backend 层出现。
5. 连接列表按 Controller 本地持久化，不自动同步。
6. UI 查询携带 `serverId`，动作回到 Source Server。

退出条件：A Web 能管理 A/B，C Desktop 能同时管理 A/B/C，且三个 Source Server 的状态不串。

### Phase 5：Server/Workspace 身份迁移

1. 每个数据根首次启动生成并持久化 `serverId`。
2. 建立 server-local Workspace registry。
3. 扫描旧 `tasks-index.sqlite` 中带 SSH 账号/IP/目标信息的 workspace key。
4. 按目标 Server 内 `workspace_path` 映射到新 workspace identity。
5. 无冲突自动合并；标题、分组、pin 或排序冲突写迁移报告。
6. 写入新 key 后保留一次版本的兼容读路径和迁移完成标记。
7. 同 serverId 数据目录并发运行时拒绝后启动者；离线备份恢复允许保留 identity。

退出条件：

- SSH IP、域名、端口或账号变化后，握手得到同一 serverId，历史任务仍存在。
- Workspace 路径变化时按新 Workspace 处理。
- 迁移可重复执行且不会产生重复任务。

### Phase 6：Resource Store

1. 先为超长粘贴、图片拖拽、普通文件和失败重试补测试。
2. 增加 resource begin/chunk/commit/abort/adopt API。
3. Server 实现 content hash、原子落盘、引用和 GC。
4. Composer 改为发送 `AttachmentRef(resourceId)`。
5. 保留现有 `IPromptAttachmentTransferService` 作为兼容 facade，内部改走 Resource API。
6. 删除远端 prompt 中对 Controller `localPath` 的依赖。

退出条件：Docker SSH Target 中 Agent 读取到的所有附件路径都位于 Target；Controller 临时路径不会出现在协议或 prompt。

### Phase 7：Server 状态权威和 Provider 同步

1. 取消目标架构中的 `desktop-attached-remote` Provider 权威覆盖。
2. 每个 Server 使用自己的 `modelProviderService`。
3. 新增 typed `exportProviderDefinitions` / `importProviderDefinitions`。
4. 实现 Source→Target 原子镜像、Secret 脱敏日志和失败回滚。
5. 设置页增加 Server 选择和同步方向确认。
6. Plugin、Skill、Subagent 只读取选定 Source Server。

退出条件：A→B 后用户 Provider 定义一致；B 的 OAuth、本地连接选择和最近模型不变；A/B 的 Plugin、Skill、Subagent 可以不同。

### Phase 8：多 Workspace Session

1. 扩展 Session schema 为 immutable primary + mutable secondary。
2. 写入时验证所有 WorkspaceRef 的 serverId 相同。
3. Primary Agent runtime 获取 Server 内受控的 Secondary Workspace capability。
4. Task index 只以 Primary Workspace 建立成员关系。
5. Resume、fork、snapshot 和 migration 保留 binding。

退出条件：同 Server 主副 Workspace 可读写；跨 Server secondary 被 schema/service 双层拒绝。

### Phase 9：手机 Controller attachment

1. 将手机 workspace attachment 扩展为 Controller attachment。
2. 手机复用 Controller 的 Server 列表和聚合查询。
3. 打开任务后仍 attach 到 Source Server 已存在的 Host/CLI scope。
4. 保留 `web-remote-replayable` gap/snapshot 恢复。
5. 不让 relay/main 拥有任务、资源或连接目录业务状态。

退出条件：手机能看到控制端的 A/B/C；断线恢复不影响 Desktop continuous；手机不能创建独立 SSH runtime。

### Phase 10：删除旧主路径

满足所有迁移门槛后再删除：

- Desktop 生命周期绑定的远端 stdio Server 主路径。
- remote route 派生 workspace identity。
- 任何重新引入 Desktop 自动覆盖远端 Provider Registry 的兼容路径。
- prompt 附件跨机器传 `localPath` 的兼容分支。
- 每窗口本地业务 Host 作为唯一权威源的路径。

## 十四、验证矩阵

### 14.1 必测拓扑

```text
Host C: Desktop + local Server C
Docker A: SSH + Lite Server A
Docker B: Direct URL + Lite Server B
Docker J1 -> Docker J2 -> Docker A: 两层跳板
Mobile browser: attachment to C 或 A Controller
```

### 14.2 核心用例

| ID      | Setup                            | Action         | Assertions                                            |
| ------- | -------------------------------- | -------------- | ----------------------------------------------------- |
| UMS-001 | C 连接 A/B/C                     | 拉取任务       | 同路径任务按 serverId 隔离并聚合显示                  |
| UMS-002 | C 通过两个 SSH 地址连接 A        | 完成握手       | 只出现一个 Server A，历史任务不重复                   |
| UMS-003 | A 所有 UI 断开                   | 到达 cron 时间 | Server/Agent 按需运行并记录结果                       |
| UMS-004 | A 已运行 v4，C 默认 v5           | C 连接 A       | C 选择 v4 Connector，A 不重启、不降级                 |
| UMS-005 | A 无活动 Server                  | C 连接 A       | Launcher 选择兼容已安装 runtime；缺失时安装           |
| UMS-006 | SSH Workspace 超长粘贴           | 发送 Prompt    | Resource 存在于 A，Agent 可读取，C localPath 未泄漏   |
| UMS-007 | SSH Workspace 拖图片             | 发送 Prompt    | 图片 bytes/hash 正确，重试不重复采用                  |
| UMS-008 | A→B Provider 同步                | 检查 B         | 定义/API Key/headers 镜像；OAuth/UI 状态不变          |
| UMS-009 | B→A 反向同步                     | 检查 A         | 用户所选方向决定唯一 Source                           |
| UMS-010 | A/B skills 不同                  | 切换 Task      | 菜单按 Source Server 切换，不做能力并集               |
| UMS-011 | 手机附着 C                       | 浏览 A/B/C     | 列表可见；打开任务使用 replayable                     |
| UMS-012 | 手机 gap + Desktop streaming     | 恢复           | 手机 snapshot 收敛，Desktop continuous 不拼接 replay  |
| UMS-013 | Session primary/secondary 都在 A | 访问副目录     | 成功，Task 只列在 primary                             |
| UMS-014 | Session secondary 指向 B         | 保存           | schema/service 明确拒绝                               |
| UMS-015 | 旧 SSH key 含账号/IP             | 首次迁移       | 任务迁到 server-local key，无冲突自动合并             |
| UMS-016 | 克隆 A 数据目录并并发启动        | 启动第二份     | serverId lease 冲突，后启动者拒绝                     |
| UMS-017 | A 路径改名                       | 打开新路径     | 作为新 Workspace，不自动关联旧数据                    |
| UMS-018 | 两层 Jump Host                   | 连接 A         | 业务 handshake 只暴露 A serverId，不包含跳板 identity |

### 14.3 证据层

每个高风险 E2E 至少收集：

- UI：Server、Workspace、Task 可见状态。
- Protocol：bootstrap hello、capability、source server route、resource commit。
- Process：Launcher、单 Server Core、workspace Agent 数量。
- Files：server identity、workspace registry、task index、resource store。
- Network：Direct WS 或 SSH tunnel 帧，禁止记录 Secret。
- Recovery：continuous seq 与 replayable watermark/gap/snapshot。

## 十五、发布和回滚

1. 先发布新 schema 和只读 handshake，旧路径不变。
2. 再灰度 Launcher 和 persistent server，但保留 stdio compatibility connector。
3. 身份迁移使用显式 schema version、迁移日志和完成标记。
4. Resource Store 先双写/校验，再停止发送跨机 `localPath`。
5. Provider 权威切换必须有 capability gate，禁止新旧两套同时覆盖同一 runtime。
6. 每阶段提供回滚到旧 Connector 的能力，但不得降级已经升级的数据 schema。
7. 删除兼容代码前至少完成 Desktop、Browser、Mobile、SSH、WSL、Docker 的整套矩阵。

## 十六、必须保持的不变量

1. CLI 仍是 Session 正文和运行态权威。
2. Task index 不能成为 Session 内容或当前 runtime config 的权威。
3. Relay/Main 只做鉴权、配对、frame 透传和 attachment 调度。
4. Desktop continuous 与手机 replayable 保持独立。
5. `workspacePath` 只用于执行/展示；身份使用 serverId + workspaceIdentity。
6. 一个 Session 不跨 Server。
7. 一个数据根同一时间只有一个 Server Core。
8. 一个 Workspace 最多一个 Agent CLI。
9. Secret 不进入日志、任务事件、snapshot 或迁移报告。
10. 文件、模型配置、任务和能力操作始终回到对象所属 Source Server。

## 十七、完成定义

只有同时满足以下条件，统一架构才算完成：

- Desktop、Browser Web 和手机使用同一套 Server/Workspace/Session 引用。
- 本机、Direct URL、SSH、WSL、Docker 只剩 transport/bootstrap 差异。
- 每台机器每个 OS 用户只运行一个逻辑 Server。
- UI 可同时管理至少三个 Server，且状态、能力和 Secret 不串。
- 超长文本和所有外部附件都由 Source Server Resource Store 接管。
- 旧 SSH 任务在 IP/账号变化后可平滑迁移。
- 用户可定向镜像 Provider 定义，OAuth 等本地状态保持隔离。
- 手机多 Server 视图仍遵守 shared-host attachment 和 replayable 恢复。
- `pnpm typecheck`、`pnpm lint`、协议单测、Docker SSH/跳板集成测试和核心 E2E 全部通过。
