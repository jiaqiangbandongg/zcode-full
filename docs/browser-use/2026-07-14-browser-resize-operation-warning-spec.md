# Browser Use 操作期间 resize 弱提示

## Feature/change summary

| Field                 | Value                                                                                           |
| --------------------- | ----------------------------------------------------------------------------------------------- |
| Change                | Browser Use 操作进行时，若用户或外部布局导致对应可见 tab 的浏览器区域实际尺寸变化，网页内容短暂变暗并在面板顶部显示一次非阻塞 warning 提示；模型主动打开 Browser 或 set/reset viewport 不提示 |
| User-visible surfaces | Desktop browser-use side-pane tab                                                               |
| Existing docs         | `2026-07-10-browser-use-codex-parity-spec.md`、`browser-use-codex-parity-coverage-matrix.md`    |
| Existing code owners  | `browserUseOperationUntil`（side-pane tab）、`UnifiedBrowserView`（浏览器区域）                 |
| Out of scope          | 中断工具、自动重做 snapshot、CUA 坐标修正、main/host/agent 协议变化、手机端独立 browser runtime |

## Clarification log

| Round | Question         | User answer                                  | Boundary fixed                                            | Follow-up needed |
| ----- | ---------------- | -------------------------------------------- | --------------------------------------------------------- | ---------------- |
| 1     | “执行中”的时机   | 与对应 tab 展示 Browser Use 鼠标图标动效一致 | 直接复用 `browserUseOperationUntil`，不建立第二份运行状态 | no               |
| 1     | 哪些 resize 触发 | 浏览器区域尺寸实际变化即触发                 | 使用 `ResizeObserver` 观察当前 browser content region     | no               |
| 1     | 提示形式         | 接受面板顶部、自动消失、不中断操作           | 使用弱提示，不要求确认                                    | no               |
| 1     | 连续 resize 去重 | 接受每次 active 周期最多一次                 | 连续拖拽不会刷新或堆叠提示                                | no               |
| 2     | 提示不够明显     | 确认提示期间让浏览器页面整体变暗             | 仅网页内容降低亮度，提示使用 warning 语义；地址栏不变暗   | no               |
| 3     | 全块 warning 样式与 ZCode 不搭 | 保持明显，但回归 ZCode 视觉系统 | 使用中性 popover、warning 局部强调和 `shadow-md`；网页亮度为 0.88 | no |
| 4     | 模型主动打开或改变浏览器尺寸是否提示 | 不应该提示“浏览器尺寸发生变化，可能影响当前自动操作” | Agent new/show/activate 与 viewport set/reset 静默；用户及外部布局 resize 仍提示 | no |
| 5     | Browser pane 已可见时，模型 `newTab` 完成后初始化布局继续收敛是否提示 | 仍属于模型主动打开 Browser，不应提示 | main 在真实 tab identity 解析后随 operation 事件显式标记布局基线重建；不能只依赖 `isVisible` 变化 | no |
| 6     | operation marker 后多帧异步布局是否只忽略第一帧 | 仍然不应提示 | marker 开启有界布局稳定期；稳定期内每次有效 observation 都更新 baseline 并延长短暂 quiet window，稳定后再恢复用户/外部 resize 告警 | no |

## Boundary decisions

| Boundary         | Decision                                      | Includes                           | Excludes / prunes                       | Source              |
| ---------------- | --------------------------------------------- | ---------------------------------- | --------------------------------------- | ------------------- |
| Active authority | 与鼠标图标使用同一 `browserUseOperationUntil` | 后续 operation 事件续期            | 根据 task phase 或 tool card 猜测状态   | user + current code |
| Resize target    | 可见 tab 的网页内容区域                       | 窗口、侧栏或布局导致的实际宽高变化 | 首次测量、隐藏/显示切换造成的零尺寸变化 | user + UI invariant |
| Resize source    | 只提示用户交互或外部布局引发的变化           | 自由尺寸开关/输入/拖拽、窗口和侧栏布局变化 | Agent ready/show/activate 与 `BrowserViewViewportChanged` 引发的已知变化 | user + platform event boundary |
| Agent layout marker | main 只给会打开、显示、激活或改变 viewport 的 Browser command 标记 `resetsResizeBaseline` | `newTab`、`activateTab`、`browserVisibilitySet(true)`、viewport set/reset | 普通 navigate/locator/screenshot/list 命令重建基线 | runtime trace + user boundary |
| Agent layout settlement | marker 后 300ms 为最小稳定期；期内每次有效 observation 把结束点至少延长到该 observation 后 100ms，且总稳定期封顶 500ms | side-pane 200ms 动画/宽度锁和 guest 挂载带来的多帧 resize | 整个 5s operation active 周期静默、无上限延长、只吞第一帧 | 2026-07-17 dev runtime trace |
| Frequency        | 一个连续 active 周期最多一次                  | active 结束后下一周期可再次提示    | 每个 ResizeObserver callback 都提示     | user                |
| Effect           | 网页内容轻度变暗，顶部中性 popover 提示自动消失 | `aria-live=polite`、filter 淡入淡出、warning 图标/强调线 | 全块 warning 填充、地址栏变暗、阻塞点击、确认、取消工具、强制刷新 snapshot | user + `DESIGN.md` |

