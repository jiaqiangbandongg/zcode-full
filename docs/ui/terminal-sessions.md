# Terminal Sessions

终端面板支持一个 workspace 下多个 terminal tab，并按 workspace identity 隔离保活。

## 功能变更摘要

| 字段         | 内容                                                                                  |
| ------------ | ------------------------------------------------------------------------------------- |
| 变更         | 首个 terminal tab 不显示 `1`；后续 tab 从 `2` 开始；关闭或 PTY 退出时同步关闭对应 tab |
| 用户可见位置 | 底部 Terminal 面板的 tab strip                                                        |
| 状态 owner   | `Terminal` renderer 本地状态；PTY 生命周期由每个 `TerminalSession` 管理               |
| 不在范围内   | 右侧 side pane Terminal tab、聊天 session/task realtime、协议与 Host/Agent runtime    |

## 产品行为

核心规则：

- workspace key 使用 `workspaceIdentity?.trim() || workspacePath`，只用于终端会话隔离。
- `workspacePath` 只作为 PTY 的 cwd 传给 `terminalService.create()`。
- 收起终端面板或切换 workspace/task 不会 dispose 已创建的 terminal tab。
- 多于一个 terminal tab 时，关闭某个 tab 会卸载对应 `TerminalSession`，从而 dispose 后端 PTY。
- 只有一个 terminal tab 时仍显示 tab 关闭按钮；点击后关闭整个 Terminal 面板，不卸载该 session。重新打开面板时继续使用原 session。
- Tab 与 Side Header 使用相同的 ghost 风格：无可见边框，选中背景 hover 不变，4px 间距；内容溢出用 mask 淡出、不使用省略号。关闭按钮参与普通 flex 布局，仅选中、hover 或 focus-within 时显示，隐藏时保留占位；mask 不随按钮显示状态移动。「终端」标题保持原样，shell 名称采用普通辅助文字，不使用 pill 样式。
- shell/PTY session 自身退出时自动关闭对应 tab；普通子命令返回非 0 但 shell 仍存活时不关闭。
- 多 tab 中的后台 session 退出时只移除自身，不改变当前活动 tab；活动 session 退出时沿用手动关闭的相邻 tab fallback。
- 当前 workspace 的最后一个 session 退出时移除已结束的 session 并关闭整个 Terminal 面板；下次打开时才懒创建一个全新 session，不保留 `[进程已退出]` tab。
- 隐藏 workspace 的最后一个 session 退出时只清理该 workspace 的 terminal state，不关闭当前 workspace 的 Terminal 面板。
- terminal 启动失败不属于 PTY exit；错误内容继续留在 tab 中供排查。
- 关闭 workspace tab 后，面板会根据仍打开的 workspace key 回收隐藏终端，避免后台 PTY 泄漏。
- 打开终端面板、切换 terminal tab、或新建 terminal tab 后，当前可见的 xterm 必须自动获得键盘焦点；隐藏的 workspace/session 不抢焦点。
- 拖拽调整底部终端高度时，xterm fit 和后端 PTY resize 不能按每个 `ResizeObserver` 回调同步执行；拖拽中按 `TERMINAL_RESIZE_DRAG_THROTTLE_MS` 低频预览，松手后立即 flush 最终尺寸，并对相同 `{ cols, rows }` 去重，避免 Windows / PowerShell 下连续 resize 卡住 UI。
- tab 展示名使用对应 session 的 cwd 叶子名；首个编号 `1` 不显示，例如 `z-code`。编号 `2` 及以后显示为 `z-code 2`、`z-code 3`。
- tab 名称在创建后保持不变。关闭其他 tab 不会触发已有 tab 重命名。
- 新建 tab 使用当前 workspace 内最小可用正整数编号。关闭 `z-code 2` 后再次新建，名称仍为 `z-code 2`。
- 终端输出中的 `http://` / `https://` 明文链接通过 xterm link provider 识别，hover 时显示下划线和手型，点击后复用 UI 层的 `onOpenBrowserUrl` 打开右侧浏览器；Web 端仍走现有新标签 fallback。

状态与事件顺序：

