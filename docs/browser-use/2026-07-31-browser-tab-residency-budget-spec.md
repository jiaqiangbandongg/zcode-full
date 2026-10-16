# Browser Tab 32 个硬上限与进程生命周期 Spec

> 状态：2026-08-05 按用户对生产行为的实测与产品裁决修订。
>
> 对齐基准：当前已发布生产版完整退出后不恢复 Browser Tab。
>
> 本文是 Browser / Browser Use tab 的当前资源生命周期事实来源。它取代本文历史版本中的
> “跨重启 shell catalog、page-state、suspended/restoring 惰性恢复”设计。

当前产品边界是：**每个 BrowserWindow 最多保留 32 个逻辑 Browser / Browser Use tab；创建第 33 个时，
最久未活动的安全候选会被完整关闭并从 UI 消失。ZCode 进程完整退出后不持久化、不恢复任何 Browser Tab。**

## 1. Feature Summary

| Field | Value |
| --- | --- |
| Developer intent | 保留每窗口 32 个逻辑 Tab 硬上限，移除跨应用重启恢复 |
| Capability | Desktop embedded Browser logical tab lifetime |
| Change layer | persistence / recovery / commit-effect |
| Operating mode | implementation handoff |
| Primary seeds | `BrowserGuestManager`、`useAppPanels`、`AnimatedSidePanePanel`、Desktop main wiring |
| Out of scope | 进程内多轮复用、guest renderer 异常退出原位恢复、Browser command、手机 replayable、远程 workspace runtime |

### 1.1 固定产品常量

| 项目 | 值 | 语义 |
| --- | ---: | --- |
| 逻辑 Browser tab | 每个 BrowserWindow `32` 个 | 普通 Browser 与 Browser Use 合并计数；超限后从 UI 和 main registry 完整关闭 |
| 跨重启 Browser tab | `0` 个 | 完整退出后新进程从空 Browser Tab 集合启动 |

不再存在 Browser Tab page-state 的 100 页、64 MiB、500 history 产品容量；这些值只属于已退役的恢复仓库实现。

## 2. Impact Brief

### 2.1 UI Surface Matrix

| User scenario | UI entry | Shared implementation | Display/draft owner | Commit action | Authority/persistence | Mode boundary | Must remain isolated from |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 打开/切换普通 Browser | Side Pane Browser tab | `UnifiedBrowserView` | renderer side-pane registry | attach/report/close | 当前 Electron 进程内存；不落盘 | Desktop only | 手机 replayable、其它 workspace/session |
| Agent 操作 Browser Use | Browser Use side pane | `BrowserUseSidePaneContent` + `UnifiedBrowserView` | renderer shell + main `BrowserGuestManager` | Browser command / attach / close | 当前 Electron 进程内存；不落盘 | Desktop continuous | relay、Host task snapshot、手机独立 runtime |
| 创建第 33 个 Tab | Side Pane tab strip | residency coordinator | main logical catalog | `closeTabDurably()` | UI/main/guest 同时删除；无跨重启仓库 | 每 BrowserWindow | 当前操作、截图、下载、媒体等保护 lease |
| 完整退出再启动 | Desktop lifecycle | `prepareAppQuit` + renderer bootstrap | 新进程空 registry | 不执行 Browser Tab restore | 无 Browser Tab recovery file authority | dev/packaged 一致 | conversation/task 自身的冷恢复 |

### 2.2 Shared And Divergent Behavior

| Concern | Shared across surfaces | Deliberately different | Why it matters |
| --- | --- | --- | --- |
| Tab 上限 | Browser 与 Browser Use 共用每窗口 32 个逻辑 Tab | 保护信号按各自运行态汇总 | 禁止一类 Tab 绕过总量上限 |
| 进程内复用 | stable logical tabId 与 live guest 在进程内保留 | guest crash 可替换 webContentsId | 移除跨重启恢复不能破坏进程内连续性 |
| 完整重启 | 两类 Tab 都不恢复 | conversation/task 数据仍按各自规则冷恢复 | Browser UI 状态不能混入任务恢复 |
| 手机远控 | 不创建独立 Browser runtime | 继续通过 shared-host attachment 使用当前桌面进程 | 不得把桌面 Tab 持久化语义扩散到 replayable snapshot |