## Domain scope and high-risk cross-products

| Domain                           | Include? | Why it can change behavior                                  | Primary sources                            |
| -------------------------------- | -------- | ----------------------------------------------------------- | ------------------------------------------ |
| UI shell/theme/locale/responsive | yes      | 提示需要支持尺寸变化、主题和中英文                          | `DESIGN.md`、`UnifiedBrowserView.tsx`      |
| Permission/tool UI               | yes      | active 必须与 tab-specific browser operation indicator 同源 | `useAppPanels.ts`、`BrowserUseTabIcon.tsx` |
| Mobile remote/replayable         | no       | 当前 IAB pane 为 desktop UI；不新增远控状态                 | browser-use parity spec                    |
| Architecture/process boundary    | no       | 现有 operation event 已提供所需状态，不改协议               | `workspaceSidePane.ts`                     |

高风险交叉保留 `active × visible × size changed × source`。主题、locale 和平台不改变触发语义，分别通过语义 token、i18n 和 `ResizeObserver` 平台能力折叠。

## Concept map and state owners

| Concept              | State owner                                          | Why it matters                     | Evidence                         |
| -------------------- | ---------------------------------------------------- | ---------------------------------- | -------------------------------- |
| Browser Use active   | renderer side-pane tab 的 `browserUseOperationUntil` | 与鼠标图标动效保持同一时间边界     | icon 与 warning 同用 active hook |
| Browser region size  | `ResizeObserver` 当前 observation                    | 只依据实际内容区域宽高变化         | observer entry                   |
| Resize source        | Agent platform event 或 renderer 用户/布局事件       | 区分模型已知变化与未知变化         | ready/visibility/viewport event + UI action |
| Agent layout baseline version | renderer side-pane tab 的单调版本号                 | main 明确标记布局命令后递增；目标 view 在 layout effect 阶段清 observation baseline 并开启有界稳定期 | `BrowserViewOperation` + side-pane tab local state |
| Agent layout settle deadline | `UnifiedBrowserView` local ref | 多帧初始化时持续吸收模型已知 resize；最小 300ms，活跃 observation 后 quiet 100ms，总计最多 500ms | runtime trace + `ResizeObserver` |
| 本 active 周期已提示 | `UnifiedBrowserView` local ref/state                 | 连续拖拽去重，不跨 tab/周期传播    | UI test                          |
| 提示可见性           | `UnifiedBrowserView` local state                     | 同时驱动 warning banner 与 webview brightness；不进入持久化、snapshot 或 realtime | `role=status` UI + webview data attribute |

## Dimensions and candidate combinations

| Candidate ID | Active | Tab visibility | Observation               | Expected effect                          | Status                      |
| ------------ | ------ | -------------- | ------------------------- | ---------------------------------------- | --------------------------- |
| BRW-001      | yes    | visible        | baseline 后宽或高变化     | 网页内容短暂变暗并显示一次中性 popover；warning 仅作局部强调；连续变化不堆叠；自动恢复 | accepted                    |
| BRW-002      | no     | visible        | 宽或高变化                | 仅更新尺寸基线，不提示                   | accepted                    |
| BRW-003      | yes/no | hidden         | resize / display 切换     | 不提示；重新可见后先建立基线             | pruned                      |
| BRW-004      | yes    | visible        | observer 首次回调         | 只建立基线，不提示                       | pruned                      |
| BRW-005      | yes    | visible        | 尺寸未变化的重复回调      | 不提示                                   | pruned                      |
| BRW-006      | yes    | visible        | resize 后执行 locator/CUA | 不改变工具执行或 snapshot 语义           | ignored（本功能仅告知风险） |
| BRW-007      | yes    | hidden/visible | Agent new/show/activate   | 展开或激活 Browser，但不显示提示、不变暗网页 | accepted                    |
| BRW-008      | yes    | visible        | Agent viewport set/reset  | 同步自由尺寸 UI 和实际 viewport，但不显示提示、不变暗网页 | accepted                    |
| BRW-009      | yes    | visible        | Agent 变化后再由用户 resize | 用户变化仍显示一次提示；Agent 静默不能消费本 active 周期的提示额度 | accepted                    |
| BRW-010      | yes    | already visible | Agent `newTab` 返回后初始化 region 多帧变化 | operation 事件开启目标 tab 的有界布局稳定期；期内持续更新基线且不显示提示；稳定后用户 resize 仍提示 | accepted                    |

## Pruning decisions and unresolved questions

