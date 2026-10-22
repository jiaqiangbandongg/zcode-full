# Sidebar Purpose Section Order

## 当前交互修订（2026-09-15）

本节替代下文历史设计的「专用手柄」约定。当前 ProjectSidebar 共用 PurposeSections 与 WorkspacePurposeSection：

- 「项目」「任务」直接从标题文字或标题空白区域拖动，删除右侧六点按钮。点击仍只折叠当前分区；右侧新建按钮独立，不激活拖拽或折叠。
- 沿用项目排序的 PointerSensor（移动 6px 后激活）与 KeyboardSensor；标题聚焦后 Space 开始、方向键移动、Space 提交、Escape 取消。触摸标题可拖动，内容区继续滚动。
- 从同一 useSortable active / over / index 派生唯一目标插入线：向上在目标之前、向下在目标之后，整块展开内容一起移动。线使用项目排序的 2px icon-blue 与 8px 空心圆；不占布局、不拦截指针，释放/取消清除。
- 分区位移约束到纵轴；侧栏列表显式禁止横向滚动，保留纵向滚动。拖出侧栏右边也不能撑宽滚动容器或产生横向滚动条。
- 唯一已提交顺序仍为 renderer-local sectionOrder；无有效换位时不写偏好。折叠值、任务/项目内容不随排序改变，不新增持久化或计时器。

```text
标题 Pointer / Touch / Keyboard → dnd-kit active / over（纵轴）→ 目标边缘蓝线
                                                           ├─ 提交 → 原 sectionOrder 偏好
                                                           └─ 取消 → 清除暂态
标题点击 → 原折叠偏好；右侧操作 → 原新建回调
```

共享 UI 同时用于桌面/Web；只约束侧栏展示，不改变 Host/CLI、workspaceIdentity、desktop continuous 或 mobile replayable。390px 桌面验证代表窄屏布局，不代表真实手机 shared-host 验证。

验收：CWP02 更新标题触发断言；补充 pending 交互回归覆盖上下排序、展开/收起、点击/新建隔离、键盘取消/提交、重载持久化，明暗主题与窄屏下蓝线及拖到右侧无横向溢出。无模型请求。

### 本次验证

- 开发应用 CDP：修复前右拖让侧栏从 409px 撑到 1060px；修复后同类手势横向位移为 0、内容宽度等于可视宽度（264px），蓝线出现且 Escape 清除。
- Electron pending run `desktop-e2e-20260915121039329-p28373-70b1989f9323c47a`：4/4 通过，已检查 1200px 深色和 390px 浅色截图；涵盖标题指针/键盘排序、取消/提交、重载、折叠与操作隔离、明暗主题和无水平溢出。
- 原有 CWP02 formal run `desktop-e2e-20260915121257994-p30885-947e07257bcefaa2`：1/1 通过。两份 fixture check 通过，新增用例保持 pending。
- 18 项相关单测、root typecheck、desktop typecheck:e2e、lint（47 个既有 warnings / 0 errors）、格式及 HEAD 增量架构检查通过。默认全分支架构检查仍有开工前的 `resolveConversationWorkspaceTarget.ts` unmanaged-new-file。
- 真实手机 shared-host、触屏硬件、Windows/Linux GUI 未运行；本次仅改变共享侧栏交互与布局，不更改通信和任务数据。

## Feature Summary

| Field                 | Value                                                                                                                     |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Change                | `Project + By project` 中的“项目 / 任务”二级分区支持拖拽换位，并持久化用户顺序；多设备共用顺序，但各设备独立折叠展开 |
| User-visible surfaces | Desktop 与共享 Web workspace sidebar；共享 task-purpose 标签同步显示为“任务 / Tasks”                                      |
| Existing docs         | `docs/ui/sidebar-task-view-switcher.md`、`docs/superpowers/specs/2026-07-10-non-project-conversation-workspace-design.md` |
| State owner           | Renderer-local `zcode-sidebar-purpose-section-preferences`                                                                |
| Out of scope          | 手机 `/remote` 拖拽布局、跨窗口实时同步、Host/Agent/protocol 状态、其它“对话”文案                                         |

内部 `workspacePurpose=conversation` 语义保持不变；把共享的 task-purpose 分区/工作区标签及桌面侧栏空态、创建入口文案从
“对话 / Conversations”调整为“任务 / Tasks”。手机 `/remote` 可复用新标签，但不获得拖拽入口。

## Clarification Log

| Round | Question                                                                    | User answer      | Boundary fixed                                                                                        |
| ----- | --------------------------------------------------------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------- |
| 1     | 排序是否持久化、拖拽入口、输入方式、多端范围、同步范围、空/收起分区是否可拖 | 按推荐方案       | renderer-local 持久化；专用手柄；鼠标/触摸/键盘；Desktop/共享 Web；不实时跨窗口同步；整个分区始终可拖 |
| 2     | 是否同时调整分区文案                                                        | “对话”改成“任务” | 只调整该侧栏分区相关文案，不改 conversation 产品/协议语义                                             |