### 2.3 Feature Relationships

| Rank | From | Semantic edge | To | Why inspect it | Evidence |
| --- | --- | --- | --- | --- | --- |
| must-inspect | Browser tab hard limit | closes through | `BrowserGuestManager` | 第 33 个 Tab 必须关闭完整 logical tab | manager/coordinator tests |
| must-inspect | Desktop bootstrap | must-not-call | Browser Tab restore | 新进程必须得到空 Tab strip | `useAppPanels` + Electron E2E |
| must-inspect | Desktop main wiring | must-not-inject | persistent recovery store | 禁止运行期继续写可恢复 shell/pageState | main wiring + userData evidence |
| should-inspect | App shutdown | releases | live guests | 正常退出只等待既有业务资源，不保存 Browser Tab | `prepareAppQuit` |
| invariant-only | guest crash recovery | remains in-process | replacement guest | mounted guest 异常退出仍可原位恢复 | `UnifiedBrowserView` tests |
| invariant-only | mobile remote | remains isolated | Browser Tab lifecycle | 不新增 task snapshot/runtime 字段 | architecture constraints |

### 2.4 State Owners And Commit Sinks

| State/fact | Display owner | Authoritative owner | Commit command/service | Persistence/cache |
| --- | --- | --- | --- | --- |
| 当前 Tab strip | renderer workspace side-pane registry | renderer + main logical catalog | open/close/limit close | 仅进程内 |
| live guest/CDP | `UnifiedBrowserView` | `BrowserGuestManager` | attach/detach/close | 不持久化 |
| 32 个上限与 LRU | 无独立 UI | `BrowserTabResidencyCoordinator` | `closeTabForLimit` | 仅进程内 |
| Browser Tab 重启状态 | 无 | 无 | 无 restore command | 不写 recovery file |

### 2.5 Must-Preserve Invariants

- `workspaceKey = workspaceIdentity?.trim() || workspacePath`；远程 tab 继续携带 `remoteSessionId`。
- Desktop local 与 remote workspace 的逻辑 tab 共用所属 BrowserWindow 的同一上限，但内容和命令 scope 不互见。
- 当前 selected/visible、Browser operation、screenshot/capture、audio/media、loading、download 期间不可自动关闭。
- 进程内 `finalize({ keep })`、turn 切换和 session 切换不隐式关闭未列出的 Tab。
- guest renderer 的 killed/crashed/oom/memory-eviction 原位恢复保留；它不是应用重启恢复。
- 手机 `/remote` 不新增 Browser runtime、Browser Tab snapshot 或 replayable 恢复字段。
- dev 与 packaged Desktop 使用相同的“不跨重启恢复”产品语义；数据目录差异不能改变行为。

### 2.6 Codegraph Evidence

当前环境没有可用的本仓 codegraph 查询工具，采用 feature graph 声明的 seed 与 `rg` 直接调用点追踪：

| Seed | Key path | Depth | Interpretation |
| --- | --- | ---: | --- |
| `BrowserGuestManager` | main wiring → attach/report/close | 2 | hard limit 与运行态 owner |
| `browserViewRestoreTabs` | UI effect → platform → IPC → manager | 2 | 必须从 renderer bootstrap 移除的跨重启入口 |
| `BrowserTabRecoveryStore` | Desktop main constructor injection | 2 | 必须停止装配的持久化 sink |
| `AnimatedSidePanePanel` | side-pane registry → Browser surface | 2 | 第 33 个 Tab close 的 UI 消费者 |

### 2.7 Graph Drift / Delta

- `capability.browser-tab-residency` 的旧 label 把“32 上限”和“跨重启恢复”绑定，需改为纯进程内硬上限。
- `persistence.browser-tab-recovery-store` 改为 legacy/disabled 节点，不再与运行时 service 相连。
- 增加 local development 与 packaged desktop 具有相同“不恢复 Tab”边界的语义边。

### 2.8 Unresolved Questions

无。用户已明确裁决：完整关闭 ZCode 后重新启动，Browser Tab 应全部消失。

## 3. 状态模型

