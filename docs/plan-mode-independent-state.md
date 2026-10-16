# Plan 独立执行状态（Todo151）

本 spec 优先于旧 Plan 文档中 mode=plan / prePlanMode 的实现描述，不改变现有模型提示词正文。

## 所有权与行为

Composer 保存下一次提交的 `{mode: build|edit|yolo, planEnabled: boolean}`。菜单 Plan 置顶，
下方分隔线再列三个权限；Plan 独立选中，不改变权限。Plan 标记在权限右侧，叉仅修改草稿。
Plan 菜单项保留原说明“编辑前先出计划。”及英文翻译，采用与权限项一致的两行布局。
合并 staging 后继续使用生效快捷键表显示权限切换提示，不恢复旧的 Plan／权限混合循环。
提交、Guide、轮次结束不清标记；批准被处理才定向关闭。拒绝／反馈不修改草稿。
工具主动 EnterPlanMode 定向开启标记，工具批准退出定向关闭。2026-09-15 简化裁决：
新的工具结果到达时直接设置标记，即使期间用户手动改选也照常应用；同一结果只处理一次。
不维护忽略工具列表或草稿修改版本，不新增可见历史事件，不恢复已隐藏的 EnterPlanMode 行。

```text
批准旧计划 -> 用户重新选择 Plan -> 批准结果到达 -> 清除 Plan 标记
                                               -> 同一结果重放不再清除
```

```text
草稿 -> command 接纳并固定两个值 -> Runtime 消费 -> 统一状态转换 -> 保存并同步
               |                    ^
               +-> Queue 原值往返 --+
Enter/ExitPlanMode -----------------+

desktop continuous：直接应用实时同步
mobile replayable：原有 snapshot/gap 恢复 -> 同一 Runtime，不创建新 owner
```

Plan 优先于 yolo 的工具放行；ExitPlanMode 始终需要审批。批准只关闭 Plan、继续当前 Turn，
不改权限、不发一条新用户消息。拒绝停止当前 Turn，反馈仍按已有用户消息路径继续规划。
Goal 与 Plan 双向互斥。固定执行模型的 Guide 保持模型，但仍消费明确的权限和 Plan。
已有规划／退出 reminder 只改触发依据，不改提示正文、MCS 或输出样式冻结机制。

## 兼容与存储

- session_entry 新类型 runtime/execution_state，data 同时存 mode/planEnabled；不加表／列。
- 只在正常创建／状态更新时写，不扫描回填旧记录。不改旧 session.permission 和历史消息。
- 新 assistant 消息正常保存时附带 planEnabled，供已有 stable fork 的历史权限边界恢复；
  fork entry 与 child 一起原子保存。旧消息不回填，仍按原 mode 兼容解释。
- 新会话记录优先于环境默认；旧会话缺记录时读取兼容格式，旧 plan 无可靠基础权限则 build。
- 显式 planEnabled（false 也算）优先；旧请求仅 mode=plan 则开启，旧请求仅非 Plan mode
  则按旧语义关闭；都不带时在接纳边界固定当前值。队列不得消费时再猜。
- 老消息、工具结果、任务索引、自动任务配置保留旧枚举可读。草稿与 Recent 独立兼容：
  原会话旧 Plan 草稿保留意图，另一个新任务不继承 Plan。
- 新版冷恢复保证本次已保存状态。回滚保证内容可读，不宣称旧程序准确恢复新增 Plan 状态。
- Host 通过现有 hello 的 independentPlanState 可选能力声明支持。旧 Host 不支持时只拒绝
  Plan=true 的新提交，防止剥掉字段变为 yolo 执行；普通发送、读历史和现有 wire 版本不变。
- Host 还需通过 runtime/capabilities 确认实际 CLI，成功结果按 CLI client 缓存；
  新 Host 连旧 CLI 时同样拒绝 Plan=true，不把 Host 版本当成远端能力。
- 权限与 Plan 的持久化失败不得报告状态已成功同步；旧数据缺字段不应阻断历史内容打开。

## 必测

Queue 真实事件投影与提升往返；原位编辑／重排／Guide 回退；yolo+Plan=false 正确执行，
yolo+Plan=true 仍受限制并审批；Enter/Exit 工具的类型、Schema、权限、返回与反馈；冷恢复、
旧字段兼容、分支恢复；新任务默认关闭；批准和手动叉的竞态；桌面与手机重放隔离。
