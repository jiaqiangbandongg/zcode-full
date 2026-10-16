# Side Pane Terminal 跨 Workspace 会话保活

> 本 spec 是对 [`docs/ui/side-pane-terminal-tabs.md`](../ui/side-pane-terminal-tabs.md) 的增量。
> 原设计只规定了"side pane 内切 tab / 收起 side pane 时保持挂载"（第 19 行），
> **未覆盖"跨 workspace 切换"**。本 spec 补这块契约，并给出实现方案。

## 0. 与既有设计的关系（不可违背）

`docs/ui/side-pane-terminal-tabs.md` 已明确：

- 第 10/16 行：每个 side pane terminal tab 是**独立终端实例**，`+` 菜单每次新建、不复用单例。
- 第 18 行：**底部 Terminal 面板不和 side pane Terminal tab 共享终端 session 状态**。
- 第 19 行：关闭 tab 卸载 `TerminalSession` 并释放终端进程；**切换其他 side pane tab / 收起 side pane 时保持挂载**。

本方案严格遵守：**不与下侧共享 session**、**每个 side pane terminal 仍按 tab.id 独立**。只把第 19 行的保活契约**扩展到"跨 workspace 切换"**。

## 1. 根因（为什么第一版 forceMount 池没用）

`TerminalSession.tsx:309-639` 把 **XTerm 实例 + PTY + 订阅全绑在一个 effect** 里：

```
effect 创建:  new XTerm(:318) → term.open(container)(:338) → terminalService.create(:440) → 订阅 data/exit
effect cleanup(:606-628):  terminalService.dispose(杀PTY,:622) + term.dispose(销xterm+scrollback,:626)
effect 依赖(:629-639):       [cwd, sessionId, services, onShellLabelChange, 多个 resize callback, ...]
```

**只要依赖里任一项引用变了，effect 就重跑 → cleanup → xterm+PTY 全 dispose → 历史丢。**

侧边栏 terminal 活在 `sidePaneState` 体系里（per-workspace、按 `sidePaneMemoryKey` 整体替换，`useAppPanels.ts:229-243`）。跨 workspace 切换必然触发组件卸载或依赖变化 → effect 重跑 → dispose。

第一版试图在渲染层加并行池 + forceMount 来"阻止组件卸载"，但 forceMount 挡不住 effect 依赖变化，且和 sidePaneState 替换机制两套并行容易不一致——即"层级太低"。**正解是让 xterm+PTY 所有权脱离组件树**，组件任意卸载/重挂都不影响它们。

下侧不丢，是因为 `panelState`（`Terminal.tsx:99`）从一开始就不在 per-workspace 体系里（单实例组件 state 存所有 workspace session），靠 forceMount 让 TerminalSession 不卸载。侧边栏活在 per-workspace 体系里，搬不过来这套。

## 2. 方案：xterm+PTY 所有权上移到模块级 registry（方案 B）

模块级单例 `sidePaneTerminalSessionRegistry`，持有 `persistentKey(=tab.id) → { xterm 实例, fitAddon, terminalId, 订阅 disposers, cwd, hostEl, profileTheme }`。`TerminalSession` 加 `persistentKey?` prop：有则走 registry 复用路径，无则走原路径（下侧零改动）。

```
                      模块级单例（仅 side pane，与下侧 panelState 完全独立）
                  ┌──────────────────────────────────────────────────────────┐
                  │ sidePaneTerminalSessionRegistry                           │
                  │   Map<persistentKey(=tab.id), entry>                      │
                  │   entry = { key, term: XTerm, fitAddon, terminalId,        │
                  │             cwd, workspaceKey, hostEl(常驻 div,            │
                  │             term.open 在它上面), profileTheme(create 返回, │
                  │             跨重挂常驻), dispose(由创建方注入) }           │
                  │   + stashDiv(display:none 挂 document.body)               │
                  └──────────────────────────────────────────────────────────┘
                  API: has/get/register/attachDom/detachDom/release/releaseByPredicate
                       （registry 不内建 factory——资源创建由 TerminalSession 完成，再 register）
                           ▲
                           │
              TerminalSession 加 persistentKey?: string + workspaceKey?: string
              ┌────────────────────────────────────────────────────────────┐
              │ 有 persistentKey（仅 SidePaneTerminalPane 传 = tab.id）:    │
              │   effect:  get(key) 命中→复用 / miss→创建并 register         │
              │             attachDom(key, container)                       │
              │   cleanup: detachDom(key)  ← 不 dispose，hostEl 移回 stash  │
              │ 无 persistentKey（下侧）: 走原 effect（字节级不变）          │
              └────────────────────────────────────────────────────────────┘
```

