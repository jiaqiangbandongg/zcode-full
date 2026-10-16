# v4 多 pane 跨 workspace 工作台（分屏二期）

状态：**已实现，2026-07-17 再次确认产品边界**。Task 列表拖拽 session 到
对话区边缘仍会创建/恢复 workbench group；2026-07-13 仅临时下线 pane chrome
的“向右拆分 / 向下拆分”显式按钮。

## 目标

把 M5⑤ 的「同 workspace 1+1 左右分屏」升级为「N pane 工作台」：

- 布局从单值 `splitPane` 升级为**二叉分割树**（VS Code editor groups 模型）：任意 pane 可向右/向下拆分，嵌套即得 2x2 等网格。叶子上限 `MAX_WORKBENCH_PANES = 4`（对齐 06-ui 性能验收基线「4 pane 同时流式不掉帧」；同时是 host 内 CLI 子进程数的软上限）。
- pane 绑定升级为 `(workspaceScope, sessionId)`：pane 自带 workspace 归属，**不再限制同 workspace**；本地与远程（SSH/WSL/Docker）workspace 任意组合。
- 连接层新增 `workspaceConnectionRegistry`：按 `endpointKey + workspaceKey` 引用计数复用 `transport + SessionDataLayer`（与 `sessionsIndexRegistry` 同构，多一层 30s keep-warm）。
- primary pane（`workspace-main`）保持 shell 驱动（绑 `activeTaskId`，随 workspace tab 切换）；其余 pane 归 `paneLayoutStore` 自管、**跨 tab 常驻**——tabStore 及其 ~46 个 `activeTabId` 消费者零改动。

## 连接拓扑

```text
window renderer                          host / 远程 host                  CLI 进程
  pane(A/s1) ─┐
  pane(A/s2) ─┼─ workspaceConnectionRegistry
  pane(B/s3) ─┘   Map<endpointKey+workspaceKey,
  pane(R/s4) ─┐       { transport, SessionDataLayer, refCount, keepWarm }>
              │        │
              │        ├─ 本地 scope ──→ base services.zcodeAgentService ──→ base local host
              │        │                   └─ processesByWorkspaceKey ┬─→ agent(A)  conversation/s1,s2
              │        │                      （每 workspace 一个 CLI）└─→ agent(B)  conversation/s3
              │        └─ 远程 scope ──→ sessionsById[remoteSessionId].services ──→ remote host ──→ agent(R)  conversation/s4
              └─ 远程连接不在场 → 断连代理（rejects）→ pane 进 error/等待连接态，不另起 runtime
```

要点：

- conversation topic 只含 sessionId（`conversationTopic`），workspace 隔离靠 host 按 workspaceKey 分桶到独立 CLI 进程 + 下行帧按 workspaceKey emitter 过滤——协议面**零 schema 改动**即支持同窗口并发订阅 N 个 workspace。
- 同 workspaceKey + endpointKey 的多个 pane 共享一条 transport + 一个 SessionDataLayer（同 session 多 pane 靠 layer 内 refCount 单订阅收口，不触发 CLI `(connectionId, topic)` 重订阅替换）。
- 远程 pane 的 services 复用 `remoteWorkspaceSessionStore.sessionsById`（既有多连接 Map）；远程连接断开时 `useWorkspaceServices` 给出断连代理（所有 RPC reject），订阅失败落在投影 store 的 error 态 → pane 显示重连/等待占位。**禁止**为 pane 另起独立 SSH/runtime（远控保护约束）。

## Layout 层：二叉分割树（paneLayoutStore v2）

```text
LayoutNode = Leaf { paneId }
           | Split { id, direction: "row"|"column", ratio, first, second }

ratio = first 占比，clamp [0.25, 0.75]（沿用一期 splitRatio 语义，每个 Split 节点独立一份）

单 pane:          leaf(main)
左右分屏:         split(row){ leaf(main), leaf(pane-1) }
2x2 网格:         split(row){ split(col){ leaf(main), leaf(pane-2) },
                              split(col){ leaf(pane-1), leaf(pane-3) } }
```

- 状态：`{ root: LayoutNode, panes: Record<paneId, PaneBinding>, focusedPaneId }`；primary pane（`workspace-main`）是保留叶子——**不进 `panes`**，绑定沿用 shell props（activeTaskId）。
- `PaneBinding = { workspaceScope, sessionId | null, restoredUnvalidated? }`；
  `workspaceScope = { workspacePath, workspaceIdentity?, remoteSessionId? }`。
