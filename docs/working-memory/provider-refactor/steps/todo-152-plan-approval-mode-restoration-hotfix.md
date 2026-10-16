# Todo152：计划批准后恢复权限并同步输入框（hotfix）

状态：已被 Todo151 替代，不再单独执行。2026-09-15 用户改为直接拆分权限与 Plan；原批准后 UI 残留问题并入 [Todo151](./todo-151-independent-plan-state-draft.md)。以下保留 2026-09-14 的历史方案，不代表当前裁决，尤其不再按本条补建 `prePlanMode` 恢复链路。

## 必要修复

1. ExitPlanMode 真正批准并成功退出后，输入框不再残留本次 Plan，显示执行端恢复的权限；下一条普通消息不得因旧草稿重新进入 Plan。
2. 恢复进入 Plan 前的权限：已有会话沿用该会话进入前的明确权限；新会话沿用普通新建任务进入 Plan 前确定的权限，包括用户显式选择。不能不分来源一律落到 `build`，也不能一律提升为 `yolo`。
3. 两端恢复同一个目标权限，不允许 UI 显示已恢复但 Runtime 仍按另一种模式执行。批准继续当前 Turn，不新增用户 Submission；拒绝／反馈不退出 Plan。

```text
已有会话进入前权限 / 新建任务初始化或显式选择的权限
                       ↓ 保存本次返回目标
                    提交 Plan
                       ↓ 批准成功并退出
          Runtime 恢复目标 → Composer 同步退出本次 Plan
```

## 已核实的代码事实与实施约束

- `core/src/runtime/session-mode-port.ts` 使用内存 `prePlanMode`，缺失时回退 `build`；`methods/config.ts` 已处理普通模式切换时记忆前值，但初始配置即 Plan、冷恢复不一定有该前值。
- `ui/src/v4/composer/useDraftConfigControl.ts` 仅用 Session 初始化一次草稿，之后不跟随退出，导致执行端已退出、草稿仍为 Plan。
- `newTaskDraft.ts` 普通新建取 `recent.mode ?? build`；`composerRecent.ts` 在 Submission 接纳后也会把 Plan 写入 recent。因此返回目标须在进入／提交 Plan 前保留，不能批准时读取已被 Plan 覆盖的 recent，也不能把新 Runtime 的默认 build 当作用户原意图。
- 不以“有 sessionId”判定已有会话：首次提交前的预创建不等于曾有明确权限历史。
- 优先复用已有返回目标机制；需要贯穿入口或持久化的最小信息在实施时细化。旧记录确实无权限事实时保守沿用 build，不猜完全访问。
- 仅同步这次真实退出；不清正文、模型、附件，不用一般 snapshot 更新持续覆盖用户草稿，也不覆盖用户此后明确选择的新权限／新 Plan。事件重复或重放不得再次消费退出效果。
- 不拆 mode，不改系统提示词，不调整 Plan／Goal 互斥或工具权限规则；桌面本地和手机 shared-host 均使用权威退出结果，不新增队列或跨端广播权限默认值。

## 验收

- 已有会话分别从 build / edit / yolo 进入 Plan，批准后 Runtime、输入框、后续普通 Submission 恢复一致；无需额外发话才退出。
- 新会话从最近权限或用户显式选择进入 Plan，首次运行即 Plan 也不丢返回目标；recent 已被 Plan 覆盖不能影响本次返回目标。
- 拒绝、修改反馈仍保持 Plan；用户批准前后更新下一条草稿时不被旧退出事件覆盖；正文、模型选择保持原样。
- 重挂载、冷恢复、重复事件与手机重连核对恢复结果；缺历史事实不崩溃、不提升权限。
- 实施前补单测及交互 E2E；完成后 review、类型／lint／架构检查，记录未验证环境。当前仅文档，不代表已通过上述验收。
