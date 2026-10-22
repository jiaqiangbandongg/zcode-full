# 项目拖拽插入线

## 行为

- 拖动侧栏项目到可排序的另一项目时，在目标边缘显示 2px 蓝线，左端为 8px 空心圆；采用 `icon-blue` 主题 token，左右随侧栏宽度伸缩。
- 向上排序显示在目标项目之前，向下排序显示在目标项目之后；位置跟随原有排序位移动画，展开项目按整个项目节点边界显示，不能落进任务行。
- 只提示同置顶分区（可跨 Host）内的有效项目排序；原位置、不可排序项目和原生任务拖入不显示。指针与键盘共用提示，释放或 Escape 取消立即清除。
- 指示线不占布局、不拦截指针、对辅助技术隐藏；保留项目折叠、菜单、文件入口和原排序动画。

## 所有权与边界

直接从现有 `useSortable` 的 active / over / index 派生显示，不新增 React 状态、计时器或持久化字段。当前控制端侧栏偏好是显示顺序的唯一 owner；提交复用 preferences.reorder，以 (hostId, projectId) 保存，本地与离线远端可以混排，不写远端 position。

```text
指针 / 键盘 → dnd-kit active + over → 目标边缘蓝线
                                  → 松手 → preferences.reorder → 控制端 → readTree
                                  → Escape → 清除暂态
```

桌面与手机共用 ProjectNode；不改变 shared-host、workspaceIdentity、desktop continuous 或 mobile replayable 边界，不涉及协议和 migration。使用两种主题和窄屏布局验收，不把 390px 桌面模拟等同真实手机远控验证。

## 验收

扩展 VP31 pending E2E：拖动前无指示线；向下指针拖动、向上键盘拖动分别显示唯一正确目标和方向；检查线宽、主题颜色、空心圆、布局边界；取消和提交后清除，刷新顺序保留。截图覆盖明暗主题与 390px 布局。

## 验证记录（2026-09-15）

- Electron `desktop-e2e-20260915035627450-p99736-fbdae0bb806b2ae3`：6/6 通过；已检查 1200px / 390px 的 Zai Light、Zai Dark 插入线截图。窄屏先等待原有自动收起策略完成，再通过侧栏按钮重新展开。
- 实际开发应用通过 CDP 确认拖动时显示插入线、Escape 清除；未提交项目顺序变更。
- `pnpm typecheck`、`pnpm lint`、desktop `typecheck:e2e`、fixture check 与 HEAD 增量架构检查通过。lint 保留 48 个既有 warnings；全分支架构检查开工时已有 `resolveConversationWorkspaceTarget.ts` unmanaged-new-file，与本次无关。
- 用例保留 pending；真实手机 shared-host、SSH/WSL、Windows/Linux GUI 未执行。本次只修改 UI 展示，不改变主机通信和持久化。

## 拖拽渲染预算（2026-09-15）

用户 Trace-20260915T121805：启动时 41 个项目连续渲染 4 轮，含 656 次 ControlHintTooltip 渲染；最长主线程任务 1410ms，布局约 6ms，其余主要为 React 与 DEV 调试记录。原因是 useSortable 的 context 更新直接进入完整项目内容。

- ProjectNode 的排序外壳独占 useSortable 订阅、节点 ref、位移与插入线；标题/操作菜单/任务内容设为独立 memo 边界，不订阅拖拽 context。只将稳定的 activator ref、listeners、attributes 传给标题；激活状态变化最多刷新当前活动项目内容，目标和旁观项目内容保持复用。
- 保留 props 的正常浅比较：项目、任务、可用性、折叠、回调变化必须及时更新；不使用忽略函数的比较器、不保存第二份项目数据、不通过延迟或关闭调试记录掩盖卡顿。
- 排序 data 只随 hostId/pinned 改变。保持同置顶分区判定，允许跨 Host、键盘 ARIA、原生任务拖入及展开项目的整块位移。

```text
Pointer/Keyboard → DndContext → ProjectNode 外壳（transform / 插入线）
项目投影 / 操作回调 ──────────→ memo 项目内容（标题 / 菜单 / 任务）
松手 → preferences.reorder → 控制端侧栏偏好；Escape → 清除暂态
```

验收：单测模拟 41 个节点的激活、移动、换目标和取消，旁观节点不重复渲染提示框/任务内容，活动项的 ARIA 与最新回调正常；VP31 在隔离 HOME 补充至少 41 项真实指针拖动、蓝线、取消和帧间隔/longtask 采样。发布构建拖拽采样最大帧间隔小于 100ms；性能数值随环境变化，保留原始指标并用同条件开发应用录制比较。既有键盘排序持久化、两种主题、390px 和菜单回归继续执行。共享 UI 生效于桌面/Web；不更改手机 replayable、Host/CLI、协议或 migration。

### 性能修复验证

- 同一开发应用、41 项、相同指针激活→向上落点→Escape 手势，使用 PerformanceObserver + rAF 采样（不与用户带 CPU profiler 的原 Trace 直接比较）：修改前最大帧间隔 366.6ms、最长 longtask 387ms、ControlHintTooltip 1152 次；修改后两次为 67.6/34.1ms、77/59ms、均 8 次。前后项目顺序一致，蓝线出现且取消清除。
- 最终发布构建 Electron run `desktop-e2e-20260915044016567-p17170-a27487f8d3a22534`：7/7 通过；性能 fixture 实际 42 项（含初始化项目），最大帧间隔 17.6ms、无 longtask，原始指标在该 run 的 `project-drag-performance.json`。已检查 1200px 深色及 390px 浅色插入线截图。
- 新单测先红：单次激活触发 164 次 tooltip；修复后激活/取消各最多 4 次，位移/换目标 0 次，项目标题和最新操作回调仍更新。4 个相关测试文件 16/16 通过。
- 同步旧 Server 单测的标题 ARIA 断言：沿用上一主目录可用性修复的 `aria-disabled={!canOpen}`，标题可展开时为 false；排序禁用仍由 useSortable.disabled 控制，本次未更改此产品语义。
- root typecheck、desktop typecheck:e2e、lint（48 个既有 warnings，0 errors）、fixture check、格式及 HEAD 增量架构检查通过。全分支仍有开工前的 `resolveConversationWorkspaceTarget.ts` unmanaged-new-file，未增加违规。
- 用例仍为 pending；未运行真实手机 shared-host、SSH/WSL、Windows/Linux GUI。只调整共享 UI 渲染边界，不改数据/通信语义。