- **`workspaceScope` 语义 = session 归属的主（primary）workspace，是连接路由键**；不是「session 能触达的全部路径」（见下文跨 workspace session 兼容）。
- workspaceKey 口径统一 `workspaceIdentity?.trim() || workspacePath`（Workspace Identity 约束）。
- 转移函数全部纯函数、no-op 返回原引用：`splitPaneAt`（叶子数达上限 no-op）、`closePane`（primary 不可关；父 Split 塌缩为兄弟节点）、`bindPaneSession`、`setSplitNodeRatio`、`focusPane`、`confirmRestoredPaneSession`。
- Focus 层不变：`focusedPaneId` 单值；焦点 pane 不在树中时退化为 primary。全局快捷键（Esc stop、add-to-chat）路由到 focused pane（06-ui 分屏规则 4）。
- 一期的「split 属于别的 workspace 时不渲染」规则**删除**——pane 自带 workspace，永远渲染、跨 tab 常驻。

### 持久化 v2 与迁移

- key `zcode-v4-pane-layout:v2`：整树 + `panes` 绑定（scope + sessionId）+ `focusedPaneId`。`restoredUnvalidated` 不持久化，恢复时对非空 sessionId 补标。
- 兼容读取 v1（`zcode-v4-pane-layout:v1` 单值 splitPane）：v1 只存了 `workspaceKey`，仅当它是可信本地路径（`/...` 或 `X:\...`）时迁移为 `split(row){ main, split }`（scope.workspacePath = workspaceKey），否则丢弃回单 pane。损坏数据整体丢弃回初始布局（沿用一期 sanitize 哲学，不做部分救回）。

## 连接层：workspaceConnectionRegistry

- 模块级注册表（与 `sessionsIndexRegistry` 同构）：key = `endpointKey(remoteSessionId ?? "__base__") + workspaceKey`。
- `acquireWorkspaceConnection(scope, agentService)` → `{ layer, transport, release }`；首个引用创建 `createAgentConversationTransport + SessionDataLayer`，refCount 归零后 **30s keep-warm** 再 dispose（防 pane 关/开、布局拖拽抖动）。
- 条目记住创建它的 `agentService` 引用：同 key 再次 acquire 时若 service 引用变化（远程断连→重连后 services 换新），旧条目立即失效移出注册表（存量租约继续持有直至 release），新条目用新 service 重建——重连恢复不需要手动刷新。
- services 解析归 React 层（`V4PaneConversationProvider` 内 `useWorkspaceServices(path, remoteSessionId, identity)`）：远程目标断连时得到断连代理，订阅失败 → pane error 态 + 重试按钮；**不回落 base services**（避免远程 task 被本机 host 查询）。

## per-pane Provider

- `V4PaneConversationProvider({ scope, isShellWorkspace, children })`：per-pane 包裹。
  - `isShellWorkspace = pane scope 的 workspaceKey === shell 当前 workspace`：成立时直接用上下文 services（与一期行为逐字节一致，web 宽屏远控 shell 也走这条），否则经 `useWorkspaceServices` 按 scope 解析（跨 workspace pane 仅桌面入口可创建）。
  - 内层包 `ServiceProvider services={paneServices}`：pane 子树的附件上传、sessions-index 守卫等 hook 用 pane 自己的 accessor。
  - context 形状不变（`{ layer, sendCommand, attachmentPut }`），`SessionPane` 零感知。
- 手机 `/remote` 的 `V4ChatPane`（单 pane，无分屏）继续用原 `V4ConversationProvider`（per-workspace 直建），远控 replayable 链路不动。

## 恢复守卫（per-pane 泛化）

```text
恢复时序（每个 restoredUnvalidated pane 独立）：

localStorage ─→ paneLayoutStore(v2 恢复, 补 restoredUnvalidated)
                    │
V4PaneWorkbench ────┼─→ pane 渲染（先渲染，不阻塞）
                    └─→ PaneRestoredGuard(pane scope)
                          acquireSessionsIndex({ workspaceKey, endpointKey: remoteSessionId })
                          等首个真 snapshot（workspaceId !== null）
                            ├─ session 在场 → confirmRestoredPaneSession(paneId)
                            ├─ session 已删 → closePane(paneId)
                            └─ 订阅失败/远程 endpoint 不在场 → 不判定，pane 保留为
                               error/等待连接态（交由 pane 自身 retry 兜底，不误关）
```

