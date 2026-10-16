# 定时任务工作区选择边界

## Feature/change summary

手动新建定时任务必须绑定真实项目。`AutomationEditView` 可以复用普通会话草稿的 workspace 菜单，但不能继承“切到非项目工作区”的入口。此次修正只收口调用方能力边界，不改变 workspace、session、stream、queue 或远控协议。

## Clarification log

| 问题                                            | 用户确认         | 固定边界                                        |
| ----------------------------------------------- | ---------------- | ----------------------------------------------- |
| 截图里的 `X` 应该全局隐藏，还是仅定时任务隐藏？ | 仅定时任务隐藏   | 普通会话恢复原 hover/focus 替换交互             |
| 定时任务下拉菜单是否允许「不在项目中工作」？    | 不允许           | 定时任务不能进入 conversation backing workspace |
| 其他入口是否跟随变化？                          | 其他地方保持正常 | 普通会话继续显示 `X` 和菜单项                   |

## Domain scope and state owners

| Domain                                | State owner                                                   | 本次处理                                                     |
| ------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------ |
| UI shell / workspace selector         | `ChatEmptyWorkspacePreviewMenu` props + renderer render state | 增加完整的 conversation-workspace selection capability guard |
| Automation form                       | `AutomationEditView`                                          | 明确关闭该 capability                                        |
| Conversation workspace                | `WorkspaceShellLayout` + tab purpose                          | 保持默认开启，不改 target 切换逻辑                           |
| Host / Agent / protocol / persistence | 既有 workspace/session authority                              | 不变；禁用入口发生在 renderer UI admission 之前              |

## State and event sequence

```text
ordinary draft                         manual automation form
      |                                         |
      | capability = enabled                    | capability = disabled
      v                                         v
hover/focus project chip                 hover/focus project chip
      |                                         |
      +-> project icon fades                    +-> project icon remains
      +-> detach X appears                      +-> no detach X
      +-> menu has work-outside-project         +-> menu omits work-outside-project
```

## Candidate combinations and pruning

| Candidate | Surface              | Capability     | Expected result                                            | Status                  |
| --------- | -------------------- | -------------- | ---------------------------------------------------------- | ----------------------- |
| AWS01     | 普通 project draft   | enabled        | `X` 与「不在项目中工作」均可用，hover/focus 时项目图标淡出 | accepted                |
| AWS02     | 手动新建定时任务     | disabled       | `X` 与「不在项目中工作」均不存在，项目图标常驻             | accepted                |
| AWS03     | 定时任务编辑已有任务 | workspace 锁定 | 继续使用 disabled button，不进入复用菜单                   | pruned：现有 edit guard |

主题、locale、操作系统不改变入口是否存在，由共享 class/i18n 合同覆盖，不做笛卡尔积。定时任务选择器已关闭远程入口，因此不与 SSH/WSL/Docker、`workspaceIdentity` 或 mobile replayable 恢复组合。普通会话的远端身份隔离继续由 CWP07/CWP08 覆盖。

## Accepted cases and evidence

| Case          | Setup                       | Action                     | Assertions                                        | Evidence                                                     | E2E status                                       |
| ------------- | --------------------------- | -------------------------- | ------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------ |
| CWP11 / AWS01 | 普通 project draft          | hover/focus chip，打开菜单 | 图标淡出 class 存在；detach 与 menu item 存在     | focused render test + DOM contract                           | partial-unit                                     |
| CWP11 / AWS02 | 手动新建定时任务 capability | hover/focus chip，打开菜单 | 图标淡出 class 不存在；detach 与 menu item 不存在 | focused render test + `AutomationEditView` capability wiring | partial-unit；desktop GUI representative missing |

## E2E handoff

后续 desktop GUI 代表 case 只需打开“定时任务 → 手动创建”，检查 workspace chip 和展开菜单；该路径不发送 prompt，provider request policy 应声明为 `none`。不需要 provider fixture、远端 workspace 或 SSE timing。
