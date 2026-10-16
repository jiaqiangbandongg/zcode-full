# 计划卡片与侧边栏详情

## 目标

`ExitPlanMode` 的计划既可能一次性完成，也可能通过 tool input 流式增长。主时间线使用紧凑计划卡片展示摘要；点击卡片或右上角展开按钮后，在 Side Pane 打开完整计划。主时间线不再原地展开，也不保留底部“展开计划”按钮。

计划详情只是同一父会话投影的只读视图，不创建 session、Agent runtime、owner、lease 或 command queue。桌面 Electron 与桌面 Web 读取既有 `desktop-continuous` 投影；手机 Web 仍只读取既有 `web-remote-replayable` snapshot/gap 恢复结果，不新增远控链路。

## 已确认产品语义

- 左上角固定显示“计划”，不显示工具原名或“套餐”。
- 右上角只显示复制；不显示展开、点赞、点踩。
- 正文预览底部 `bottom-6` 悬浮显示默认主按钮样式、`h-10 pl-6 !pr-4.5` 的胶囊按钮
  “查看完整计划 →”，替代原 header 展开按钮。
- 点击卡片非交互区域或底部“查看完整计划”按钮，行为一致：在 Side Pane 打开详情。
- 每个 `(workspaceKey, parentSessionId, toolCallId)` 对应一个稳定 tab；同一计划复用，不同计划可并存。
- tab 标题统一为本地化“计划”。
- Side Pane 显示完整计划，主时间线只显示裁切预览；没有原地展开状态。
- 计划卡片严格停留在 `ExitPlanMode` 对应的 tool row 位置，不提升到 assistant 轮尾。它位于最终正文之前时随同一段“已工作”历史折叠；展开后必须保持 CLI `rowId` 全序。
- 流式 `ExitPlanMode` 从首个可解析 `plan` 字段开始显示；卡片不展示行数或流式计数动画，详情随同一 projection 更新。
- 终态到达后保留最后一份非空正文，snapshot 字段缺失时仍沿用既有完整字段加载入口。
- assistant 轮尾动作栏的“复制”按本轮聚合：先复制全部 assistant 正文段，再追加同轮所有 `ExitPlanMode` 的完整 Markdown；不读取卡片裁切 DOM，也不包含其他工具结果。卡片自身的复制按钮仍只复制该计划。
- 右上角摘要新增独立“计划”分区，只列出当前有效 conversation 分支中已经进入 `success`、`error` 或 `cancelled` 终态且含有正文的 `ExitPlanMode`；流式、运行中和等待审批状态不进入目录。
- 计划目录按 `rowId` 从新到旧排序。点击目录项与点击时间线卡片一致，复用同一个 `(workspaceKey, parentSessionId, toolCallId)` Side Pane tab。
- 手机端沿用既有 Side Pane 抽屉；核心入口不因窄屏消失。
- 手机远控专用 `V4ChatPane` 必须与桌面 `V4WorkspaceChatArea` 一样接收
  `onOpenPlanDetail`；点击卡片或“查看完整计划”后只更新 renderer Side Pane 状态，
  不发送 task command，也不改变 `web-remote-replayable` 恢复链路。

## 状态与时序

```text
provider tool_input_start / delta / end
                  |
                  v
 shared partial JSON preview（识别 plan 字段）
                  |
                  v
 parent conversation projection
          |                    |
          |                    +--> Side Pane plan-detail tab
          |                         key = workspaceKey
          |                               + parentSessionId
          |                               + toolCallId
          v
 main timeline plan card
   - 原 tool row 位置
   - 计划
   - 复制 / 展开
   - 裁切预览

ExitPlanMode terminal / row.removed / snapshot
                  |
                  v
 renderer plan-directory revision
                  |
                  v
 v4/conversation/plans（CLI 全量有效投影）
                  |
                  v
 status panel「计划」目录（最新优先）

卡片点击 / 展开点击
   ---> 激活或创建稳定 tab
   ---> 展开 Side Pane
   ---> tab 继续订阅 parent projection

轮尾 assistant 复制
   ---> assistant text segments（原顺序）
   ---> ExitPlanMode markdown（同轮原顺序）
   ---> 以空行拼接后写入剪贴板

切换父任务
   ---> 按 parentSessionId 隐藏 / 恢复对应计划 tab
   ---> 不新建 runtime，不改 owner / queue / deliveryKind
```

## 状态所有权