### 时序

```
[workspace A] 打开 side pane terminal tab（tab.id = terminal:uuid1）
  SidePaneTerminalPane(persistentKey=tab.id, workspaceKey=A, cwd=A)   ← 不再 useState(createUuid)
   └ TerminalSession effect [有 persistentKey]
       ├ get(tab.id) 命中 → 复用；miss → 创建：new XTerm + open(hostEl) + 创建 PTY + 订阅
       │                    → entry.workspaceKey = workspaceKey → register(tab.id, entry)
       ├ termRef/fitAddonRef/terminalIdRef ← entry 的引用
       ├ attachDom(tab.id, containerRef)  → hostEl 从 stash 移入 container
       └ fitAddon.fit()                   → 按真实尺寸 resize PTY

[切到 workspace B] sidePaneState 整体替换，旧 SidePaneTerminalPane 卸载
  TerminalSession cleanup [有 persistentKey]
   ├ 释放组件局部 observer（ResizeObserver/MutationObserver）
   └ detachDom(tab.id)  → hostEl 移回 stashDiv（term/PTY/订阅 都不 dispose）

[切回 workspace A] SidePaneTerminalPane 重挂（tab.id 稳定）
  TerminalSession effect [有 persistentKey]
   ├ get(tab.id) → 命中，返回已有 entry
   ├ attachDom(tab.id, containerRef) → hostEl 移回 container
   └ fitAddon.fit() → scrollback 历史完整保留 ✓

[显式关闭 side pane terminal tab]（useAppPanels 的 close 单/其他/全部）
  └ release(tab.id) → entry.dispose()(杀 PTY + 销 xterm + 释放订阅) ← 进程回收（守第 19 行契约）

[workspace tab 真正关闭]（WorkspaceShellLayout 监听 openWorkspaceKeys）
  └ releaseByPredicate(entry => entry.workspaceKey 不在 openWorkspaceKeys)
       → 回收该 workspace 残留的常驻 PTY，对称下侧 Terminal.tsx:145-177
```

## 3. xterm 实例复用机制（技术命门）

xterm scrollback 在 XTerm 实例 buffer 里。复用必须**保留同一 XTerm 实例**，不能 dispose+new。

- `term.open(el)` 只调一次（首次创建时 open 到 entry 的 `hostEl`）。
- 复用 = 把 `hostEl`（含 `.xterm` DOM 子树）用 `appendChild` **物理移动**到当前 container；移动后调 `fitAddon.fit()` 恢复尺寸。
- detach = `hostEl` 移回 `stashDiv`（`display:none`，挂 `document.body`，registry 懒创建），避免 React 卸载 container 时连带销毁 xterm DOM。
- 社区先例：VS Code terminal tab 切换即用 xterm DOM 移动复用，canvas/webgl renderer 移动后 fit 即可恢复。

### 3.1 输入订阅必须 registry-scoped（关键契约，曾踩坑）

`term.onData`（键盘输入→PTY）和 Windows 输入法 textarea 兜底**必须挂进 `registryDisposers`（随 entry 常驻），不能进 `localDisposers`**。

- `localDisposers` 在 cleanup（detach）时被全部 dispose——`term.onData` 若在内，detach 时被取消，而复用路径不重绑 → **切回 workspace 后 scrollback 在但无法输入交互**（PTY/xterm 都活着，只有输入链路被砍断）。
- `registryDisposers` 随 entry 常驻，detach 不取消；只有 `release`（关 tab / workspace 关闭）时 `entry.dispose` 才清理。
- Windows textarea 兜底原本依赖单次 effect 闭包变量 `ptyCancelled`，移到 registry 后必须去掉该检查（`ptyCancelled` detach 后变 true 会让兜底永久失效）；release 时 disposer 移除监听，PTY disposed 后 write 为 no-op，安全。
- **persistentKey 路径的 `onData` 必须与原路径字节对齐**（含 `inputFallbackKeydownCandidate` 去重 + `recordTerminalInputFallbackHandledData`/`recordTerminalInputFallbackRecentData` 历史维护）。曾因简化漏掉这段，导致 Windows 中文输入法无法通过 Shift 切英文直接输入（只能回车提交）。`customKeyEventHandler` 在首建时 attach 到 term、随 term 常驻，keydown 写 candidate；registry-scoped 的 onData 消费 candidate、维护历史，textarea 兜底再消费历史 —— 三者共用首建组件实例的 ref，跨 detach/reattach 自洽。
- **PTY ready 后必须 `flushTerminalServiceResize()`**（对称原路径）：创建期间 ResizeObserver 排进 `pendingTerminalSizeRef` 的尺寸，在 `terminalIdRef.current = id` 后立即 flush；否则 `scheduleFitAndResize("init")` 会因 pending 去重跳过，PTY 停在错误 cols/rows。
- **exit 订阅与原路径对称**：有 `onExit` 则回调（autoClose），否则写退出提示。side pane 当前不传 `onExit`，二者等价；保持对称以防未来接线。

