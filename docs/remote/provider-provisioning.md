# Remote Provider Provisioning

## 状态

当前实现规范。此能力只表示一次由 Desktop 发起的 Local Environment → Remote Environment
配置 Provisioning，不改变远程 Workspace 的 Provider/Model 权威边界，也不恢复历史
`workspace/updateProviderRegistry` 快照同步。Desktop 模型配置页始终绑定 Local Environment，
不提供远程配置编辑或手动同步入口。

## 目标

在 Remote Environment 上线，以及本地模型配置、默认模型、账号状态或允许同步的凭据成功
保存后，把 Local Environment 的最新完整快照自动复制到每个在线 Remote Environment。此
v0 能力不提供远程配置管理 UI；本地 Environment 是编辑权威，远端只保存可丢弃的执行镜像。

## 不变量

- 远端正式 `provider_config.json`、`model-selection.json`、`setting.json` 和 Credential Store
  仍是远端 Environment 的事实源。
- Provisioning 只写目标 Environment 的正式 Store，完成后由目标 Environment 自己重建
  Provider Config、Account Source 和 Registry。
- 不向 Remote Worker 注入完整 Registry、Runtime Model、API Key 快照或动态 Header。
- 不使用跨 Environment 的 `provider/updateAccountConfig`；该协议仍只属于远端 Host → 远端
  Worker 的进程内同步。
- Provisioning 不经过 relay，不在 Desktop Main、Renderer 或远端任务状态中持久化 Secret。
- 本地 allowlist 凭据删除会在下一次同步中删除远端同名凭据；非 allowlist 凭据不受影响。
- Desktop `continuous`、Mobile `replayable` 任务流和现有 workspace identity 路由保持不变。

## 触发与范围

### 自动触发

只对 SSH、WSL、Docker、Server remote 执行，并由成功持久化或 Environment 生命周期触发：

- 某个 Remote Environment 从零个在线连接变为至少一个在线连接；
- Personal Provider Config 保存成功；
- Configured Default 保存或清除成功；
- Provisioning Envelope 允许的账号窄设置保存成功；
- allowlist credential 保存或删除成功。

每次同步都以本地最新完整快照覆盖远端对应镜像，不检查远端是否已有配置，也不比较两端
是否相同。本地 Personal Config 为空时同样写入空值；allowlist 凭据采用 replace 语义。同步
首次连接时，只有 `applied` / `already-applied` 才能发布 Remote Workspace ready；首次返回
`failed`、`rollback_failed` 或 `unsupported` 时沿正式连接失败通道结束请求。已经发布的
Workspace 后续同步失败不拆除连接，只留下不含 Secret 的结构化 warning，并等待下一次真实
触发重新读取最新快照。

### Environment 级协调

Workspace 不是同步单位。同一 Remote Environment 的多个 Workspace、多个窗口共用 Desktop
Main 中的一条同步 lane：

```text
Workspace A ─┐
Workspace B ─┼─> Remote Environment key ─> single-flight lane ─> 一个在线 Host 执行
Workspace C ─┘
```

Main 只保存 Environment key、Host registration、trigger、generation 和请求关联信息，不读取
或转发配置与 Secret。被选中的 Window Host 在执行时重新读取最新 Local Source，并调用该
Environment 的 Remote Target。同步期间发生的新触发只推进 generation；当前轮结束后再读取
一次最新快照形成尾随同步，不为每个事件排队，也不使用固定延迟。

### Desktop 模型配置页

无论当前激活的是本地还是远程 Workspace，模型配置页都通过 Local Environment 的
`IProviderSettingsService` 读取和写入本地 Provider/Model 配置。页面不读取远端 Provider
Settings，也不显示 Local → Remote 手动同步按钮。远端配置的修改只能由远端 Environment
自身的管理入口完成；首次连接自动 Provisioning 仍遵循上面的条件与失败语义。

页面中的模型连通性测试同样属于 Local Environment。激活远程 Workspace 时，测试必须选择本地
workspace 作为 Agent cwd；没有可用本地 workspace 时返回不可用结果，不能把远程
`workspacePath`/`workspaceIdentity` 发送给 Local Host。

```text
SettingsPage
  └─ Model Provider section
       └─ ServiceProvider(localHostServices)
            └─ Local IProviderSettingsService

Active workspace (local / remote) ──仅决定工作区上下文，不改变模型配置数据源
```

### 校验边界

同步必须拒绝损坏的 JSON、未知的 Envelope 结构、allowlist 凭据的格式错误、凭据解密失败和
配置读取期间的事实变化；这些错误不能通过跳过字段或部分写入来掩盖。Personal Provider 的
运行时字段（例如 `api.baseURL`）允许以字符串暂存（包括尚未完成的值）进入 Personal Layer，但无效的 Provider
必须在 Registry 完整性校验时 fail-closed，不得阻断同一文件中其它合法 Provider 的同步或进入
可执行 Registry。非 allowlist 的 Credential 记录不属于同步事实，即使其值损坏也不应阻断
allowlist 凭据的读取；allowlist 条目本身仍必须是字符串且能够用 Source cipher 解密。