对数据层的契约：**session 会且只会出现在其主 workspace 的 sessions-index 里**——守卫按 pane 的主 workspace scope 查找即完备（跨 workspace session 落地后仍然成立）。

## 入口

- 拖拽、侧栏会话项「在分屏打开」和普通 session 点击统一进入 `workbenchSessionPlacement`：纯 resolver 决定 current guard、focus existing、split draft、create/extend group 或 replace focused pane，executor 再按“pane/group owner 先更新，shell active 后同步”的顺序提交。拖拽只接受实际 split decision 并传入命中的 side/anchor；右键默认向右且允许 focus existing；普通点击使用 selection intent。task 项携带完整的 workspacePath/workspaceIdentity/remoteSessionId，跨 workspace 判等使用 workspaceKey。入口闸门 `V4SplitPaneEntryProvider`（桌面 shell 且非远控）语义不变。
- pane chrome（2026-07-08 裁决）：不再渲染占布局高度的横向 header 条。拆分入口「向右拆分 / 向下拆分」（draft，绑当前 pane 的 workspaceScope）和「关闭 pane」（primary 无关闭）统一放在 pane 右上角悬浮操作组里，避免挤占对话内容首行。非 primary 且 workspace ≠ shell 当前 workspace 时，workspace 名徽标进入同一悬浮组左侧（远程加主机标识）。徽标是纯展示位，未来跨 workspace session 的「A +2」多路径徽标在此扩展。
- **临时下线（2026-07-13）**：对话区域 pane chrome 暂不展示「向右拆分 / 向下拆分」两个按钮；保留底层二叉布局、拆分回调接口、关闭 pane、workspace 徽标及侧栏「在分屏打开」入口，后续恢复 chrome 入口时无需迁移状态或协议。

## 与「跨 workspace session」的兼容（未来输入，本期预埋）

未来的跨 workspace session = 一个主 workspace + 多个辅助路径（agent 可操作的额外目录），主/辅同 endpoint，关系记录在数据层。本期钉死四条：

1. `PaneBinding.workspaceScope` 语义固定为 **primary workspace**（连接路由键）；辅助路径是 session 属性（经 projection/sessions-index 下发），不进布局层——届时 `paneLayoutStore` 零 schema 变更。
2. 连接注册表按主 workspace 路由（跨 workspace session 仍是单 agent 单连接）；不留「多 workspace 连接聚合」的 API 口子。
3. workspaceKey 判等只用于归属/隔离，绝不用于「路径能力」推导；辅助路径的 UI 呈现是纯展示增量。
4. 主/辅同 endpoint 约束由创建入口保证；pane 工作台不做跨 endpoint 聚合假设。

协议扩展路径（届时 additive，不改既有字段）：`createSession` payload 加 `auxiliaryPaths?`；sessions-index item 透出主/辅关系。

## 协议面备忘（本期结论）

- **零 schema 改动**。已补的实现缺口：CLI `v4-bridge.createSessionRecord` 的 `workspaceId` 从「一律当本地 workspacePath」升级为经远程 identity 对偶解析（`buildRemoteWorkspaceIdentity` 家族，不手写拼接）——远程 pane 里 draft 首发建会话的前置。
- `visibility: foreground/background` 订阅字段协议已预留、CLI 未消费；4 pane 同时流式若实测掉帧，再做 CLI flush 按 visibility 分级（additive）。
- conversation subscribe 无 `subscriberScope`（host 进程级单 connectionId + 每 topic 单订阅已收口）；仅当未来出现「同 session 多个独立订阅消费者」需要参照 sessions-index 增补。

## 实施改动面清单（按落地顺序）