| 状态 | 权威来源 | 生命周期 |
| --- | --- | --- |
| 计划正文与流式状态 | parent conversation projection 的 `ToolCallRow` | 跟随父 session |
| 计划目录 | CLI 当前有效 projection 的终态 `ExitPlanMode` query | 跟随父分支；edit/retry 裁枝后刷新 |
| plan detail tab 与激活项 | renderer workspace Side Pane memory | 当前窗口；不落盘 |
| tab 稳定身份 | `workspaceIdentity?.trim() \|\| workspacePath` + parent session + tool call | 当前窗口 |
| 最近一份非空计划正文 | plan detail 组件本地展示 fallback | tab 挂载期 |

## 交互与可访问性

- 卡片使用语义 token：`bg-card`、`border-card-border`、`text-foreground*`，并使用
  `rounded-xl` 强模块圆角，兼容全部主题。
- 卡片 header 与正文之间不显示分隔线，依靠紧凑间距维持层级。
- 卡片 header 使用 `NotepadText` 图标，图标与“计划”标题统一使用
  `text-foreground-subtle`，两者由 `flex items-center gap-2` 容器组合。
- 卡片 header 高度为 `h-10`，内容以 `items-start pt-4 px-4` 顶部对齐。
- 卡片整体可用键盘聚焦；Enter / Space 打开详情。
- 卡片键盘处理会忽略来自内部交互元素的 Enter / Space，避免底部按钮与整卡重复打开
  同一个 tab。
- 复制、查看完整计划、链接和正文内按钮阻止冒泡，不重复打开 tab；底部文字按钮直接以
  可见文案作为无障碍名称，不与整卡复用 `aria-label`。
- 图标按钮使用紧凑 `icon-xs` / `icon-sm` 尺寸并提供本地化 `aria-label`。
- 复制成功只改变按钮可访问名称与图标，不引入常驻 toast。
- 主时间线预览的正文节点同时承载 `max-h-64`、溢出裁切和底部 mask；前
  `30%` 完全可见，后 `70%` 渐隐，确保渐变按可见高度计算。空计划不显示计划卡片，
  Side Pane 仍展示完整正文。

## Case 与剪枝

| Case | 场景                                           | 预期                                                                                                                        | 决策     |
| ---- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | -------- |
| S06  | 完整 `ExitPlanMode` 计划                       | 卡片紧凑显示“计划”和复制，不显示行数；卡片/底部“查看完整计划”胶囊按钮打开同一详情 tab；无反馈按钮                            | accepted |
| S07  | `plan` 参数流式增长                            | 首个可解析片段即显示卡片，不展示流式计数动画；已打开详情同步增长并在终态一致                                                | accepted |
| S08  | 同一父任务有多个历史计划                       | 每个 `toolCallId` 独立 tab；重复点击同一计划复用；切任务隐藏/恢复且不串 workspace                                           | accepted |
| S09  | Electron、桌面 Web、手机 Web、明暗主题与中英文 | 共享卡片和 Side Pane 语义；手机复用既有 replayable 投影与抽屉，不另起 runtime                                               | accepted |
| S10  | 普通助手回复与 `ExitPlanMode` 已持久化后重启   | canonical `assistant_response` 仍按 UI/transcript 可见语义恢复；计划 tool row 保留完整 `plan` 并以只读 interrupted 历史展示 | accepted |
| S11  | 同一轮存在 assistant 正文与 `ExitPlanMode`     | 轮尾复制内容为全部 assistant 正文后追加完整计划 Markdown；不受卡片裁切影响，不混入其他工具结果                              | accepted |
| S12  | 计划后仍有 assistant、tool 或 reasoning 输出     | 计划卡片保持在原 `ExitPlanMode` row；“已工作”展开顺序等于 CLI row 全序，不固定到当前轮底部                                  | accepted |
| S13  | 当前有效分支存在多个已结束计划                   | 右上角“计划”按最新优先列出全部计划；标题取 Markdown H1/首个非空行；点击打开对应 Side Pane                                  | accepted |
| S14  | 计划处于流式/审批中，随后终态；或 edit/retry 裁枝 | 非终态不进摘要；终态后出现；`row.removed` 后从目录移除；迟到 query 不恢复旧计划                                             | accepted |
| S15  | 冷恢复、桌面 continuous、手机 remote replayable | 复用同一 CLI 全量投影 query 和 shared-host attachment；返回同一有效集合，不新增 runtime、owner、queue 或 replay 分支       | accepted |

剪枝：不把 `model × permission mode × goal × fork × queue` 与计划详情做笛卡尔积，因为详情和目录都只读既有 projection，不发送 session command。`success/error/cancelled` 共用同一终态过滤实现，组件测试枚举即可；远程 snapshot/gap 的恢复正确性继续由既有 replayable case 负责，S15 只证明 query 路由与 workspace identity 不串联。
