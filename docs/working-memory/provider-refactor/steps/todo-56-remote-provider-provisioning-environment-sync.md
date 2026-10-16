# Todo 56：Remote Provider Provisioning 的 Environment 级自动同步

> 状态：已完成
>
> 日期：2026-09-01
>
> 前置：先合并 `origin/provider-refactor-m2` 的 Remote Provider Provisioning 基线，再完整实施 Todo 55；本 Todo 只在 Provider Template、最终 Personal Provider Config 与收窄后的 Account Family 契约稳定后接入自动同步，不接受远端旧基线对这些内容的回退。

## 0. 目标

Remote Provider Provisioning 是远程模型配置产品尚未完整上线前的 v0 临时同步机制。本轮不建设远程配置管理 UI，也不让远端成为配置编辑权威；只把本地 Environment 的当前模型调用配置可靠地复制到每个在线 Remote Environment。

```text
Local Environment（v0 管理权威）
├─ Personal Provider Config
├─ Personal Model Config Rules
├─ Provider / Model order
├─ Configured Default
├─ Account Family 窄设置
└─ Provisioning allowlist credentials
              |
              | Environment 级自动 Provisioning
              v
Remote Environment（可丢弃的执行镜像）
├─ 正式 Store 原子落盘
├─ Account Source / Registry refresh
└─ 后续新建 Model 使用新事实
```

Remote Provisioning 不同步 Built-in Release，不注入 Registry Snapshot，不改写已经创建的 Active Model，也不改变 Desktop `continuous`、Mobile `replayable`、任务队列或恢复语义。

## 1. 合并基线

### 1.1 合并顺序

1. 更新远端引用并确认工作区没有未识别的用户改动；
2. 合并 `origin/provider-refactor-m2`，不用 rebase 重写当前分支历史；
3. 按当前已裁决语义解决冲突；
4. 先运行 Provisioning、Provider、Settings 和 E2E typecheck 的合并基线验证；
5. 基线成立后再实施本 Todo，不能把合并故障与同步设计改动混在一起定位。

### 1.2 冲突裁决

远端分支包含有效的 Provisioning Source、Target、事务、RPC 和 Host 接入实现，但它基于较旧文档与 E2E 状态。合并时必须：

- 保留当前 `todo-55-provider-template-inheritance-cutover.md`；
- 保留当前已经恢复的 Z.ai / BigModel Family 与结构化 Connection Selection E2E；
- 保留当前 Model Option Map、辅助模型最低 reasoning 等较新裁决；
- 接收 Remote Provisioning 的 Source、Target、Envelope、Target 事务与远端能力接入；
- 不机械接受“Family Case 已失去产品对象”或删除当前正式 Family Case 的旧结论；
- 对同一文件的冲突逐项按当前 Design 解决，不能以 ours/theirs 整文件覆盖。

## 2. v0 同步语义

### 2.1 每次同步都是本地完整快照覆盖

同步内容：

- 完整 Personal Provider Config：`providers`、`modelConfigRules`、`providerOrder`；
- Configured Default；
- `providerFamilyDomain` 与 `providerFamilyConnectionSelections`；
- Provisioning allowlist 内的完整凭据集合。

同步规则：

- 不检查远端是否已有配置；
- 不比较远端内容是否与本地相同；
- 本地为空也必须同步，从而能够清空远端对应镜像；
- Personal Config、Configured Default 与账号窄设置采用本地值覆盖；
- allowlist 凭据采用 replace-allowlist 语义：本地存在的写入，本地已删除的同类远端凭据删除，非 allowlist 远端凭据不动；
- 目标继续使用现有原子写、Target 锁、事务回滚、`syncId` 幂等和 Registry refresh；
- 本地配置不完整可以被保存和同步，但目标 Registry 仍按正式完整性规则隔离不可执行 Provider/Model。

因此删除：