同步仍然是完整 Personal Layer 的原子替换，不静默丢弃或部分覆盖 Provider；无效 Provider
保留在目标 Personal Config 中，并通过目标 Environment 的 Provider Settings 完整性问题呈现。
Configured Default 是新会话的初始偏好，不是配置复制的成功条件。同步必须原样保留它；
Provider/Model 不存在、reasoning 缺失或失效时，由目标 Host 现有的
`resolveInitialModelSelection` 选择可用的 Registry 推荐。没有可用模型时保持无推荐，不能伪造
可执行模型。不得为此回滚已完整写入的配置，也不得清除、改写持久化默认或已有会话的选择。

```text
原行为：完整写入 → 校验默认偏好失败 → 整体回滚 → 拒绝工作区连接
现行为：完整写入 → 刷新成功 → 开放工作区 → Host 解析默认偏好或 Registry 推荐
实际 IO / 刷新失败 → 原事务回滚 → 拒绝首次连接
```

此调整只改变 Provisioning 对默认偏好的处理；Target 仍拥有事务和 Registry，Main 仍只调度。
不增加重试、超时放行或第二份状态。Desktop `desktop-continuous` 和手机
`web-remote-replayable` 继续通过同一个已就绪 Host 的可信 attachment 访问服务，stream、
snapshot、queue、owner/lease 和 `workspaceIdentity` 边界不变。

## 同步数据

### 配置

同步 Personal Layer：

- `providers`；
- `modelConfigRules`；
- `providerOrder`；
- `model-selection.json` 中的 Configured Default。

不复制 ZCode Built-in Provider/Model Release。远端继续使用自己的 Built-in Release；两端
候选集差异可能使默认偏好不可用，按上面的 Host 推荐规则处理，不把它当成配置复制失败。

### 账号连接状态

只同步账号解析需要的窄字段：

- `providerFamilyDomain`；
- `providerFamilyConnectionSelections`。

不复制整个 `setting.json`，避免覆盖远端代理、数据目录、locale、窗口和任务设置。

### 凭据

同步范围由版本化 allowlist 定义：

- `oauth:active_provider`；
- `oauth:zai:*`、`oauth:bigmodel:*` 的 access token、refresh token、user info；
- `zcodejwttoken`。

OAuth → Project Token 迁移后，`account-provider:*:api-key` 不再属于同步 allowlist。
Source 不解密或发送旧账号 Key；Target 不读取、覆盖或删除已有旧/手工 Key。
新 Source 固定输出 `schemaVersion=2`，表达只替换 OAuth allowlist 的语义；新 Target 接受 v1/v2，v1 旧 `account-provider` 条目校验后忽略，结果数量仅统计实际同步的 OAuth 条目。v2 不允许账号 Key 条目。
旧 Target 仅接受 v1，会在事务和任何 Store 写入之前拒绝 v2。Host 按现有同步失败语义报告失败，不把信封降级为 v1，也不透传旧 Key；远端已有 OAuth、Key 和配置保持不动，升级 Target 后才能同步。磁盘幂等状态版本不变。

```text
新 Source v2 → 旧 Target v1 校验拒绝 → 零写入，保留旧凭据
新 Source v2 → 新 Target → 仅替换 OAuth allowlist
旧 Source v1 → 新 Target → 忽略历史账号 Key，保留目标已有值
```

目标 Host 用同步的登录态和自己的 Key ID 缓存换 Token；短期 Token 和 ID 缓存不跨 Environment 传输。
显式手工 Provider 的 Key 仍随 Personal Config 同步。此变更不修改现有同步 lane、事务回滚或 desktop continuous/mobile replayable 边界。

不导出 SSH 密码/私钥、Bot 凭据、MCP OAuth token、插件 Secret 或其它通用 Credential key。

本地和远端的 Credential cipher 可能不同，禁止直接复制 `credentials.json` 密文。Source 端
通过 Credential Service 解密 allowlist 值，目标端通过自己的 Credential Store 重新加密落盘。
Result 与日志只记录数量、状态和非 Secret 标识，不返回或打印凭据值。

## 事务与回滚

Provisioning Envelope 包含：

- `schemaVersion`；
- `syncId`；
- source config/model/settings revision（仅用于 Source 读取一致性校验）；
- 目标端不做跨 Environment 的冲突 revision 判断；
- Personal Layer、Configured Default、账号窄设置和 allowlist 凭据。

目标端先校验整个 Envelope，再按以下顺序写入：

1. 账号窄设置；
2. 凭据（目标端重新加密）；
3. `provider_config.json`；
4. `model-selection.json`。

