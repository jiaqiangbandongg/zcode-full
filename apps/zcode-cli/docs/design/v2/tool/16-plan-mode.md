# EnterPlanMode / ExitPlanMode

## 目标

提供 plan mode provider tools，让模型能主动请求进入计划模式、完成只读探索后向用户提交计划，并在用户批准后退出计划模式开始实现。

ZCode 第一版不引入 plan file、auto mode gate、teammate mailbox、专用 plan model 等当前运行时没有的一体化功能。计划正文通过 `ExitPlanMode.plan` 直接传入，后续如要引入 plan artifact/file，需要单独扩展本 spec。

## 工具

### EnterPlanMode

- 名称：`EnterPlanMode`
- 输入：空对象 `{}`
- 输出：`{ message, previousMode, mode: "plan" }`
- 能力：直接进入 plan mode，用于复杂实现任务开始前的探索和方案设计。
- 权限：`EnterPlanMode` 不弹用户审批，调用成功即切换到 plan mode。
- 副作用：`sideEffectScope: "session"`，不是 read-only。
- 并发：不安全，必须串行。mode 变更不能和其它 session mutation 并行。
- 失败：
  - 工具执行失败：返回 tool error，mode 不变。
  - runtime 未注入 session mode port：configuration error。

模型可见说明需覆盖：

- 非平凡实现任务应主动使用该工具，先拿到用户对方案方向的同意，避免直接写代码后返工。
- 除简单任务外，以下场景优先进入 plan mode：新功能实现、多种可行方案、修改既有行为或结构、架构决策、多文件变更、不明确需求、实现方式明显受用户偏好影响。
- 进入后只能用 `Glob`、`Grep`、`Read` 等只读工具探索，识别既有模式和架构，设计实现方案。
- 需要澄清方案时用 `AskUserQuestion`；计划审批必须用 `ExitPlanMode`。
- 单行/少量显然修复、明确的小函数、用户已经给出详细实现步骤、纯研究/探索任务不要滥用；纯研究/探索提示使用 `Agent`，不在该句绑定具体 agent type。
- 模型提示需包含正反例：认证、数据库优化、暗色模式、删除按钮、API 错误处理应进入 plan mode；README typo、简单 debug log、询问路由文件不应进入 plan mode。

### ExitPlanMode

- 名称：`ExitPlanMode`
- 输入：
  - `plan: string`：展示给用户审批的计划正文。
  - `allowedPrompts?: { tool: "Bash"; prompt: string }[]`：第一版仅保留到输入/输出和 UI/permission projection，不自动写 permission rules。
- 输出：`{ plan, previousMode, mode, approved: true, allowedPrompts? }`
- 能力：在 plan mode 下提交最终计划，并请求用户同意退出 plan mode。
- 权限：默认必须走用户审批。审批通过后恢复进入 plan mode 前的 mode；没有记录时恢复 `build`。如果进入前是 `yolo`（bypass permissions），`ExitPlanMode` 直接恢复 `yolo`，不再弹审批。
- 副作用：`sideEffectScope: "session"`，不是 read-only。
- 并发：不安全，必须串行。
- 失败：
  - 当前不是 plan mode：稳定失败，不弹无意义审批。
  - `plan` 为空：schema 校验失败。
  - 用户拒绝：返回 permission denied tool error，保持 plan mode。

模型可见说明需覆盖：

- 只在 plan mode 中、已经完成实现计划、准备交给用户审批时调用。
- 工具必须通过 `plan` 参数传入完整计划；模型不要假设存在 plan file，也不要只发空输入。
- `plan` 参数就是用户审批时看到的内容，必须完整、明确、可执行。
- 正常模式下调用本工具会请求用户审批；从 `yolo` 进入 plan 时，本工具直接退出回 `yolo`，不会请求审批。
- 只用于需要写代码的实现任务；纯研究、搜索文件、阅读文件、理解代码库时不要调用。
- 若需求或方案仍有未解问题，先用 `AskUserQuestion` 澄清。
- 不要用 `AskUserQuestion` 问“计划是否可以”或“是否继续”；审批就是本工具职责。
- 工具结果批准后，模型可以开始实现，并优先更新 todo（如果适用）。
- 模型提示需包含正反例：理解 vim mode 实现不应调用；实现 yank mode 应在规划完成后调用；认证功能若认证方式未定，应先 `AskUserQuestion`，再 `ExitPlanMode`。

### 审批后 plan file 连续性

当前过渡实现仍保留 `ExitPlanMode({ plan, allowedPrompts? })` 的 provider-visible 输入形态。审批通过后，runtime 会把最终批准的 plan 原始字符串写入 workspace root 下的 `.zcode/plans/plan-${sanitizedSessionId}.md`；写入失败不阻断已批准的退出 plan mode，只会让后续 compact continuity 降级为没有 plan file reference。

这个文件不是新的 provider-visible input，也不是完整的 plan-file schema；它只用于 compact/resume continuity。compact 成功时，如果该 plan file 存在且非空，runtime 会在 compact 后历史中持久化 `plan_file_reference` model-only reminder：

```text
A plan file exists from plan mode at: ${planFilePath}

Plan contents:

${planContent}

If this plan is relevant to the current work and not already complete, continue working on it.
```

这样即使 `ExitPlanMode` 后立即 compact，恢复后的下一轮 provider context 仍能拿到完整批准计划。

当前过渡实现没有新增 plan file retention cleanup。如需按保留天数清理 plans 目录中过期的 `.md`，应作为独立 retention cleanup 改造接入，而不是在 compact/session 时即时删除。

## Runtime 和事件

工具 handler 不直接 import bootstrap 或 UI 状态。core 通过 `SessionModePort` 注入 mode 操作：

- `getMode()`
- `getPrePlanMode()`
- `enterPlanMode({ toolCallId, traceContext })`
- `exitPlanMode({ toolCallId, traceContext })`

runtime 实现负责保存 `prePlanMode`、更新 `config.mode`、写入 `SessionModeChanged` event，并在退出后设置一次性 `plan_mode_exit` reminder。事件 reducer 必须用该事件更新 `SessionProjection.mode`，使 snapshot、resume、debug 和 ZCode app-server 看到同一事实。

## UI / ZCode app-server

- permission request 仍复用现有 `PermissionRequested` / `PermissionResolved` 协议。
- `ExitPlanMode` 的 `plan` 留在 tool input / result payload 中，现有 plan mode tool panel 可解析展示。
- desktop continuous 和 web remote replayable 都只消费 session event / snapshot；relay 与 main 不保存 plan mode 业务状态。

## 测试

- contracts：输入输出 schema 成功/失败，JSON Schema 投影。
- core：registry 暴露两个工具；metadata/permission 不伪装 read-only。
- permission：`EnterPlanMode` 直接 allow；`ExitPlanMode` 在非 yolo 进入的 plan mode 下请求审批，在从 yolo 进入的 plan mode 下直接 allow；两者都不会被 read-only 禁令误挡。
- runtime：`EnterPlanMode` 调用成功后 mode=plan；`ExitPlanMode` 审批通过后恢复 previous mode；拒绝后 mode 不变。
- events：`SessionModeChanged` 能更新 projection，snapshot 使用 projection mode。
- reminder：退出后下一轮注入 `plan_mode_exit`，且只注入一次。
