# 远程工作区投影与持久化兼容

当前规格。远程无项目聊天 UI 已停用；项目入口、目录选择、断线与导航恢复由
[项目导航规格](../remote/project-first-remote-navigation-spec.md)定义。
本文保留兼容读取和持久化约束，不再包含 connect-and-chat 设计或已完成的实施阶段。
原方案、RCONV 场景和评审依据可用 `git show a17a875588b8d66c2bee49236292e174df651363:docs/architecture/remote-domain-simplification-and-conversation-workspace-spec.md` 查询。

## 领域与状态归属

- Source 身份、Profile、canonical key 与迁移以 [R3 主规格](r3-source-server-remote-architecture.md) §3、§9 为准。
- 设备物理连接属于 Window Host 的 Manager；workspace attachment 属于 Registry。设备 online 不等于项目 ready。
- UI 的只读 join 由 `RemoteWorkspaceProjection` 提供；展示五态见 [UX 规格](remote-device-connection-ux-spec.md)。
- `openWorkspaces` 只包含远程 workspace；`executionContexts` 可包含本地与远程。不能给本地 tab 注入 Source 字段。
- workspace key 使用 `workspaceIdentity?.trim() || workspacePath`；path 用于 I/O，名称和连接方式不参与身份判等。
- Settings、Dialog、Sidebar 复用同一 join，只按 surface 过滤，不各自计算 Source/attachment readiness。
- command/controller 复用既有 Service/Manager/Registry；当前项目连接意图见导航规格，不恢复旧 `open-conversation` UI。
- Main/relay 不持有 task/session/stream 真相；桌面 continuous、手机 replayable 保持各自恢复边界。

```text
Source Directory + Host Manager/Registry + TabStore
  → RemoteWorkspaceProjection → 设置 / 向导 / 项目导航
显式用户动作 → 既有 Controller → Host 权威服务
```

## 导航选择与兼容投影

- 新版只恢复与写回 `lastActiveWorkspace`，清空使用 null；项目/连接成员归 Host SQLite。
- `lastWorkspaceSession`、`recentProjects`、`lastActiveTabIndex` 是 Host 从已提交成员派生的降级兼容投影，不能作为新版冷启动 open set。
- 只有缺少 `lastActiveWorkspace` 的旧设置导入才读取旧列表；旧版 active-first 的延后补齐仍需防止关闭后复活、失败恢复覆盖持久化。
- 当前 Renderer 的 live/断连 tabs 是运行时导航缓存。Source 上线只挂回当前已有 tabs；不从旧兼容字段重新创建所有目录的 attachment。
- 显式关闭只释放该窗口 attachment，不删除设备、Profile、项目成员、backing directory 或远端 task，不隐式断开整个设备。
- 历史快照中的 credential 引用不转移所有权。历史更新、容量裁剪和移除只能产生 `remote-workspace:` 自有凭据的清理意图；`connection-profile:` 凭据由 Source Directory 管理，即使重投影移除了引用也不得删除。
- legacy 回退凭据在 rekey/恢复时保留；显式关闭只允许清理独占且未被其他 owner 引用的旧凭据。
- 当前持久化事实源是[虚拟项目 F5](../superpowers/specs/2026-09-09-virtual-project-design.md)，设备与窗口恢复见 [Renderer 重挂](../remote/desktop-remote-session-renderer-reattach.md)。

## 5. 持久化设计

### 5.1 近期兼容方案

保留 `lastWorkspaceSession` 作为 Host 派生的降级兼容投影：

- remote entry 增加 `workspacePurpose?: WorkspacePurpose`，缺省为 `project`；
- 新版恢复只读 `lastActiveWorkspace`；旧字段不反向覆盖 Host 项目入口，Renderer 与 Web/Mobile 不写该成员投影；
- `sourceServerWorkspaceHistory` 只表示 known **project** history；
- 历史 conversation backing workspace 数据保留，但远程 conversation entry 不再进入 UI 导航或自动恢复；
- target/credential 仍保留旧字段以兼容旧版本，新的 controller 优先通过 Profile 解析。

`lastWorkspaceSession` 的 entry schema 是非 strict object，旧版本会剥离未知的 optional purpose，
因此该字段可安全演进；旧版本读到缺 purpose 的 remote entry 时仍按 `project`。

### 5.2 Source history 规则

`SourceServerWorkspaceHistoryEntry` **不增加** `workspacePurpose`。现有 schema 是 `.strict()`，
若新版本写入新字段，回退旧版本时单条 history 校验失败会使整份 AppSettings 降级为默认值；
旧版本后续任意 settings update 都可能据此覆盖原设置。

- project：继续写入 `sourceServerWorkspaceHistory`，可出现在最近项目、项目数量和项目选择器；
- conversation：禁止调用普通 `recordWorkspaceOpen` 写入 project history。

AppSettings 顶层字段保存每个设备已解析的 canonical conversation path，作为保留的兼容数据：

```ts
interface RemoteConversationWorkspaceRecord {
  workspacePath: string;
  lastResolvedAt: number;
}

interface AppSettings {
  remoteConversationWorkspaceBySourceServerId?: Record<
    string, // sourceServerId
    RemoteConversationWorkspaceRecord
  >;
}
```

该字段必须位于非 strict 的 AppSettings 顶层；旧版本安全忽略整个未知字段，不得把它嵌入
`SourceServerRecord`、`ConnectionProfile` 或 `SourceServerWorkspaceHistoryEntry` 等 strict schema。
使用该记录时，`workspacePath` 只用于远端 IO/展示；`workspaceIdentity` 必须继续通过统一的
`buildServerRemoteWorkspaceIdentity({ sourceServerId, workspacePath })` 派生，不能把 map key 或路径后缀当作 identity。
旧版本一旦写回 settings，可能丢弃这个新字段；新版本再次连接 Source 后必须能幂等重建，
不能把它当作远端数据权威或不可恢复记录。设备被显式删除时清理对应 map entry；单纯 disconnect 不清理。

不允许通过 `.zcode/workspace/default` 等路径前缀猜 purpose。

### 5.3 长期 R4 简化

当旧版本回退窗口结束后，再把 open set 收敛为引用型结构：

```text
openWorkspaceSet:
  ordered workspaceKey[]
  activeWorkspaceKey
  per-key purpose
```

设备、线路、known workspace 和 runtime target 不再重复嵌入 open set；由 Source Directory + Profile 解析。
本次实现不做破坏性替换，只先建立兼容 adapter。

## 历史 conversation 兼容与剩余迁移

- purpose 缺失默认 `project`；只有 Source canonical 记录与路径精确匹配才允许纠正历史 purpose，不按目录前缀猜测。
- UI 停用不删除底层能力、canonical path map、远端会话或任务数据；不再从历史 conversation open entry 自动恢复 UI。
- R4 reference-oriented open set、target/credential 重复字段清理仍待回退窗口结束，保留旧 reader，不能随文档整理实施。
- 空闲 Source 的 idle TTL 仍为未决产品事项，见 R3-ISSUE-026。

## 验收边界

保留 RCONV-08/12/13/14/15 的 active-first、显式关闭、rekey、部分加载写回及非 owner/失败恢复保护；
RCONV-01–05 等旧 connect-and-chat UI 场景是历史合同，不再用于新产品验收。
身份和多窗口隔离仍由 R3 回归覆盖，稳定 ID 与证据见
[case 目录](../conversation-session-case-catalog.md)及[覆盖矩阵](../testing/conversation-session-e2e-coverage-matrix.md)。
文档整理没有补跑或提升任何测试状态。