- `onlyIfMissing`；
- `personalConfigExists` 预检与“远端已有配置则跳过”；
- 远端内容相等判断；
- 手动“同步本地到远端”按钮、确认弹窗和对应 Renderer 状态；
- “本地登出不撤销远端凭据”的旧语义。

### 2.2 触发点

只从成功持久化或 Environment 生命周期事件触发，不在 UI 中重新定义“哪些字段算 Provider 变化”。

```text
Personal Provider Config save 成功 ─┐
Configured Default save/clear 成功 ─┤
Account 窄设置 save 成功 ───────────┤
allowlist credential save/delete 成功 ┤
Remote Environment offline -> online ─┤
                                      v
                         Environment Sync Coordinator
```

具体边界：

- Provider Config 监听 Repository/Service 的成功变更事件，只响应 Personal Config，不响应 Built-in Release 后台刷新；
- Configured Default 监听正式 Model Selection Config Repository 的 save/clear；
- Account 设置监听正式 Setting Service 的成功更新，但 Source 仍只取 Envelope 中允许的窄字段；
- Credential Service 增加 Host 私有的成功 save/delete 通知，Source 按既有 allowlist 过滤；不新增 Renderer Credential API；
- Remote Workspace attach 只有在所属 Remote Environment 从零个在线连接变成至少一个在线连接时触发；同一 Environment 再打开 Workspace 不重复触发；
- 保存失败、取消编辑、输入中的未持久草稿和无关设置变化不触发。

## 3. Environment 是唯一同步单位

Workspace 不是同步对象。同一 Remote Environment 的多个 Workspace 共用一个同步通道。

```text
Workspace A ─┐
Workspace B ─┼─> Remote Environment Key ─> 一条同步 Lane ─> Remote Target
Workspace C ─┘
```

Environment Key 必须来自现有远端连接身份：

- SSH：现有规范化 SSH host/connection key；
- WSL：distro + user 的现有连接 key；
- Docker：container identity；
- Server：server identity 或规范化 endpoint identity。

禁止使用 `workspacePath`、`workspaceIdentity` 或 `remoteSessionId` 作为 Provisioning 去重 key；它们分别表达路径、Workspace 隔离和单次 Session，不等于 Environment。

## 4. Application 级 Coordinator

每个 BrowserWindow 有自己的 Local Host，仅把协调器放在 Window Host 无法保证多个窗口连接同一 Environment 时只同步一次。本轮采用 Main 调度、Host 执行：Main 只管理调度元数据，不接触 Config 或 Secret，符合 Main 只做调度的边界。

```text
Window Host A ─ register(env, target) ─┐
Window Host B ─ register(env, target) ─┤
Provider/Account/Credential trigger ──┤
                                      v
Desktop Main: Environment Coordinator
├─ env -> online Host/Target registrations
├─ env -> single-flight state
├─ env -> dirty generation
└─ 选择一个在线 Host 执行
                                      |
                                      v
Selected Window Host
├─ 重新读取最新 Local Source
└─ 调用该 Environment 的 Remote Target
```

Main 内部协议只携带：

- Environment Key；
- Host registration identity；
- trigger reason；
- execution/result correlation id。

不得携带 API Key、OAuth token、完整 Config、Registry Snapshot 或请求期凭据。执行 Host 在收到调度后重新读取最新本地事实并生成 Envelope。

### 4.1 注册与生命周期

- 某 Environment 的全局在线注册从 `0 -> 1` 时请求一次同步；
- 同 Environment 新增 Workspace 或第二个窗口注册只增加引用，不触发第二次连接同步；
- 注册从 `1 -> 0` 时标记离线；以后重新从 `0 -> 1` 时再次同步；
- 执行 Host 在任务中途退出时，Main 从该 Environment 其它在线 Host 中重新选择执行者；没有在线 Target 时保留一次 pending intent，下一次注册后执行；
- 不把 Coordinator 状态持久化为新的配置事实。应用重启后由在线注册重新建立状态并同步。

### 4.2 Single-flight + trailing refresh

