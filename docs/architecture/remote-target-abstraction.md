# Remote Target 抽象

## 背景

远程链路的核心实现早已不是 SSH 专属：

- `packages/server/src/remote/connect.ts` 只依赖 `IRemoteBackend`
- deploy / stdio handshake / RPC proxy 都可以复用

真正把能力绑死在 SSH 上的，曾经是 desktop → main → host 这一层入口协议：

- 共享类型使用 `SSHConnectOptions`
- 旧 remote Host init payload 使用 `sshOptions`
- host 直接在入口分支里 new `SSHBackend`

这会导致每新增一种 remote 形态（WSL、Docker），都要复制一套 `ConnectWSL` / `InitWSL` / `setupWSLConnection`。

## 本次改动

当前已经完成三步：

- Phase 0：统一连接契约，不改 deploy / handshake 主流程
- Phase 1：把 WSL / Docker backend 接到统一 target 上
- Phase 2：把平台探测和统一 remote 连接 UI 接到 desktop / web 入口

### 统一 target

共享层新增 `RemoteTarget` discriminated union：

- `kind: "ssh"`
- `kind: "wsl"`
- `kind: "docker"`

`IPlatformService.connectRemote()`、`PlatformChannels.ConnectRemote`、Main→Window Host 的
`ConnectRemoteWorkspace` payload 都统一传 `target`。R1 后 Main 只薄转发该请求，Window Host 内的
`RemoteConnectionRegistry` 持有连接复用和 logical session 生命周期。

### backend 工厂

`packages/server/src/remote/create-backend.ts` 负责把 `RemoteTarget` 转成 `IRemoteBackend`：

- SSH：读取私钥后创建 `SSHBackend`
- WSL：创建 `WSLBackend`
- Docker：创建 `DockerBackend`

这样 Window Host 的控制层不再关心具体 transport，只负责：

1. 收到 `ConnectRemoteWorkspace { requestId, target }`
2. 调 `createRemoteBackend(target)`
3. 交给 `connectRemote()`
4. 分配 `remoteSessionId` 并暴露严格校验 identity/path 的 scoped attachment

### 平台探测与统一 UI

`IPlatformService` 新增三类宿主能力：

- `isDockerAvailable()`
- `listWSLDistros()`
- `listDockerContainers()`

Desktop 通过 main process 动态调用 `@zcode/server/remote` 的探测函数，Web 侧保持空实现。

UI 入口不再继续拆 `SSHDialog` / `WSLDialog` / `DockerDialog`，而是统一成一个 remote 连接弹窗：

- 始终展示 SSH
- 仅 Windows desktop 展示 WSL
- 仅在本机 Docker daemon 可用时展示 Docker

这样新增 transport 时，入口层只需要补：

1. shared target 类型
2. backend factory 分支
3. 平台探测能力
4. 统一弹窗里的一个 mode

## 结果

- SSH 现有路径继续可用
- WSL 已能复用同一条 deploy / handshake / RPC 链路，不需要新增 host/main 协议
- Docker 已能复用同一条 deploy / handshake / RPC 链路，不需要新增 host/main 协议
- remote 入口命名不再和具体 transport 绑定

## 当前状态

- `kind: "ssh"`：已可用
- `kind: "wsl"`：已可用，优先通过 `\\wsl.localhost\` / `\\wsl$\` 走文件直拷；不可用时回退到 shell 流式上传
- `kind: "docker"`：已可用，通过 `docker exec` + stdin 流式写入直连本机容器；上传文件由容器当前用户创建，避免后续替换时出现所有权不匹配
- desktop UI：已可从统一 remote 弹窗选择 SSH / WSL / Docker
- web UI：只保留 SSH；WSL / Docker 探测能力为空实现，不展示对应入口

## 后续建议

1. 保留并验证 “Docker via SSH” 不回归
2. 给 remote 弹窗补充更细的 e2e 覆盖（WSL/Docker tab 切换、容器选择）
3. 视需要补充更多 backend capability（例如 Docker all containers / WSL 默认 distro metadata）