## 4. 实现策略：registry 路径独立，原路径不动（守下侧零回归）

为彻底保证下侧 terminal（核心功能）不回归，`TerminalSession` 的 persistentKey 路径**独立写一套资源创建逻辑**（factory），不抽取/扰动原 effect 的 300 行创建+订阅代码：

- **原路径（无 persistentKey，下侧）**：effect 逻辑、cleanup、依赖数组**字节级不变**。
- **registry 路径（有 persistentKey）**：effect 开头分叉，走 `ensureSession(key, factory)`；factory 内部 new XTerm + open(hostEl) + create PTY + 订阅（逻辑上对称原路径，但独立成函数，复用同一份 `terminalService`）。

代价：factory 与原路径创建逻辑有重复。收益：下侧零风险（不动它），registry 路径独立可控、可测。

## 5. 边界与兼容（遵守多端/远控/工作区约束）

- **仅 side pane**：`persistentKey` 只由 `SidePaneTerminalPane` 传入（= `tab.id`）。下侧 `Terminal.tsx` 不传，走原路径，零回归（守 side-pane-terminal-tabs.md 第 18 行）。
- **不动 `terminalService`**：PTY 仍在根级共享单例（本地 workspace 共用 `baseServices`），只是 dispose 时机由 registry 控制（显式关 tab 才 dispose）。
- **不动 `sidePaneState` 替换机制**：browser/subagent/plan 等 tab 行为不变。
- **registry 按 `persistentKey`(=tab.id) 隔离**：不按 `workspacePath` 匹配（符合 workspace identity 约束）。远程 workspace 的 PTY 仍归当前窗口 services（第 24 行），registry 只存 PTY id 引用，不改变归属。
- **不涉及 session/task realtime、replayable/continuous 链路**（第 25-26 行）：纯 renderer terminal DOM 复用。
- **回收点齐全**（防孤儿 PTY）：
  - 显式关 side pane terminal tab → `useAppPanels` 的 `handleCloseSidePaneTab` / `handleCloseOtherSidePaneTabs` / `handleCloseAllSidePaneTabs` 调 `release(tab.id)`。
  - workspace tab 真正关闭 → `WorkspaceShellLayout` 监听 `openWorkspaceKeys` 变化，按 `entry.workspaceKey` 批量 `releaseByPredicate`（对称下侧 `Terminal.tsx:145-177`）。`workspaceKey` 由 `SidePaneTerminalPane → TerminalSession` 透传并写入 entry。
  - registry 模块卸载/测试 → `clearForTest()`。

## 6. 风险

- xterm DOM 物理移动的 renderer 刷新（第 3 节）—— 实现阶段验证 fit 能恢复；若异常，回退用 React Portal 把 `hostEl` 常驻投射（仍不 dispose 实例）。
- registry 内存管理：workspace 关闭、tab 关闭都要 release，避免孤儿 PTY。
- factory 与原路径重复代码的长期同步—— 当前靠 `TerminalSession` 复用契约测试 + 既有 `terminalPanelState.test.ts` 守护，但两份拷贝已漂移 3 次（见第 8 节）；根本解法是第 8 节的 `wireTerminalProcessing` 收敛重构。

## 7. 执行顺序（先 spec → 先测试 → 再代码）

1. **spec**：本文件。
2. **测试（先写）**：
   - `sidePaneTerminalSessionRegistry.test.ts`：ensureSession 命中/miss、attachDom/detachDom 的 hostEl 归属移动、release 真 dispose（term+PTY+订阅）、跨"切换"（detach 后）entry 仍在、releaseByPredicate 批量回收。
   - `TerminalSession`/`SidePaneTerminalPane` 复用契约：有 persistentKey 走 registry、无 persistentKey 走原路径（源码断言 + 行为）。