## State And Sync Boundary

```text
pointer / touch / keyboard drag handle
  -> reorder [projects, conversations]
  -> update current renderer immediately
  -> apply the same order inside every visible device group
  -> persist sectionOrder to localStorage
  -> restore on the next renderer mount

  -X-> Host / Agent / task snapshot / protocol
  -X-> mobile web-remote-replayable
  -X-> live broadcast to another open window
```

展开态跟随“设备 × 分区”，不因换位或其它设备的点击改变；只有未显示设备层级时才继续使用顶层兼容偏好：

```text
local           -> projects / conversations
server:<id>     -> projects / conversations
pending:<route> -> projects / conversations

点击 server:A / projects
  -> 只更新 server:A / projects
  -X-> local / projects
  -X-> server:B / projects
```

## Domain Scope And Dimensions

| Dimension          | Values                                     | Decision                                                                |
| ------------------ | ------------------------------------------ | ----------------------------------------------------------------------- |
| Input              | mouse pointer / touch pointer / keyboard   | accepted，统一走专用 drag handle                                        |
| Section content    | non-empty / empty                          | accepted，都可拖                                                        |
| Section expansion  | expanded / collapsed                       | accepted，按设备独立持久化；整体移动且保留各设备原展开态                 |
| Initial preference | missing / legacy / valid / corrupt         | accepted；missing、legacy、corrupt 使用默认 `projects -> conversations` |
| Surface            | Desktop / shared Web / mobile `/remote`    | 前两者 accepted 拖拽；多设备内共享一份顺序；mobile 只接受共享文案，拖拽 pruned，保持独立布局 |
| Window             | current / another open renderer / remount  | 当前立即更新；另一窗口实时同步 pruned；remount 恢复 accepted            |
| Runtime delivery   | desktop-continuous / web-remote-replayable | ignored；排序不进入 runtime/realtime 链路                               |
| Theme / locale     | Zai Light / Zai Dark；zh-CN / en-US        | accepted；使用现有语义 token 与双语文案                                 |

## Candidate And Pruning Decisions

| Candidate | Setup / action             | Expected result                                        | Status                                      |
| --------- | -------------------------- | ------------------------------------------------------ | ------------------------------------------- |
| SPO01     | 默认偏好查看侧栏           | 项目在任务上方，两个分区默认展开                       | accepted                                    |
| SPO02     | 从任务分区手柄拖到项目上方 | 整个任务分区换位，展开态和内容不变，顺序写入本地偏好   | accepted                                    |
| SPO03     | 刷新或重启 renderer        | 恢复任务在项目上方                                     | accepted                                    |
| SPO04     | 收起或空分区后拖拽         | 仍可换位；不清理缓存、workspace/task 顺序或展开态      | accepted                                    |
| SPO05     | 键盘聚焦手柄并排序         | 与 pointer 排序得到相同结果，手柄具有可读 `aria-label` | accepted                                    |
| SPO06     | 在另一个已打开窗口观察顺序 | 不要求实时变化；该窗口下次挂载读取持久化值             | pruned，renderer-local 偏好不新增 broadcast |
| SPO07     | 手机 `/remote` 查看或拖拽  | task-purpose 标签显示“任务”，但不提供拖拽入口，不改变 replayable 恢复 | copy accepted；drag pruned，独立移动端布局  |
| SPO08     | 修改全产品其它“对话”文案   | 保持原文案                                             | ignored，本次只调整 sidebar purpose section |
| SPO09     | 任一设备内拖动项目/任务顺序 | 所有设备内同步使用同一顺序，不新增 per-device 排序偏好 | accepted，保持单一 renderer-local owner      |
| SPO10     | 任一设备内折叠项目或任务     | 仅该设备的对应分区折叠，其它设备展开态不变并独立持久化 | accepted，按 Source group key 隔离展开态      |

## Accepted Case And Evidence

| Case             | Setup                                            | Action                                   | Assertions                                                                                                         | Evidence                                                 | E2E                                                                              |
| ---------------- | ------------------------------------------------ | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------- | -------------------------------------------------------------------------------- |
| CWP02 / SPO01-05 | fresh profile，仅 conversation backing workspace | 查看、折叠、拖拽“任务”到“项目”上方并重载 | 双语 section 语义正确；action 在 collapse trigger 外；专用手柄可访问；顺序和展开态独立持久化；无项目 workspace row | DOM order + `aria-expanded` + localStorage + remount DOM | 更新既有 `conversation-session-conversation-workspace.test.ts`；无 provider 请求 |

## E2E Handoff

- 复用正式 CWP02，不新建重复 case。
- 这是纯 renderer interaction，不产生 provider 请求；case-local fixture 为空并声明 `noProviderRequests`，不新增 provider response replay。
- pointer E2E 证明真实换位与重载恢复；keyboard/touch sensor 契约由 focused component/source test 覆盖。
- 不进入 Docker 新准入流程；继续沿用 CWP02 当前 suite 归属。
