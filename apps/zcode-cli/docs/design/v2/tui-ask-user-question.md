# AskUserQuestion TUI 规划

## 背景

`AskUserQuestion` 的 contract、core handler 和基于 permission broker 的 TUI
交互已经存在。当前实现可以解析 `AskUserQuestion` 输入，在 TUI 中显示问题，支持
单选、多选、自动 Other 文本、Esc 拒绝、preview 文本展示、preview annotation
回填、多问题 review tab 和 composer draft 保留，并通过 `modifiedInput.answers`
让 tool 继续执行。

它仍不是完整的可恢复 user interaction subsystem：

- 交互状态仍由 `PermissionBrokerRequest` / approval queue 桥接，缺少独立的
  user interaction pending state 和 session event 投影。
- pending prompt 主要是内存态，session 恢复、SDK list/reply/reject、plugin API
  还没有统一接口。
- ZCode app-server 已通过 `zcode.dev/elicitation/create` 扩展承载 `AskUserQuestion`，但官方
  ZCode app-server elicitation 和通用 `UserInteractionPort` 仍未收口。
- HTML preview 已做 fragment schema 校验，TUI 只按纯文本展示，不提供 sandbox
  或富渲染。
- 多问题导航已支持 `Tab`、`PageUp` / `PageDown`、左右方向键和数字快捷键；
  `Shift+Tab` 尚未作为独立反向导航实现。

本规划的目标是把现有 MVP 升级成可恢复、可审计、agent 友好的用户澄清 TUI，而不是把所有能力继续塞进通用权限弹窗。

## 当前实现状态（2026-05-08）

已落地能力：

- `packages/contracts/src/tools/ask-user-question.ts` 提供 runtime schema、JSON
  Schema、答案 schema、preview annotation schema，以及 markdown / HTML fragment
  preview 校验。
- `packages/core/src/tool/handlers/ask-user-question.ts` 注册内置 tool，声明
  `requiresUserInteraction`、只读、低风险、`userInteraction` side effect scope，
  并只接受已回填答案的输入。
- `packages/tui/src/app-question-state.ts` / `packages/tui/src/app-model.ts` 使用独立
  `QuestionPromptState` 承载 TUI 内部选择、Other buffer、review 和 annotation；
  当前仍通过 permission broker resolve `modify`。
- `packages/tui/src/app-question-panel.tsx` 渲染问题面板、review tab、完成态 tab、纯文本 preview
  和多选状态。
- `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-entrypoint.ts` 对 ZCode protocol client 使用 `zcode.dev/elicitation/create`
  扩展，把 elicitation answer 和 annotation 转回 `modifiedInput`。

已覆盖测试：

- `packages/contracts/tests/ask-user-question.test.ts` 覆盖单选 schema、重复问题、重复
  label、禁止模型提供 Other、执行前必须有答案、markdown preview、HTML preview fragment
  与 unsafe HTML 拒绝。
- `packages/tui/tests/tui.unit.test.ts` 覆盖单问题 Other、composer draft 保留、preview
  annotation、多问题 review、多选 Space、Other 输入和 `Ctrl+U` 清空 Other buffer。
- `packages/bootstrap/tests/zcode-protocol.test.ts` 覆盖 ZCode app-server `AskUserQuestion` 走 ZCode elicitation
  扩展并回填多问题答案。

## 设计要点

工具与权限：

- `AskUserQuestion` 是 `shouldDefer`、`isReadOnly`、`isConcurrencySafe`、`requiresUserInteraction` 的特殊 tool。
- tool 自身 `checkPermissions` 返回 ask，但 UI 语义是回答问题，不是审批危险操作。
- 当远程 channel 模式下用户不在 TUI 时禁用该 tool，避免无人响应导致会话挂起；工具只在允许的 collaboration mode 中暴露，不可用时返回明确 unavailable message。
- plan approval 和 clarification 严格分离，避免用 AskUserQuestion 问“是否执行计划”。

挂起与事件：

- 提问时由 session 发出请求事件，active turn 挂起等待答案；pending user input 存在 turn state 中，用户回答前不会启动额外 continuation。
- 独立 service 管理 `ask/list/reply/reject`，pending request 用 Deferred 等待；通过 asked/replied/rejected 事件同步 TUI、HTTP API 和 plugin API。
- API 暴露 list/reply/reject，适合 SDK、远程 UI、插件和自动化接管。

交互与输出：

- TUI 把 question prompt 和 permission prompt 分开展示，且 permission 存在时禁用普通输入。
- 一次显示一个问题，Enter 前进，最后提交；PageUp/PageDown 支持多问题导航；多问题使用 tab + confirm review；单问题单选可以直接回答并关闭。
- 单选支持 option `preview`，有 preview 时切到选项列表 + 预览面板。
- “Other” 由客户端自动提供，模型不得自己添加。
- 输出会把答案、选中 preview 和用户 notes 一起序列化给模型。

## 设计目标