3. **代码**：
   - 新建 `packages/ui/src/terminal/sidePaneTerminalSessionRegistry.ts`（模块级单例 + stashDiv，entry 含 `workspaceKey`）。
   - `TerminalSession.tsx` 加 `persistentKey?` + `workspaceKey?` prop，effect 开头分叉 registry 路径（复用=attachDom，首建=register，cleanup=detachDom / 半成品 release）。
   - `SidePaneTerminalPane.tsx`：`sessionId` 从 prop 传入（= tab.id，跨 workspace 稳定），并传 `persistentKey={sessionId}` + `workspaceKey`；删 `useState(createUuid)`。
   - `AnimatedSidePanePanel.tsx`：渲染 `SidePaneTerminalPane` 时透传 `sessionId={tab.id}` + `workspaceKey`。
   - `useAppPanels.ts`：显式关 side pane terminal tab（单/其他/全部）→ `release(tab.id)`。
   - `WorkspaceShellLayout.tsx`：监听 `openWorkspaceKeys`，workspace tab 关闭时按 `entry.workspaceKey` 批量 `releaseByPredicate`（对称下侧 `Terminal.tsx:145-177`）。
4. **校验**：`pnpm typecheck` + `pnpm lint` + 新测试 + `terminalPanelState.test.ts` 回归。
5. **commit**：`fix(ui): keep side pane terminal alive across workspace switch via session registry`。

---

## 8. 待重构：终端处理逻辑收敛为单一 `wireTerminalProcessing`（设计稿，未实施）

> 本节是**设计**，记录在保活落地后暴露出的架构缺陷与目标重构方案。当前实现尚未按此重构；保留给后续专项处理。

### 8.1 问题：两条路径是"拷贝"而非"共享"

理想形态（也是产品本意）：**终端处理逻辑只有一份**，persistentKey 路径与原路径（下侧 terminal）只在**容器管理**上分叉。当前 `TerminalSession.tsx` 的 effect 里却是两条 ~370 行的平行分支，靠注释 + `terminalSessionFocus.test.ts` 的结构断言手动维持字节对齐。

```
当前结构（问题）：
useEffect(() => {
  if (persistentKey) {
    复用路径: registry.get → attachDom/fit/focus
    首建路径: new XTerm → open(hostEl)
              ┌─────────────────────────────────────┐
              │ customKeyEventHandler               │  ◀── 终端处理
              │ themeObserver / registerLinkProvider│      （第一份拷贝）
              │ .create().then(flush+opts+data+exit │
              │   +onData+textareaIME)+resize+catch │
              └─────────────────────────────────────┘
    → registryDisposers / localDisposers
    cleanup: detachDom（保活）          ┐
  }                                    │ 容器管理（合理分叉）
  else {                               │
    new XTerm → open(el)               │
    ┌─────────────────────────────────┐│
    │ 同样的处理逻辑，再写一遍         ││  ◀── 终端处理（第二份拷贝）
    └─────────────────────────────────┘│
    → disposables（effect 局部）        │
    cleanup: dispose 全部（销毁）       ┘
  }
})
```

### 8.2 证据：已发生 3 次漂移

两份拷贝只要任一处改动，另一处极易遗漏。已确认的漂移：

| # | 项 | 后果 | 状态 |
|---|----|------|------|
| 1 | `flushTerminalServiceResize()` | persistentKey 路径 id ready 后未 flush 创建期排队 resize，PTY 停在错误 cols/rows | 已修（f8cfca38b7） |
| 2 | exit 订阅查 `exitHandlerRef` | persistentKey 路径 exit 订阅未查 onExit 回调，与原路径不对称 | 已修（f8cfca38b7） |
| 3 | paste 快捷键 `logger.debug("[Terminal] paste via shortcut")` | persistentKey 路径 customKeyEventHandler 漏了该 debug 日志 | 已对齐（本次） |

这 3 个全是"两份拷贝必然漂移"的直接产物。

### 8.3 目标结构

抽出**唯一的**终端处理函数，两条路径各自只剩纯容器管理：