```text
Electron process N
  logical tab lifecycle: active | handoff | deliverable | closed
  guest residency: live-visible | live-background | transient-replacing

              complete app quit
                      |
                      v
              all Browser tabs end
                      |
                      v
Electron process N+1: empty Browser tab registry
```

- `closed` 是进程内终态；删除 Tab 壳、guest/CDP/listener 与 main registry。
- 超限 victim 直接进入 `closed`，不进入 suspended。
- 应用退出结束所有 Browser Tab；新进程不重建 logical tab、stable tabId、URL、标题、favicon 或 history。
- `transient-replacing` 只描述同一进程内 guest renderer 异常退出后的替换，不落盘、不跨进程。
- `suspended/restoring/residencyGeneration` 不再是可达的产品重启状态；保留的兼容类型不得被 Desktop 装配触发。

## 4. 32 个逻辑 Tab 硬上限

每个 BrowserWindow 独立计算：

```text
logicalTab(tab) = tab.lifecycle != closed
overLimit = count(logical tabs in BrowserWindow) > 32
```

- 普通 Browser 与 Browser Use 使用同一个窗口上限。
- local 与 remote workspace 只共享物理窗口计数，不共享 tab 内容、命令或 scope。
- 无 guest 的短暂 crash replacement 仍属于同一个 logical tab，不能绕过计数。
- 已 closed/tombstone 的 tab 不计数；迟到 attach 不得复活被上限关闭的 tab。

## 5. 保护集合与关闭顺序

满足任一条件即不可被上限自动关闭：当前选中/实际展示、Browser Use operation、截图/capture、声音或媒体、
loading、下载。若所有超额 tab 都受保护，允许暂时超过 32；保护释放后自动重评估。

安全候选按以下顺序选择：

```text
lastActivityAt 最早 -> lastSelectedAt 最早 -> openedAt 最早 -> tabId 字典序
```

`preferred/main/currentTask` 不提供额外的 30 分钟保护；最久未活动的安全候选优先关闭。

## 6. 超限关闭事务

```text
BrowserTabResidencyCoordinator      BrowserGuestManager       renderer
             |                              |                       |
             | choose oldest safe victim    |                       |
             |----------------------------->| close guest/CDP        |
             |                              | remove main registry   |
             |                              |---------------------->| close tab shell
```

1. 上限关闭复用唯一 close authority，不能只销毁 WebContents。
2. 关闭 guest/CDP/listener 并从 main registry 删除后，向 owner BrowserWindow 定向发送 close。
3. renderer 使用既有 reducer 删除对应 tab trigger，并同步 active/collapsed UI。
4. 自动关闭沿用 window/workspace/session/remoteSessionId authority，不广播到其它 scope。
5. 生命周期日志走 `debug`，记录 `reason=tab-limit`。

## 7. 应用退出与下一次启动

```text
complete quit
  -> release/kill all live Browser guests
  -> do not persist shell/pageState
  -> next process does not request browserViewRestoreTabs
  -> Browser tab strip starts empty
```

- 正常退出、Cmd+Q、Windows quit、更新安装退出都不保存 Browser Tab。
- 旧开发版本留下的 `browser-tab-recovery.json` 不再是权威数据，当前运行时不得读取或追加它。
- renderer reload、窗口销毁与应用完整退出都不能依靠 recovery catalog 复活 Browser Tab。
- conversation/task 自身的 SQLite/session cold resume 与 Browser Tab 生命周期完全独立。
- 进程内切换 workspace/task 时仍按现有 registry 保留 Tab；只有完整进程/窗口生命周期结束才清空。

## 8. IPC 与分层边界

继续使用的能力：

| 方向 | 能力 | 用途 |
| --- | --- | --- |
| renderer → main | `browserViewCloseTab` | 用户显式 close |
| main → renderer | `onBrowserViewCloseTab` | 用户/Agent/上限关闭后删除 tab 壳 |
| renderer → main | `browserViewReportResidency` | selected/visible/保护状态与可信 sender window |
| renderer → main | `browserViewAttachGuest` | live guest attach 与迟到事件防护 |

`browserViewRestoreTabs`、`onBrowserViewSuspend`、`onBrowserViewRestore` 与恢复 generation 属于 legacy compatibility；
Desktop bootstrap/main production wiring 不调用、不注入持久化 store。Agent stdio BrowserCommand 无需修改。

