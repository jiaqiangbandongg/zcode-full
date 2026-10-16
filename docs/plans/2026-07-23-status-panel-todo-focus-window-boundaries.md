# Status Panel Todo Focus Window Boundaries

## Feature Summary

| Field                 | Value                                                                                                      |
| --------------------- | ---------------------------------------------------------------------------------------------------------- |
| Change                | 恢复原设计定义的 Status Panel Todo 精简窗口，而不是固定前 4 条后整体展开                                 |
| User-visible surfaces | V4 `ConversationStatusPanel` 的“进程”区块                                                                  |
| Existing docs         | `docs/ui/chat-summary-panel.md`、SP case catalog / coverage matrix                                         |
| Existing code owners  | `ConversationStatusPanel.tsx` renderer-local 展示状态；`conversationStatusPanelModel.ts` 保留完整 snapshot |
| Out of scope          | CLI TodoWrite、session projection、持久化、desktop continuous / mobile replayable 交付协议                 |

## Clarification Log

| Round | Question                               | User answer                    | Boundary fixed                                       | Follow-up needed |
| ----- | -------------------------------------- | ------------------------------ | ---------------------------------------------------- | ---------------- |
| 1     | 是否恢复“显示 4 条”                    | 确认恢复                       | 先发现 V4 曾硬截断 4 条                              | no               |
| 2     | 简化为前 4 条 + 显示更多是否等同旧设计 | 用户指出与原设计定义差异很大 | 简化实现判定为 bug-candidate                         | no               |
| 3     | 是否按原设计交互完成             | “确认，使用 goal 完成”         | 采用 `>6` 聚焦 3 条、上下独立折叠、snapshot 更新重置 | no               |

## Boundary Decisions

| Boundary      | Decision                                    | Includes                        | Excludes / prunes               | Source                 |
| ------------- | ------------------------------------------- | ------------------------------- | ------------------------------- | ---------------------- |
| 精简阈值      | Todo 总数 `> 6` 时才精简                    | 0-6 条完整显示                  | 固定 4 条窗口                   | `6f32518d4c` + user    |
| 聚焦点        | 优先 `inProgress`，否则首个未完成，否则尾部 | 聚焦项及相邻后续上下文          | completed-first 重排            | `5728558169` + user    |
| 默认窗口      | 保持原序的连续 3 条；靠近末尾时向前回填     | 最少 3 条（总数允许时）         | 永远“当前 + 后两条”导致末尾不足 | `da2360cfa0`           |
| 折叠分组      | 窗口前后两组独立展开 / 收起                 | 原位置动画、计数文案            | 单一“显示更多”整体开关          | `55f4f6c999` + user    |
| snapshot 更新 | id / content / status 变化后两组恢复收起    | renderer-local reset            | 写 session、store 或 protocol   | user + legacy behavior |
| 多端          | 桌面与手机 Web 复用同一 renderer 算法       | responsive shell 继续按既有边界 | replayable/continuous 业务叉乘  | renderer invariant     |

## Domain Scope

| Domain                  | Include?            | Why it can change behavior     | Primary sources                  |
| ----------------------- | ------------------- | ------------------------------ | -------------------------------- |
| Conversation/session UI | yes                 | Todo snapshot 驱动可见窗口     | protocol declaration、SP catalog |
| UI shell / responsive   | yes                 | 长文案、折叠行与区块滚动高度   | `DESIGN.md`、chat summary spec   |
| Persistence / protocol  | no                  | 本次不新增权威状态             | renderer-local invariant         |
| Mobile replay recovery  | representative only | 同一 snapshot 重建相同默认窗口 | SP08 边界                        |

## Concept Map And State Owners

```text
CLI TodoWrite snapshot
        |
        v
ConversationStatusPanelModel.displayItems  (完整原序，权威 UI 输入)
        |
        v
Todo focus partition                   (纯派生)
  completed-prefix | focus-window | waiting-suffix
        |                 |
        +---- renderer-local open state ----+
                         |
                         v
              StatusSection scroll viewport
```