```text
首次打开                         新建
面板关闭 ──open──> [z-code] ─────────────> [z-code] [z-code 2]
                       │ close                     │ close z-code 2
                       ▼                           ▼
                   面板关闭                    [z-code]
                  （session 保活）                  │ new
                       │ reopen                    ▼
                       └──────────────────────> [z-code] [z-code 2]

[z-code] [z-code 2] ──close z-code──> [z-code 2]
                                         │ new（已有名称不变，复用最小编号 1）
                                         ▼
                                   [z-code 2] [z-code]

[z-code] [z-code 2] ──PTY exit 2──> [z-code]
         │
         └─PTY exit 1（最后一个）──> 删除已结束 session ──> 面板关闭
                                                            │ reopen
                                                            ▼
                                                     新建 [z-code]

子命令 exit code != 0 ──shell 仍存活──> tab 不变
```

## 澄清记录

| 轮次 | 问题                      | 用户答案                                       | 固定边界                                        | 后续确认 |
| ---- | ------------------------- | ---------------------------------------------- | ----------------------------------------------- | -------- |
| 1    | 单 tab 关闭后的状态       | 关闭整个终端页面                               | 关闭面板而不是保留无 tab 状态或自动创建替代 tab | 否       |
| 1    | tab 基础名称与编号        | 当前 workspace 名；第二个为 workspace 名加 `2` | 编号 `1` 不显示，编号 `2` 起显示                | 否       |
| 1    | 关闭其他 tab 后是否重命名 | terminal 一旦创建就不改名                      | 名称随 session 生命周期稳定                     | 否       |
| 1    | 关闭编号 `2` 后再次新建   | 仍为 terminal `2`                              | 使用当前最小可用编号                            | 否       |
| 2    | 哪种 exit 自动关 tab      | 只在 terminal session 自身结束时               | 子命令失败不触发；正常和异常 shell exit 都触发  | 否       |
| 2    | exit 后是否保留提示       | 不保留                                         | 收到 PTY exit 后立即移除 tab                    | 否       |
| 2    | 最后一个 session 退出     | 关闭整个面板，下次打开新建 terminal            | 不保留已退出 session，也不在后台立即拉起新 PTY  | 否       |
| 2    | 后台与活动 tab 退出       | 后台只移除自身；活动 tab 切换到相邻 tab        | 不因后台 tab 退出抢焦点                         | 否       |
| 2    | terminal 启动失败         | 保留错误信息                                   | 启动失败不按 PTY exit 自动关闭                  | 否       |

## 领域范围与高风险交叉项

| 领域                                | 是否包含   | 决策                                                                                                    |
| ----------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------- |
| File/Git/Terminal UI                | 是         | 修改底部 Terminal tab 的 renderer 本地命名、关闭与编号分配                                              |
| UI shell / responsive               | 是         | 桌面端与手机 Web 共用 `Terminal` 组件，行为保持一致，不增加单端分支                                     |
| Workspace identity / remote runtime | 代表性验证 | workspace identity 非空时优先用于隔离，否则回退 workspace path；`workspacePath` 仍只用于 cwd 和名称显示 |
| Mobile replayable / conversation    | 剪枝       | 不修改 session/task stream、snapshot、queue、protocol 或 delivery kind                                  |
| 右侧 side pane Terminal             | 剪枝       | 已有独立 tab 模型，本次不修改                                                                           |

## 概念图与状态 owner

| 概念                        | 权威状态 / 代码入口                                         | 可观察证据                                     |
| --------------------------- | ----------------------------------------------------------- | ---------------------------------------------- |
| workspace terminal registry | `packages/ui/src/Terminal.tsx` 的 renderer state            | 当前 workspace 的 tab strip                    |
| session 编号与最小可用编号  | `packages/ui/src/terminal/terminalPanelState.ts`            | tab 标题和纯状态单测                           |
| PTY 生命周期                | `packages/ui/src/terminal/TerminalSession.tsx`              | 多 tab 关闭后组件卸载；单 tab 收起后组件仍挂载 |
| 面板开关                    | `packages/ui/src/hooks/useAppPanels.ts` 的 `isTerminalOpen` | Terminal 面板显隐                              |

## 状态维度与候选组合