1. `AskUserQuestion` 是用户澄清交互，不是普通权限审批。
2. pending prompt 必须是 session/turn 状态对象，携带 `traceId`、`turnId`、`toolCallId`、`requestId`。
3. TUI、SDK、远程 channel 使用同一套 reply/reject/cancel 语义。
4. yolo/自动权限模式不能绕过用户交互；非交互入口必须 fail closed 或在 tool registry 中禁用。
5. TUI 要优先保证低摩擦：单问题单选最快回答，多问题/多选提供 review。
6. preview 和 annotation 作为契约能力保留，MVP 可先文本渲染，后续再做富渲染。
7. AskUserQuestion 出现时接管原来的 composer/input 区域；普通用户输入框被隐藏或禁用，但用户已有 draft 必须保留，问题回答结束后恢复。

## 推荐架构

新增或补齐一个 `UserInteractionPort`，不要让 TUI 直接依赖 permission 特例：

```ts
interface UserInteractionPrompt {
  requestId: string;
  sessionId: SessionId;
  turnId?: TurnId;
  traceId: TraceId;
  toolCallId: ToolCallId;
  toolName: "AskUserQuestion";
  input: AskUserQuestionInput;
  requestedAt: Date;
}

interface UserInteractionResult {
  decision: "answer" | "reject" | "cancel";
  answers?: Record<string, string>;
  annotations?: Record<string, AskUserQuestionAnnotation>;
  reason?: string;
  resolvedAt?: Date;
}
```

第一阶段可以继续由 `PermissionBroker` 桥接，确保兼容现有 executor：

1. `PermissionService` 识别 `requiresUserInteraction`，始终进入交互路径。
2. `UserInteractionBroker` 发布 `user_interaction_requested`，等待 answer/reject/cancel。
3. 桥接层把 answer 转成 `PermissionBrokerResult { decision: "modify", modifiedInput }`。
4. 后续 executor 支持 native user interaction 后，再移除 permission 桥接。

建议新增事件：

- `user_interaction_requested`
- `user_interaction_answered`
- `user_interaction_rejected`
- `user_interaction_cancelled`

projection 中保存 `pendingUserInteractions`，用于 session resume、SDK list 和 TUI 重绘。

## TUI 交互规格

### 面板布局

- permission prompt 和 question prompt 分开渲染，但共用 action panel 队列。
- question prompt 替换底部普通输入框所在区域，而不是追加在输入框之上；此时普通 prompt submit、slash command、history recall、附件粘贴等 composer 行为暂停。
- 当同时有 permission 和 question 时，permission 优先；question 保持 pending。
- 单问题单选：不显示 review tab，选择后直接提交。
- 多问题或多选：显示 header tabs 和最后的 Review/Submit tab。
- 每个 tab 显示 `header`；已回答 tab 使用完成态标识，未回答保持 dim。

### 输入焦点模型

AskUserQuestion 有自己的内部输入框，主要用于 Other 或后续 notes。它与普通 composer 共享同一条 stdin/key event 管道，但语义不同：

- `screen.input` 中已有的普通 draft 在进入 question prompt 时保持不变，不参与问题回答。
- question prompt 激活期间，所有可打印字符默认交给 question panel；只有进入 Other/notes 输入态时才写入内部 buffer。
- 内部输入态的 `Enter` 是接受当前 Other/notes，不是发送普通 prompt。
- 内部输入态的 `Esc` 先退出内部输入态；主 question 面板上的 `Esc` 才 reject 整个问题。
- question 结束后，普通 composer 恢复原 draft、光标和附件状态，用户可以继续输入或发送。
- 如果 turn 被 `Ctrl-C` 取消，pending question 和内部输入 buffer 清理，但普通 composer draft 不应被清空。

### Composer draft 保留

这是 AskUserQuestion 替换输入框时的硬约束：

- 替换只影响当前渲染和输入路由，不修改已有 `screen.input`、`draftAttachments`、selection/slash command draft 之外的普通 composer 状态。
- 如果用户在触发 AskUserQuestion 前已经输入了内容，例如 `please keep this draft`，question 面板关闭后普通输入框必须继续显示同一段内容。
- Other/notes 的内部输入 buffer 不能复用 `screen.input`，也不能在提交答案时覆盖 `screen.input`。
- 拒绝问题、回答问题、取消 turn、permission queue 切换和 TUI 重绘都不能清空原 draft。
- 只有用户在普通 composer 激活时主动提交、清空或编辑，才允许改变原 draft。

### 键盘

- `Up/Down` 或 `k/j`：移动选项。
- 数字 `1-5`：直接选择对应选项或 Other。
- 单选：`Enter` 选择当前项；如果只有一个问题则立即提交，否则进入下一题。
- 多选：`Space` 切换当前项；`Enter` 进入下一题或 Review；至少一个答案后才能提交。
- `Tab` / `Shift+Tab`：多问题时在问题 tab 和 Review tab 间切换。
- `PageUp/PageDown`：多问题时上一题/下一题。
- `o` 或选中 Other 后 `Enter`：进入自定义输入。
- Other 输入中：`Enter` 接受，`Esc` 取消输入，`Ctrl+U` 清空，`Backspace` 删除。
- 主面板 `Esc`：reject 本次问题，并生成用户可见的 declined result。
- `Ctrl-C`：取消当前 turn，通过 abort signal 清理 pending prompt。