```
// 终端处理：全局唯一
function wireTerminalProcessing(term, host, ctx): {
  termDisposers: IDisposable[],   // 跟随 term 生命周期（data/exit/onData/linkProvider）
  domDisposers:  IDisposable[],   // 跟随 DOM 容器生命周期（themeObserver/resizeObserver）
  cancelPtyCreate: () => void,    // cleanup 早于 create resolve 时的孤儿 PTY 守卫
}
{
  // 以下全部只写一次：
  // - attachCustomKeyEventHandler（IME candidate + Ctrl/C/V）
  // - themeObserver（documentElement class → 配色）
  // - registerLinkProvider
  // - terminalService.create().then(
  //     flushTerminalServiceResize + windowsPty/font/theme options +
  //     (theme 写入 entry.profileTheme，跨重挂常驻；observer 从 entry 读，禁用组件局部 ref——CR-01) +
  //     onDynamicData + onDynamicExit + onData(IME 三段去重) + textarea 兜底 +
  //     scheduleFitAndResize("init") + requestFocus)
  // - ResizeObserver（observe host）
  // - .catch（写失败提示 + 释放 registry 占位 entry：ownership 校验
  //   registry.get(key)===本次 entry 才 release，避免僵尸 entry 被复用快路径
  //   误用导致终端永久无法连接；校验防重挂后新 entry 被误删）
}

useEffect(() => {
  if (persistentKey) {
    const existing = registry.get(persistentKey)
    if (existing) { attachDom(hostEl); fit; focus; return () => detach }   ┐
    const term = new XTerm({...}); term.open(hostEl)                        │ 容器管理
    const { termDisposers, domDisposers, cancelPtyCreate } =               │ （分叉）
        wireTerminalProcessing(term, hostEl, {...})                         │
    registry.register(persistentKey, { term, termDisposers, workspaceKey }) │
    localDisposers = domDisposers                                          │
    return () => { cancelPtyCreate(); detachDom; drain(domDisposers) }      ┘
  }
  const term = new XTerm({...}); term.open(el)                             ┐
  const { termDisposers, domDisposers, cancelPtyCreate } =                 │ 容器管理
      wireTerminalProcessing(term, el, {...})                               │ （分叉）
  const disposables = [...termDisposers, ...domDisposers]                  │
  return () => { cancelPtyCreate(); drain(disposables); dispose(term+pty) } ┘
})
```

### 8.4 为什么 disposer 要分两类

这是重构里**唯一**需要想清楚的非平凡点，也是 persistentKey 路径今天用 `registryDisposers` / `localDisposers` 两个桶的原因：

- **跟随 term（termDisposers）**：`onDynamicData` / `onDynamicExit` / `term.onData` / `registerLinkProvider`。它们绑定的是 PTY ↔ term 的数据链路；persistentKey 路径下 term 跨 detach 存活，这些订阅**必须**随 term 常驻（否则切回后 scrollback 在但输入死，即 bug #1 / commit 9e32c2d2d9 的根因）。
- **跟随 DOM（domDisposers）**：`themeObserver`（observe documentElement）、`ResizeObserver`（observe 当前 `el`）。persistentKey 路径下每次重挂 `el` 是新节点，observer 必须随 effect 重绑。

原路径 term 不跨 effect 存活，两类都进同一个 `disposables` 即可——这正是重构后原路径的写法（`[...termDisposers, ...domDisposers]`）。

### 8.5 测试先行（重构时必须先红后绿）

1. **新增契约测试**：断言 `TerminalSession` effect 在 persistentKey 与非 persistentKey 两条分支都调用同一个 `wireTerminalProcessing`（源码级：grep 出现次数 = 2，且不在同一条 if 内重复）。这是机械保证"处理逻辑只有一份"的护栏。
2. **保留**现有 `terminalSessionFocus.test.ts` 的行为契约（IME onData 字节、exit 对称、flush 时序），重构后逐条仍须绿。
3. **回归**：`terminalPanelState.test.ts`（下侧）+ `sidePaneTerminalSessionRegistry.test.ts`（保活）不可退化。

### 8.6 风险与前置条件

- 改动面：抽出 ~250 行共享代码，effect 两条分支各瘦到 ~40 行。机械搬移为主，但涉及 **async create 时序、pending resize flush、composition 三段去重**，属时序/IME 敏感区。
- 当前**无 e2e 安全网**（本特性 e2e 在原 plan 中列为"后续可选"）。重构前应先补一条跨 workspace 切换 + IME 输入的 e2e（照 `browser-tab-close-cross-workspace.test.ts` 骨架），否则回归只能靠单测 + 手动冒烟。
- 重构是**纯结构、零行为变更**：合并后必须保证两条路径的外部可观测行为（scrollback 保活、输入、IME、resize、主题、退出提示）与重构前逐一对齐。建议重构 commit 单独成 MR，不夹带任何行为改动。

### 8.7 触发本设计的来由

2026-08-12 审计 persistentKey 路径与原路径差异时发现 3 处漂移（8.2）。用户判断这是**设计缺陷**（重复分支），要求先固化设计、后续再重构；当下仅逐处对齐已发现的漂移。本节即该设计固化产物。