每个正式文件使用现有原子写和锁。目标端在事务内暂存每个 domain 的旧值/新值，任一步骤
失败时按记录反向恢复所有已写入 domain；恢复失败必须返回 `rollback_failed`，禁止报告成功。
回滚后会刷新目标内存中的 Account Source/Registry，使恢复后的事实立即生效，但不会产生
成功 Provisioning 结果。成功后目标端主动刷新 Account Source/Registry，
再由现有远端 Host → Worker account overlay 链路同步到 Agent Worker。

运行中的 Active Model 继续遵守“创建时冻结”语义；Provisioning 影响后续新建 Model/Session，
不静默改写正在执行的请求。

## 进程边界

```text
Desktop Main: Environment Coordinator（仅调度元数据）
  └─ 选择该 Environment 的一个在线 Window Host
       ↓
Window Host
  ├─ 重新读取 Local Provider Provisioning Source
  └─ Remote Target RPC（SSH/WSL/Docker/Server）
       ↓
Remote zcode-server
  ├─ Target Store 写入与回滚
  ├─ Remote ProviderRuntime refresh
  └─ Remote Host → Worker Account Config sync
```

Remote Target RPC 不复用 Renderer 的 `IProviderSettingsService` 写接口，避免把“跨 Environment
复制”和“远端本地编辑”混成一条无幂等、无回滚的路径。

## 兼容与失败语义

- Result 与 Host execution result 增加可选 `errorCode`，只接受固定枚举：
  `source-read-failed`（本地快照读取）、`target-call-failed`（远端调用抛错，含校验/预读/RPC）、
  `target-write-failed`（目标 Store 写入）、`target-refresh-failed`（账号/Registry 刷新）、
  `target-commit-failed`（幂等记录写入）、`target-apply-failed`（旧目标只返回失败状态）、
  `capability-unavailable`、`session-unavailable`、`host-execution-failed`。
  `rollback_failed` 仍单独表达回滚失败，不覆盖原失败阶段。错误码不包含路径、凭据或远端自由文本。
- 新 Host 对旧 Target 缺失或未知的错误码使用 `target-apply-failed`；旧结果仍可读取。
  不改变 Envelope 版本、成功状态或幂等文件版本，也不推断无法确认的底层故障。
  默认偏好修复需要同时发布远端 server bundle；仅更新 Host 时，旧 Target 仍执行原有严格校验。
- 首次同步失败在 reject 前记录 Environment、trigger、status、errorCode、耗时；连接面板和反馈
  同时收到带安全错误码的失败行。已有连接的后续失败仍只记录 warning。原始 `errorMessage` /
  `error` 不直接转抄到 Main 日志或 Renderer。

- 首次连接的旧远端不支持 Provisioning capability 时返回 `unsupported`，不发送 Secret，也不发布 Remote Workspace ready。
- HTTP `zcode-server` 只有在配置 `ZCODE_SERVER_AUTH_TOKEN` 后才开放受信 Desktop Host 的
  Provisioning target；未配置认证时保持“不支持”，避免把跨 Environment 凭据写入口暴露给匿名连接。
- Remote Workspace 已连接后的自动同步失败只记录结构化 warning，不拆除现有连接，也不改变本地保存成功反馈；本轮不新增 Environment 错误状态、协议、Banner 或设置页入口。这是远程配置独立管理上线前的临时过渡语义。
- 网络断开导致结果未知时，以 `syncId` 重试；目标端重复收到任意已完成 `syncId` 时返回之前结果，
  不会因后续同步覆盖幂等记录而重新应用旧 Envelope。
- Environment 离线时保留一次待同步意图，重新上线后读取最新本地状态执行；普通失败不循环
  重试，等待下一次真实触发。

## 默认偏好与首次失败诊断回归

- 聚焦测试覆盖缺失/失效 reasoning、缺失 Provider/Model、空 Registry、合法默认、写入/刷新/
  幂等提交失败与回滚，以及旧结果和未知错误码的安全处理。
- `SSH-P0-CONN-05` 通过真实 Electron → SSH → 远端 Target 验证：损坏本地同步凭据时错误和
  连接日志都显示 `source-read-failed`；恢复凭据后，保留失效默认也能进入远端目录和工作区。
  用例使用既有无账号启动 fixture，避免无关的假 OAuth 触发登录过期弹窗。
- 2026-10-09：macOS Desktop → 隔离 Ubuntu 22.04 aarch64 SSH E2E 通过，artifact
  `desktop-e2e-20261009032604472-p1453-8bb89553244ba5cc`。用例保持 pending，未进行人工晋升。
  Windows/WSL、其它远端系统与手机端 UI 未实测；未取得原反馈用户的现场输入，不据此宣称复现了
  每位用户的历史事故。回滚可还原本次提交，无持久化格式迁移。