### Other 与 annotations

- UI 永远自动提供 Other，schema 继续禁止模型显式添加 `Other` option。
- 单选 Other 提交为该问题唯一答案。
- 多选 Other 作为一个答案项并参与逗号拼接。
- 选中带 `preview` 的 option 时，回填 `annotations[question].preview`。
- 后续可以增加 notes 输入，回填 `annotations[question].notes`；第一版不强制。

### Preview

MVP：

- markdown/html preview 都先作为纯文本框展示。
- 单选问题且当前 option 有 `preview` 时，在选项列表下方展示当前选项的纯文本
  preview，并在提交该选项时回填 `annotations[question].preview`。
- multiSelect 问题暂不展示 preview，并在 schema/prompt 中继续建议不要对 multiSelect 使用 preview。

后续：

- markdown 使用现有终端 markdown renderer。
- HTML preview 必须先经过 fragment validation，再考虑 sandbox/fallback rendering。

## 非交互与远程行为

- `--prompt`、后台任务、无 TTY、无 broker 的入口默认不暴露 `AskUserQuestion`，或执行时返回 `interaction_unavailable`。
- 远程 channel 如果无法把问题 relay 给用户，应禁用该 tool。
- SDK/HTTP/插件入口应暴露 pending list/reply/reject，而不是让宿主进程解析 permission prompt。
- subagent 默认不允许 `AskUserQuestion`，除非未来有 parent-mediated interaction 设计。

## 实施阶段

### Phase 0：锁定现状

- 补一组当前 MVP 的快照测试，证明单选、多选、Other、Esc 拒绝能工作。
- 明确现有 `PermissionBroker` 桥接只是临时路径，在 spec 中标注迁移目标。

### Phase 1：补 interaction contract

- 在 contracts 中新增 user interaction request/result schema 和事件 payload。
- session projection 增加 `pendingUserInteractions`。
- core 增加 user interaction broker，默认 deny/unavailable，支持 abort signal 和 timeout。
- permission bridge 保持兼容：answer -> `modify`，reject/cancel -> deny/error。

### Phase 2：补完整 TUI prompt

- 将 `QuestionPromptState` 从 approval state 中拆成独立渲染模型，或至少建立清晰 adapter。
- 增加 tab/review、多问题跳转、数字快捷键、`j/k`、`PageUp/PageDown`。
- 保持现有单问题快速路径，避免最常见场景变重。
- TUI action panel 只处理队首交互，普通输入在 pending 期间禁用。

### Phase 3：preview 与 annotation

- 渲染文本 preview 面板。
- 选择 option 时记录 preview annotation。
- tool result 和 transcript 中展示 answer summary，不把大 preview 全量刷屏；模型内容仍按 budget 序列化。

### Phase 4：恢复与外部入口

- session event log 持久化 requested/answered/rejected/cancelled。
- resume 后重建 pending prompt，已取消的 prompt 不重新等待。
- SDK/HTTP/plugin 暴露 `listPendingUserInteractions`、`answerUserInteraction`、`rejectUserInteraction`。

### Phase 5：清理 permission 耦合

- executor 原生支持 `requiresUserInteraction` tool 的 defer/wait/continue。
- `AskUserQuestion` 不再依赖 permission decision 表达答案回填。
- permission UI 只服务权限，question UI 只服务澄清。

## 测试计划

最低测试集：

- contract：问题数量 1-4、选项数量 2-4、重复 question、重复 label、禁止 Other。
- core：缺少 `answers` 字段时执行失败；显式 `answers: {}`、部分答案和完整答案均执行成功；reject/cancel 不执行 handler；yolo 不自动 allow。
- broker：answer/reject/cancel/timeout/abort 都清理 pending 并保留 trace 信息。
- TUI：单选快速提交；每题可跳过且末题允许以 `answers: {}` 提交；多选 Space 切换；Other 输入/取消/清空；多问题 tab/review；Esc reject；Ctrl-C cancel；AskUserQuestion 结束后恢复进入前已有的 composer draft。
- preview：选择带 preview 的 option 后回填 annotation；超长 preview 被截断显示但不丢模型预算规则。
- resume：恢复 session 后 pending prompt 仍可回答；已回答 prompt 不重复显示。
- 非交互：无 TTY 或无 broker 时返回结构化 unavailable，不悬挂。

## 优先级建议

先做 Phase 0-2，得到可用且好测的 TUI；再做 Phase 3 的 preview。Phase 4-5 是架构收口，和 SDK/远程入口价值强相关，可以在第一版可用后拆独立功能级提交。
