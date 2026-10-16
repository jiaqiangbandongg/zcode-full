# Plan Mode Status（当前事实）

旧 `PlanModeToolPanel` 和“计划/原始数据”tab 已删除。当前 plan/goal/todo 状态统一显示在 V4 `ConversationStatusPanel`；协作模式切换走 `switchCollaborationMode` 和 composer toolbar。

状态面板只渲染 projection，不持有独立计划事实，也不提供旧 raw-data tab。