| # | 触点 | 改动 |
| --- | --- | --- |
| 1 | `packages/ui/src/v4/paneLayoutStore.ts` | 重写为 v2：二叉分割树 + `panes: Record<paneId, PaneBinding>` + 持久化 v2（`zcode-v4-pane-layout:v2`）与 v1 迁移；删除 `splitPaneForWorkspace` 可见性规则。新 pane id 取树内 `pane-<n>` 最大序号 +1（v1 迁移保留 `split` id） |
| 2 | `packages/ui/test/v4PaneLayoutStore.test.ts` | 单测重写：树操作/上限/塌缩/v1 迁移/focus 退化/持久化闭环 |
| 3 | `packages/ui/src/v4/workspaceConnectionRegistry.ts`（新建） | 引用计数 + 30s keep-warm + agentService 换代失效；模式对照 `sessionsIndexRegistry.ts` |
| 4 | `packages/ui/src/v4/V4ConversationContext.tsx` | 新增 `V4PaneConversationProvider`（注册表租约 + pane 级 `ServiceProvider` 包裹 + `isShellWorkspace` 走上下文 services）；原 `V4ConversationProvider` 保留给手机 `V4ChatPane` |
| 5 | `packages/ui/src/v4/V4WorkspaceChatArea.tsx` | 重写为递归分割树渲染；`SplitPaneDivider` 泛化（direction 感知 + per-node CSS 变量 `--v4-split-<nodeId>`，拖动仍 rAF 直写零渲染）；per-pane 恢复守卫组件化（`PaneRestoredGuard`） |
| 6 | `packages/ui/src/v4/SessionPane.tsx` | Esc-stop 与 add-to-chat 监听从「仅 primary」改为「focused pane」（06-ui 分屏规则 4）；新增拆分/关闭/徽标 props 透传 |
| 7 | `packages/ui/src/v4/ConversationHeader.tsx` | 「分屏/关闭分屏」改「向右拆分/向下拆分/关闭 pane」+ workspace 徽标（非 primary 且 ≠ shell 当前 workspace 时显示，远程加主机标识）；文案进 i18n 两语言 |
| 8 | `packages/ui/src/v4/workbenchSessionPlacement.ts` / `V4WorkspaceChatArea.tsx` / `app-shell/WorkspaceShellLayout.tsx` | 拖拽、右键分屏和普通点击共享 placement resolver/executor；入口只提供 intent、side、anchor 和完整 workspace scope，叶子达上限且目标无已有归属时禁用 |
| 9 | subagent child 详情 | 已迁移到 workspace 右侧 tabs，不再进入 split-pane workbench；普通 session「在分屏打开」保持不变 |
| 10 | `packages/ui/src/v4/index.ts` | 导出面更新（新旧转移函数/类型替换） |
| 11 | `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/v4-bridge.ts` | `createSessionRecord` 的 `workspaceId` 经远程 identity 对偶解析（`buildRemoteWorkspaceIdentity` 家族），补单测——远程 pane draft 首发建会话的前置 |
| 12 | 历史三条 `conversation-session-v4-split*.test.ts` | 2026-07-13 因显式按钮下线而删除；Task 列表拖拽入口的回归覆盖仍需维护 |

不动的面：`tabStore`（及其 ~46 个 `activeTabId` 消费者）、`splitPaneEntryContext` 闸门语义、手机 `/remote` 的 `V4ChatPane` 链路、`zcode-protocol-v4` schema、host/services 层（`processesByWorkspaceKey` 分桶已就绪）。

已核实的关键事实（实施时可直接依赖）：

- host 侧 `conversationFrameEmitters` / `processesByWorkspaceKey` 均按 workspaceKey 分桶，同窗口并发订阅 N 个 workspace 无单值假设；
- `remoteWorkspaceSessionStore` 已有 `sessionsById` 多连接 Map 与 `resolveRegisteredWorkspaceServices`；但远程目标断连时**必须**走 `useWorkspaceServices` 的断连代理路径，不得回落 base services；
- `sessionsIndexRegistry` 已按 `endpointKey + workspaceKey` 隔离，per-pane 恢复守卫可直接复用；
- e2e 既有契约：`v4-pane-shell-<paneId>`（`data-pane-id`/`data-focused`）、`v4-session-pane-<paneId>`、`TID_V4_SPLIT_OPEN/CLOSE/DIVIDER`、侧栏 `TID_V4_TASK_OPEN_IN_SPLIT`、localStorage key（v1→v2 需同步 helper 常量）。

## 验证基线

- 单测：paneLayoutStore v2 状态机（树操作/上限/塌缩/v1 迁移/focus 退化/持久化闭环）、workspaceConnectionRegistry（计数/keep-warm/service 换代/复用）。
- E2E（testid 契约）：`TID_V4_PANE_SHELL`/`TID_V4_SESSION_PANE` 动态后缀 paneId 不变；分隔条 `TID_V4_SPLIT_DIVIDER` 带 data-split-id；主流程（开分屏→draft 首发绑定→拖宽→刷新恢复→关闭）沿用既有三条 split e2e。
- 性能基线（06-ui）：4 pane 同时流式输出交互不掉帧。
- 待补验证项：远程 pane 真机 SSH 回归（断连占位/重连恢复/远程 draft 建会话）。
