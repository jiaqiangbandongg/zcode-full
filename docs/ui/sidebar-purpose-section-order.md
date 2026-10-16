# Sidebar Purpose Section Order

## Feature Summary

| Field                 | Value                                                                                                                     |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Change                | `Project + By project` 中的“项目 / 任务”二级分区支持拖拽换位，并持久化用户顺序                                            |
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
  -> persist sectionOrder to localStorage
  -> restore on the next renderer mount

  -X-> Host / Agent / task snapshot / protocol
  -X-> mobile web-remote-replayable
  -X-> live broadcast to another open window
```

展开态跟随分区自身，不因换位改变：

```text
projects      -> projectsExpanded
conversations -> conversationsExpanded
```

## Domain Scope And Dimensions

| Dimension          | Values                                     | Decision                                                                |
| ------------------ | ------------------------------------------ | ----------------------------------------------------------------------- |
| Input              | mouse pointer / touch pointer / keyboard   | accepted，统一走专用 drag handle                                        |
| Section content    | non-empty / empty                          | accepted，都可拖                                                        |
| Section expansion  | expanded / collapsed                       | accepted，整体移动且保留原展开态                                        |
| Initial preference | missing / legacy / valid / corrupt         | accepted；missing、legacy、corrupt 使用默认 `projects -> conversations` |
| Surface            | Desktop / shared Web / mobile `/remote`    | 前两者 accepted 拖拽；mobile 只接受共享文案，拖拽 pruned，保持独立布局  |
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

## Accepted Case And Evidence

| Case             | Setup                                            | Action                                   | Assertions                                                                                                         | Evidence                                                 | E2E                                                                              |
| ---------------- | ------------------------------------------------ | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------- | -------------------------------------------------------------------------------- |
| CWP02 / SPO01-05 | fresh profile，仅 conversation backing workspace | 查看、折叠、拖拽“任务”到“项目”上方并重载 | 双语 section 语义正确；action 在 collapse trigger 外；专用手柄可访问；顺序和展开态独立持久化；无项目 workspace row | DOM order + `aria-expanded` + localStorage + remount DOM | 更新既有 `conversation-session-conversation-workspace.test.ts`；无 provider 请求 |

## E2E Handoff

- 复用正式 CWP02，不新建重复 case。
- 这是纯 renderer interaction，不产生 provider 请求；case-local fixture 为空并声明 `noProviderRequests`，不新增 provider response replay。
- pointer E2E 证明真实换位与重载恢复；keyboard/touch sensor 契约由 focused component/source test 覆盖。
- 不进入 Docker 新准入流程；继续沿用 CWP02 当前 suite 归属。