| Case ID     | tab 状态               | 用户动作              | 预期效果                                         | 分类     |
| ----------- | ---------------------- | --------------------- | ------------------------------------------------ | -------- |
| TERM-TAB-01 | 首次创建，只有编号 `1` | 查看 tab 标题         | 显示 workspace 名，不显示 `1`                    | accepted |
| TERM-TAB-02 | 已有编号 `1`           | 新建 tab              | 新 tab 显示 `workspace 2`；首个 tab 名称不变     | accepted |
| TERM-TAB-03 | 已有编号 `1`、`2`      | 关闭编号 `2` 后再新建 | 新 tab 复用编号 `2`                              | accepted |
| TERM-TAB-04 | 已有编号 `1`、`2`      | 关闭编号 `1`          | 编号 `2` 保持原名，不改成基础名称                | accepted |
| TERM-TAB-05 | 只有一个 tab           | 点击 tab 关闭按钮     | 收起整个 Terminal 面板，session 保活             | accepted |
| TERM-TAB-06 | 多于一个 tab           | 关闭任意 tab          | 只释放目标 session；若关闭活动 tab，选择相邻 tab | accepted |
| TERM-TAB-07 | 多 tab，后台 PTY 存活  | 后台 PTY exit         | 移除退出 tab，活动 tab 与焦点不变                | accepted |
| TERM-TAB-08 | 多 tab，活动 PTY 存活  | 活动 PTY exit         | 移除退出 tab，激活相邻 tab                       | accepted |
| TERM-TAB-09 | 当前 workspace 单 tab  | PTY exit 后重新开面板 | 先关闭面板；重新打开时创建全新基础名称 tab       | accepted |
| TERM-TAB-10 | 隐藏 workspace 单 tab  | 隐藏 PTY exit         | 只清理隐藏 workspace，不关闭当前面板             | accepted |
| TERM-TAB-11 | shell 存活             | 子命令返回非 0        | 不产生 PTY exit，tab 保持                        | pruned   |
| TERM-TAB-12 | terminal create 失败   | Promise reject        | tab 保留启动错误，不自动关闭                     | accepted |

剪枝决定：主题、locale、桌面/手机 viewport 不改变命名与关闭状态机，只保留共享组件的代表性断言；本次没有协议、provider fixture、网络时序或 Docker 隔离需求。

## 覆盖计划

| Case                 | setup / action / assertion                                               | 证据层                           | 状态                       |
| -------------------- | ------------------------------------------------------------------------ | -------------------------------- | -------------------------- |
| TERM-TAB-01/02/03/04 | 构造 workspace terminal state，执行创建/关闭并断言稳定编号与标题         | renderer state + UI label helper | covered unit + runtime CDP |
| TERM-TAB-05          | 单 session 触发关闭，断言返回关闭面板意图且不删除 session                | renderer state + panel callback  | covered unit + runtime CDP |
| TERM-TAB-06          | 多 session 触发关闭，断言目标 session 删除、fallback active session 正确 | renderer state                   | covered unit + runtime CDP |
| TERM-TAB-07/08       | 多 session 触发 PTY exit，断言后台/活动 tab 的删除和 active fallback     | renderer state + exit event      | covered unit + runtime CDP |
| TERM-TAB-09/10       | 当前/隐藏 workspace 最后一个 PTY exit，断言面板关闭边界与懒重建          | renderer state + panel callback  | covered unit + runtime CDP |
| TERM-TAB-11/12       | 子命令失败不产生 exit；create reject 继续保留错误 tab                    | terminal service/event contract  | covered by invariant       |

E2E 交接：该变更不发送 provider 请求，不需要 replay/file fixture；若后续补桌面 E2E，应直接断言 tab 标题、关闭按钮、面板显隐和 PTY DOM 是否保活，并避免把右侧 side pane Terminal 纳入同一 case。

文件分层：

- `packages/ui/src/Terminal.tsx`：终端面板、workspace 会话注册表、tab UI。
- `packages/ui/src/terminal/TerminalSession.tsx`：单个 xterm 实例和后端 PTY 生命周期。
- `packages/ui/src/terminal/terminalPanelState.ts`：terminal tab/workspace 状态的纯数据辅助函数。
- `packages/ui/src/terminal/terminalLinks.ts`：terminal buffer 中 HTTP 链接识别和 xterm range 计算。