| Decision ID | Pruned combinations       | Guard/invariant                           | Product reason         | Representative coverage |
| ----------- | ------------------------- | ----------------------------------------- | ---------------------- | ----------------------- |
| BRW-P01     | hidden、零尺寸、首次测量  | 必须有可见非零 baseline 和真实 size delta | 避免切 tab/初挂载误报  | BRW-002/003/004         |
| BRW-P02     | 同 active 周期后续 resize | `warnedForActiveCycle`                    | 连续拖拽只需一次弱提示 | BRW-001                 |
| BRW-P03     | Agent 主动 new/show/activate | 可见性切换同步清空旧 observation baseline | Browser 展开是模型当前操作的一部分，且隐藏/显示本就不应提示 | BRW-007                  |
| BRW-P04     | Agent 主动 viewport set/reset | `BrowserViewViewportChanged` 是 Agent 专用同步事件；renderer 手动更新不回发该事件 | Agent 已知自己改变了坐标系，不需要反向提醒 | BRW-008/009              |
| BRW-P05     | pane 已可见的 Agent `newTab` 初始化收敛 | `newTab` operation 在命令成功并解析真实 tabId 后携带 baseline reset marker；renderer 使用 300ms 最小稳定期 + observation 后 100ms quiet window，并在 500ms 强制恢复告警 | `isVisible` 始终为 true，且一次性清空 baseline 只能吞掉第一帧，不能作为完整防误报方案 | BRW-010                  |

无未决产品问题。

## Accepted cases and coverage matrix handoff

| Case ID | Setup                                                          | Action                               | Assertions                                           | Evidence layers | E2E status                                                                          |
| ------- | -------------------------------------------------------------- | ------------------------------------ | ---------------------------------------------------- | --------------- | ----------------------------------------------------------------------------------- |
| BRW-001 | 可见 browser-use tab，operation indicator active，已有尺寸基线 | 连续改变 browser content region 尺寸 | webview 亮度降至 0.88；顶部出现中性 popover，warning 图标/强调线清晰可见；无整块 warning 填充；地址栏与点击不受影响；两者自动恢复 | UI state + DOM  | automated：`packages/ui/test/UnifiedBrowserView.test.ts`                            |
| BRW-002 | indicator inactive 或 tab hidden                               | 改变区域尺寸                         | 不出现提示；重新可见仅建立新基线                     | UI state + DOM  | automated：`packages/ui/test/UnifiedBrowserView.test.ts`；hidden desktop smoke 待补 |
| BRW-007 | operation active，模型创建/显示/激活目标 Browser tab           | tab 从 hidden/unmounted 变为 visible | 同步建立新尺寸基线；不出现提示、不降低网页亮度       | platform event + UI state + DOM | automated：`packages/ui/test/UnifiedBrowserView.test.ts` |
| BRW-008 | 可见 browser-use tab，operation active                         | Agent 调用 viewport set/reset         | 自由尺寸 UI 正常联动；不出现提示、不降低网页亮度     | platform event + UI state + DOM | automated：`packages/ui/test/UnifiedBrowserView.test.ts` |
| BRW-009 | BRW-007/008 完成后仍处于同一 active 周期                       | 用户切换/输入/拖拽自由尺寸            | 出现一次提示并降低网页亮度                           | UI action + DOM | automated：`packages/ui/test/UnifiedBrowserView.test.ts` |
| BRW-010 | Browser pane 已可见，已有 tab；目标 session 开始 `newTab`      | ready/visibility 先创建目标 view，命令成功后投递带 baseline reset marker 的 operation，初始化 region 在 200ms 动画/挂载期间连续多帧变化 | 稳定期内不出现提示、不降低网页亮度；稳定期结束后再发生用户/外部 resize 时正常提示 | main IPC + side-pane state + ResizeObserver + timer + DOM | automated：desktop operation marker + workspace side-pane reducer + `UnifiedBrowserView` component；runtime trace |

```text
main newTab                  renderer side pane                 target view
    | ready / visibility ---------->| mount + first baseline -------->|
    | newTab result(real tabId)      |                                |
    | operation(reset baseline) ---->| increment baseline version ---->|
    |                                | clear baseline + settle 300ms  |
    |                                |<---- init ResizeObserver #1 ----|
    |                                | update baseline; quiet +100ms  |
    |                                |<---- init ResizeObserver #2 ----|
    |                                | update baseline; quiet +100ms  |
    |                                |                                |
    |                                | settle deadline elapsed         |
    |                                |<---- user/external resize ------|
    |                                | warn once in active cycle       |
```

覆盖矩阵新增 BCP-183。该交互不依赖 provider、文件 fixture、Docker 或 replayable 恢复；使用 jsdom `ResizeObserver` fake 做确定性组件测试，并检查 dimming data attribute 与 reduced-motion CSS contract。真实拖拽和 webview 合成效果作为 desktop smoke 风险项。