同一 Environment 同时最多一个同步。同步期间出现任意新触发，不并发发送，也不能静默丢弃。

```text
generation = 1，开始读取 S1 并同步
        |
        +-- 同步中 Provider save，generation = 2
        +-- 同步中登录变化，generation = 3
        |
        v
S1 同步结束
        |
        +-- observed(1) != current(3)
        v
重新读取一次最新 S3 并同步
        |
        +-- 期间无新触发
        v
Lane idle
```

实现要求：

- 以单调 generation/dirty 标记表达尾随刷新，不堆积每个事件；
- 每轮执行前重新读取 Source，不能复用触发时的旧 Envelope；
- 当前轮成功或失败后，只要 generation 变化都再执行最新一轮；
- 当前轮失败且没有新触发时停止自动重试，等待下一次保存、账号变化或重连；
- 调用方等待整条 drain 完成，而不是只等待第一轮；
- 不使用固定 sleep 或额外 debounce。输入框保存本身已有 debounce，Coordinator 只负责并发合并和不丢尾随状态。

## 5. 连接与失败语义

首次 Environment 连接保持远端分支已有原则：Target capability 就绪后尝试 Provisioning，再发布可执行的 Remote Workspace；Provisioning 失败或旧远端不支持时不阻断连接，但必须记录明确 warning。后台保存触发的同步不阻断本地保存成功反馈。

```text
Remote transport ready
        |
        v
Environment register + 首次同步 attempt
        |
        +-- success/unsupported/failure 均形成明确结果
        v
Remote Workspace ready
```

- `unsupported` 表示旧远端没有 Target capability，不发送 Secret；
- 网络未知结果继续使用 `syncId` 重试幂等；
- Target 回滚失败仍报告 `rollback_failed`；
- 日志按 Environment Key、trigger、syncId、耗时和结果记录，不打印 Secret；
- 高频调度细节用 `debug`，连接期失败和不可恢复事务错误使用 `warn/error`。

## 6. 实施切片

1. 合并远端基线并按 1.2 解决语义冲突；
2. 完成 Todo 55，确认 Provisioning Envelope 能承载最终 Personal Provider Config，Account Settings 不再接受 Family `api-key` variant；
3. 更新 Provisioning Envelope/Target 为完整覆盖和 replace-allowlist credential 语义；
4. 删除 `onlyIfMissing`、远端存在预检和手动同步 Renderer/UI；
5. 在 Desktop Main 增加 Environment Coordinator 与 Host 内部调度协议；
6. 将 SSH、WSL、Docker、Server 的连接注册统一投影成 Environment Key；
7. 接入 Personal Config、Configured Default、Account Setting、Credential 和 online 生命周期触发；
8. 删除 facade 级、Workspace 级的重复 in-flight/同步状态；
9. 更新 `docs/remote/provider-provisioning.md`、远程架构文档、Feature Graph 和测试矩阵；
10. 完成自动化验证后提交 Conventional Commit。

## 7. 自动化证明

### 7.1 Coordinator 单测

- 同一 SSH Environment 打开多个 Workspace 只触发一次首次同步；
- 同一 Environment 跨两个 Window Host 注册仍只触发一次；
- 不同 Environment 各同步一次；
- 同步中连续发生多次 save/login/default 变化，只执行当前轮和最新尾随轮；
- 尾随轮读取最新 Source，不发送触发时快照；
- 执行 Host 退出后由另一在线 Host 接管；
- 最后一个 Target 离线后不发送，重新上线触发一次；
- 失败不无限重试，下一次正式触发可以恢复。

### 7.2 Source/Target 单测

- Personal Config、Configured Default、账号窄设置和 allowlist credential 的成功写入触发；
- failed save、无关 Setting、Built-in refresh 不触发；
- 空 Personal Config 能清空远端对应 Personal Layer；
- 本地登出/删除能删除远端 allowlist 中对应凭据；
- 非 allowlist 远端凭据保持不变；
- Target 任一步骤失败完整回滚；
- 成功后刷新 Account Source/Registry，已有 Active Model 保持冻结。