## 9. Case Planning 与剪枝

### 9.1 Boundary Decisions

| Boundary | Decision | Includes | Excludes / prunes | Source |
| --- | --- | --- | --- | --- |
| 第 33 个 Tab | 完整关闭最老安全候选 | Browser + Browser Use | suspend shell、30 分钟保护 | 用户裁决 + 运行时反馈 |
| 完整应用重启 | Browser Tab 全部消失 | dev + packaged、local + remote tab UI | shell/pageState/history 恢复 | 用户生产实测与明确指令 |
| 进程内切换 | 保留 live tab | task/workspace/session 切换 | 跨进程 stable tabId | 既有 BTL01-03 |
| guest crash | 原位替换 | recoverable renderer exit | 应用退出后替换 | BCP-207 |
| 手机远控 | 不新增状态 | shared-host attachment | 独立 runtime、replayable Browser Tab snapshot | 架构约束 |

### 9.2 Accepted Cases

| Case | Setup / event | Assertions | Status |
| --- | --- | --- | --- |
| BTL01-03 | 无预算压力的多 turn / 双 session 多 tab | 进程内 stable tab、guest 与 scope 连续 | accepted |
| BTL04 | 已有 32 个逻辑 tab，再创建第 33 个 | 最老安全候选从 DOM、main registry 与 guest 完整消失；总数回到 32 | accepted |
| BTL05 | 所有超额候选均有运行态保护 | 暂时超限；保护释放后自动关闭最老安全候选 | accepted |
| BTL10 | local/remote、不同 workspace identity 共处窗口 | 共享物理上限但 scope/命令不串 | accepted |
| BTL11 | 用户 close live tab | UI/main/guest 完整关闭；迟到 attach 不复活 | accepted |
| BTL12 | 完整退出前存在多个 Browser / Browser Use tab | 下一进程 Browser tab strip、main registry、webview 均为 0 | accepted |
| BTL19 | remote tab 的 visibility/attach/list/claim | `remoteSessionId` 不丢失，跨 remote scope fail closed | accepted |
| BTL20 | 当前进程 catalog 存在暂时无 live guest 的 logical tab | 仍计入 32 个上限，且可作为最老安全候选被完整关闭 | accepted |

### 9.3 Retired / Pruned Cases

- BTL06-09、BTL13-18、BTL21-23：依赖 suspended、pageState、shell catalog、恢复 repository
  或恢复删除屏障，随跨重启恢复一起退役。
- 不做 Browser/Browser Use × 每种退出方式全排列；一个真实完整进程重启 E2E 代表，退出策略由 focused tests 保证。
- 不做 local/SSH/WSL/Docker × 重启全排列；“不持久化任何 Browser Tab”是统一不变量。
- 不把手机 replayable 与 Desktop Browser Tab 冷恢复组合，因为手机没有独立 Browser runtime。

### 9.4 Planning Handoff

| Item | Destination | Status |
| --- | --- | --- |
| Spec update | 本文 | complete |
| Case catalog | `docs/conversation-session-case-catalog.md` BTL | complete |
| Coverage matrix | conversation + Browser Use matrices | complete |
| Feature graph | `zcode-feature-graph.yaml` | complete |
| E2E handoff | `browser-tab-residency.test.ts` | complete |

## 10. 完成门槛

- 每个 BrowserWindow 的逻辑 Browser / Browser Use tab 总数常态不超过 32。
- 第 33 个 tab 出现后最老安全候选从 UI、main registry 与 WebContents 完整关闭。
- 全运行态保护时允许暂时超限，保护释放后无需用户操作即可重新收敛。
- 完整退出后重新启动，Browser tab strip、main logical list 和 live guest 均为 0。
- Desktop main 不装配持久化 Browser Tab recovery store；renderer bootstrap 不请求恢复 shell。
- 进程内多 turn/session 切换和 recoverable guest crash 不回归。
- workspaceIdentity、remoteSessionId、session、window 与 clientMode 边界无回归。
- desktop continuous 不吸收 mobile replayable 状态，relay/Host/task snapshot 不新增 Browser Tab 状态。
- `pnpm typecheck`、`pnpm lint`、focused unit 与真实 Electron 33-Tab + restart E2E 通过。
