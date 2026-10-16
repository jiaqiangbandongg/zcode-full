# Plan Mode Approval Boundary

## 背景

Plan mode 的 `ExitPlanMode` 是计划审阅边界：模型提交计划后，必须等待用户明确批准，才能退出 `plan` 并继续实施。

## 语义

- `EnterPlanMode` 可以无确认进入只读计划态。
- `ExitPlanMode` 在 `plan` 模式下始终需要用户确认，包括从 `yolo` 进入 plan 的场景。
- 用户批准 `ExitPlanMode` 后，runtime 才恢复到进入 plan 前的模式，并允许后续编辑。
- 用户拒绝 `ExitPlanMode` 且没有填写修改意见时，当前 turn 必须结束，session 保持 `plan` 模式，等待用户继续输入修改意见。
- 用户在 `ExitPlanMode` 审批里填写修改意见时，runtime 保持 `plan` 模式，并把反馈持久化为一条真实、普通的 `user` message；`ExitPlanMode` 的工具结果只返回一条桥接说明，告诉模型用户反馈会跟随在下一条用户消息中。这样 UI / resume / provider-visible history 都把这段反馈当成用户新 query，而不是吞进工具结果，也不是展示成 turn steer 引导消息。

## MCP 工具例外

Plan mode 默认只允许只读、非 destructive 的工具执行。MCP 工具是外部 server 动态暴露的能力，部分工具不会声明 `readOnlyHint`，但仍需要在计划阶段用于读取外部上下文、设备状态或远端资料。

因此 Plan mode 对 MCP 工具使用独立权限边界：

- MCP 身份由工具权限声明 `permission.permission === "mcp"` 识别，不靠 `mcp__` 名称前缀推断。
- 项目级 `deny` / `ask` 规则仍优先生效，不能被 MCP 例外绕过。
- 显式声明 `destructiveHint: true` 的 MCP 工具仍在 Plan mode 下拒绝执行。
- 未显式 destructive 的 MCP 工具允许在 Plan mode 下执行，即使该工具没有声明 `readOnlyHint: true`。
- 该例外只跳过 Plan mode 的 readonly 判定，不改变 MCP 工具注册、模型可见 schema、输出预算、timeout、取消、日志或 UI 权限展示协议。

## 交互实现

`ExitPlanMode` 仍然是模型调用的工具，runtime 仍然通过 permission broker 创建审批边界。为了让用户在审批弹窗里直接输入修改意见，`ExitPlanMode` 的 broker 实现复用 `AskUserQuestion` 的 `interaction/requestUserInput` 通道，而不是展示普通 `interaction/requestPermission`。

- `approve` 映射为 permission `allow`。
- 关闭弹窗映射为 permission `deny`，且不携带反馈，保持停止当前 turn 的旧行为。
- 自定义输入映射为 permission `deny + reason`，并带上 `reasonSource: "plan_approval_feedback"`，用于表达“需要修改计划”；runtime 只能依赖这个显式 source 解释为“用户要求修改计划”，不能把 hook、project rule、broker 里其他 `deny + reason` 当成反馈。
- runtime 收到 `reasonSource: "plan_approval_feedback"` 后，先为 `ExitPlanMode` 注入 tool result 以闭合 provider 的 tool-use 协议，再通过带 `source: "plan_approval_feedback"` 的 active-turn pending input 路径把自定义输入写入真实用户消息历史。这个顺序保证 provider-visible history 是 `assistant tool_use` → `tool_result` → `user feedback`，同时复用 `persistUserPrompt`，让下次 resume 能看到这条反馈。UI 把缺省来源的 active-turn steer 渲染成 guided/steer 消息，计划审批反馈必须渲染为普通用户气泡。
- 普通 `AskUserQuestion` 不套用这条规则：它的回答仍然是工具调用结果，只有 `ExitPlanMode` 审批反馈会升级成新的用户消息。
- 投影层把 `ExitPlanMode` 的 pending permission 映射为 pending elicitation，并过滤对应的 `permission.requested` 实时事件，避免 UI 同时出现普通权限弹窗和可输入弹窗。

## 修复原因

之前拒绝 `ExitPlanMode` 会被包装成普通工具失败并继续喂给模型。模型收到失败结果后可能在同一 turn 内自行重新思考、重新提交另一版计划，用户还没输入修改意见就看到新的确认弹窗。现在无反馈的 `ExitPlanMode` 拒绝结果会携带 turn control，runtime 提交拒绝记录后立即停止本轮，避免计划审阅阶段自循环。

带反馈的拒绝不能停止本轮，但也不能把用户原话藏在 tool result 里。原因是这段内容来自用户主动输入，语义上等同下一条 query；如果只写入 tool result，UI 不会出现用户气泡，session resume 也无法按真实用户消息恢复审阅轨迹。因此这条路径必须复用真实用户消息持久化链路。