### 7.3 集成与回归

- 首次远端连接在同步 attempt 结束后发布 Workspace ready；
- Provisioning 不支持或失败不阻断远端连接；
- Desktop continuous 与 Mobile replayable 不改变；
- SSH、WSL、Docker、Server 至少各有 Environment Key/注册测试；
- Provider 设置页不再出现主动同步按钮和远端同步状态；
- Renderer、RPC 返回和日志不泄露 Secret。

## 8. 完成门禁

- 每个在线 Remote Environment 对一次触发最多形成一条 single-flight lane，与 Workspace 数量无关；
- 同步期间的新变化不会丢失，最终远端得到最新本地快照；
- 本地空配置和凭据删除能够传播；
- 所有触发来自成功持久化/生命周期边界，不靠 UI 字段枚举；
- Main 只调度，不持有或传输 Secret；
- 旧手动、`onlyIfMissing`、Workspace 级重复同步和 Renderer Provisioning 入口归零；
- 定向单测、`pnpm typecheck`、`pnpm lint` 通过；
- 进入 Todo 57 前先提交本 Todo 的实现，便于 E2E 定位基线。

## 9. 非目标

- 远程管理登录状态和模型配置的 v1 UI；
- 双向同步、冲突合并或远端编辑回传；
- 同步 Built-in Release；
- 优化 Provisioning Source 临时直接读取 Credential Store 物理文件的实现；
- 再次修改 Todo 55 已经稳定的 Provider Template、Provider Family 或 Personal Config 产品语义；
- 重构 Remote Workspace、任务流、owner/lease 或 replayable 恢复语义。

## 10. 实施记录

本轮已完成：

- 将 Provisioning 收口为 Desktop Main 的 Remote Environment 级 Coordinator；同一 Environment 跨 Workspace、跨窗口只保留一条 lane；
- 实现 single-flight、generation 尾随刷新、Host 退出接管、离线 pending 与重新上线同步；
- Host 只在 Main 调度后现读本地 Source，Main 协议不传 Config 或 Secret；
- Personal Config、Configured Default、账号窄设置与 allowlist Credential 在成功持久化后触发所有在线 Environment；
- Target 改为完整快照覆盖，空 Personal Config、空默认模型和凭据删除均能传播；
- 删除 Renderer 手动同步入口、Workspace 级同步状态、远端存在预检和 `onlyIfMissing`；
- 更新远端部署、Provisioning 与 Environment 当前事实文档。

验证证据：

- Provisioning、Remote Session、Service Trigger、协议与 UI 残留的 12 个定向测试文件共 102 条测试通过；
- 全量 unit：12782 条通过，25 条既有 skipped；
- 根 `pnpm typecheck` 通过；
- 根 `pnpm lint` 通过（仅保留仓库既有 warning）；
- `git diff --check` 通过，旧 Renderer/Workspace Provisioning 抽象和 preflight 入口扫描归零。

Todo 57 追加了正式 SSH 生命周期断言：首个 Workspace 连接后读取远端
`provider-provisioning-state.json` 的 `records[]`，再打开同一 SSH Environment 的第二个 Workspace，并证明记录数不再增加。
该 Case 已通过 E2E typecheck；当前 MacBook Pro 没有配置真实 SSH E2E 凭据，因此实际 WDIO 结果严格记录为
`blocked-environment`，Environment Coordinator 的 single-flight、尾随刷新和跨 Workspace 合并继续由本 Todo 的定向单元/集成测试覆盖。

> 后续裁决：本 Todo 中“Provisioning 不支持或失败不阻断远端连接”的首次连接语义已由 Todo 59 取代。当前事实是首次同步只有 `applied` / `already-applied` 才发布 Remote Workspace；已经连接后的同步失败仍保持 Workspace 在线，并且过渡期只记录结构化日志。