| State / fact          | Authority                           | Mirrors / caches                  | Evidence                                   |
| --------------------- | ----------------------------------- | --------------------------------- | ------------------------------------------ |
| Todo 内容、顺序、状态 | V4 `PlanState.items` snapshot       | status panel model                | model unit test                            |
| 三段窗口边界          | pure partition helper               | none                              | focused unit test                          |
| 上下折叠开关          | `PlanStatusItems` React local state | none                              | component interaction / runtime DOM        |
| delivery profile      | host attachment                     | renderer receives same projection | existing SP08; pruned from business matrix |

## Candidate Combinations And Pruning

| Candidate ID | State                                              | Event                           | Expected effect                      | Status   |
| ------------ | -------------------------------------------------- | ------------------------------- | ------------------------------------ | -------- |
| TFW01        | 0-6 Todo                                           | render                          | 全部按 snapshot 原序展示，无分组开关 | accepted |
| TFW02        | >6，存在 inProgress，位于中部                      | render                          | 聚焦连续 3 条，前后折叠              | accepted |
| TFW03        | >6，inProgress 位于末尾                            | render                          | 从前回填，仍展示连续 3 条            | accepted |
| TFW04        | >6，无 inProgress，有 pending                      | render                          | 聚焦第一个未完成项                   | accepted |
| TFW05        | >6，全部 completed                                 | render                          | 聚焦最后 3 条，前缀可展开            | accepted |
| TFW06        | compact 状态                                       | 展开上 / 下分组                 | 两组独立改变，不影响另一组或原始顺序 | accepted |
| TFW07        | 任意分组已展开                                     | snapshot id/content/status 更新 | 两组重置收起并重新计算窗口           | accepted |
| TFW08        | desktop / mobile、local / remote、provider / model | 同一 snapshot                   | renderer 结果相同，不做业务全排列    | pruned   |

剪枝理由：Todo focus window 只消费 `PlanState.items`，不发送 command，也不读 workspace、provider、
delivery profile 或持久化来源。桌面 continuous 与手机 replayable 只影响 snapshot 如何到达，不改变
同一 snapshot 的派生结果；用 pure helper + renderer component 代表覆盖，移动 overlay 继续由 SP08 专项负责。

## Accepted Cases

| Case ID | Setup                                | Action                      | Assertions                                  | Evidence layers         | E2E status |
| ------- | ------------------------------------ | --------------------------- | ------------------------------------------- | ----------------------- | ---------- |
| SP14    | 6 条及以下混合状态 Todo              | 展开进程                    | 全部按原序可见、无折叠计数行                | UI + model              | planned    |
| SP15    | 7 条以上且当前项分别位于首 / 中 / 尾 | 展开进程                    | 连续 3 条窗口定位正确，尾部向前回填         | UI + pure partition     | planned    |
| SP16    | 聚焦窗口前后均有项目                 | 独立点击上下折叠行          | 对应组展开 / 收起，另一组状态不变，顺序不变 | UI + model              | planned    |
| SP17    | 任一折叠组已展开                     | Todo id/content/status 更新 | 两组恢复收起，窗口按新 snapshot 重算        | UI + snapshot signature | planned    |

## E2E Handoff Notes

- Provider fixture：后续正式 E2E 可用 TodoWrite replay 产生 7 条 Todo，并更新中部状态。
- File-system fixture：不需要。
- Timing strategy：纯 renderer 交互不依赖慢 SSE；snapshot 更新 case 使用两次确定性 projection。
- Review risks：必须量测双行长文案下折叠行仍可见，且手机 overlay 不横向溢出。
- 当前实现阶段以 focused component/model test 与 desktop CDP runtime inspection 为主，不把 planned
  误报为正式 E2E covered。
