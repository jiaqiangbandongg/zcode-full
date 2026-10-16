# ZCode CLI Hooks 设计 v2

## 文档定位

本文是 hooks 能力的 v2 规划，成熟度为 `L3 Implementation Contract`。它定义事件、配置、运行时边界、权限交互、可观测性和测试要求，并与根目录
`docs/hooks-runtime-contract.md` 共同作为现有 7 个事件的验收依据。

Hooks 的目标不是把业务逻辑散落到用户脚本里，而是在 agent loop 的关键安全边界提供可审计、可取消、可测试的扩展点。ZCode 的核心原则仍然成立：core 只表达意图，不直接触碰文件系统、网络、子进程或环境变量；所有外部 I/O 通过 adapter/port 收敛。

## 设计取舍

采用：

- 配置来源分层（user/project/local/policy settings、plugin hook、session hook、builtin hook），启动时捕获 hooks config snapshot，避免会话中隐式修改配置导致行为漂移。
- 完整事件语义，包括 `PreToolUse`、`PostToolUse`、`PostToolUseFailure`、`PermissionRequest`、`UserPromptSubmit`、`SessionStart`、`Stop`、`PreCompact`、`PostCompact` 等。
- matcher 是事件相关字段的正则。tool 类事件匹配 `tool_name`，session start 匹配 source，compact 匹配 trigger。
- 执行层支持 per-hook timeout、abort、进度事件、stdout/stderr 捕获、JSON 输出、exit code 2 阻断。
- 决策有聚合优先级：deny/block 优先，其次 ask，再其次 allow；hook 可以修改 tool input、补充上下文、替换部分工具输出。
- 独立 hook progress/response 事件、权限 request hook。
- 类型安全的 hook 名称、input/output 分离、顺序稳定、插件级能力聚合。
- 安全上要求 workspace trust、managed policy 开关、插件 root 隔离、hook 去重、Windows shell/path 处理。

不采用：

- 默认 shell 字符串命令、过多初版事件、hook 直接散布在 UI/AppState 层。
- hook 通过 mutable output 隐式改变状态；ZCode 需要事件化、schema 化，避免输出契约靠对象引用约定。

## 设计目标

1. 提供 NL->Code 主链路关键扩展点：用户输入、工具执行前后、权限请求、会话开始/结束、停止前、压缩前后。
2. 所有 hook 输入和输出都有 runtime schema，跨进程、配置、插件、SDK 边界时不只依赖 TypeScript 类型。
3. hook 执行必须携带并传播 `traceId`、`sessionId`、`turnId`、`toolCallId`。
4. hook 自身的副作用通过 `HookExecutionPort`、`HttpClient`、`ExecutionPort` 等 adapter 收敛。
5. hook 结果可以影响 agent 行为，但必须通过显式 `HookDecision`，不能直接修改 core 内部状态。
6. hook 进度、结果、失败和阻断都进入 session event stream，UI 只消费 projection。
7. 第一版避免新增 `ZCODE_` 环境变量。配置走 config file、CLI/session override 或 SDK 注入。

## 非目标

- 第一版不增加现有 7 个事件之外的新 Hook 事件。
- 第一版不实现 prompt hook、agent hook、file watcher hook、worktree hook。
- 第一版不实现 `if`、`once`、`asyncRewake`。
- 第一版不让 hook 绕过 plan mode、显式 deny rule、sandbox 或 tool contract。
- 第一版不把大体积 hook 输出直接注入模型上下文。

## P0 事件集合

| Event                | 触发点                                        | 可阻断             | 可修改                            | 模型可见输出                                        |
| -------------------- | --------------------------------------------- | ------------------ | --------------------------------- | --------------------------------------------------- |
| `SessionStart`       | session 创建或 resume 后、首轮 prompt 前      | 否                 | 可追加 session context            | 是，受预算限制                                      |
| `UserPromptSubmit`   | 用户输入进入 turn 前                          | 是                 | 可追加 context，不改原始用户文本  | 是，受预算限制                                      |
| `PreToolUse`         | tool input schema 校验后、permission check 前 | 是                 | 可替换完整 tool input             | 可追加 context                                      |
| `PermissionRequest`  | permission service 返回 ask、broker UI 前     | 是                 | 可允许、拒绝或替换完整 input      | 否，除拒绝原因                                      |
| `PostToolUse`        | tool 成功后、结果序列化给模型前               | 否                 | 可追加 context；P1 再支持替换输出 | 是，受预算限制；Hook stdin 获得完整 `tool_response` |
| `PostToolUseFailure` | tool 失败后、错误返回模型前                   | 否                 | 可追加 recovery context           | 是，受预算限制                                      |
| `Stop`               | turn 即将 complete 前                         | 是，可要求继续一轮 | 可追加 feedback context           | 是                                                  |

实现状态：

- contract/config schema/runner 只声明并支持：`SessionStart`、`UserPromptSubmit`、`PreToolUse`、`PermissionRequest`、`PostToolUse`、`PostToolUseFailure`、`Stop`。
- 已接入 tool executor：`PreToolUse`、`PermissionRequest`、`PostToolUse`、`PostToolUseFailure`。
- 本阶段补齐 runtime 主链路接入：`SessionStart`、`UserPromptSubmit`、`Stop`，并补齐 `PreToolUse.additionalContext` 的模型可见行为。

P1 再考虑：

- `PreCompact` / `PostCompact`
- `SubagentStart` / `SubagentStop`
- `ModelRequest` / `ModelResponse`
- `ConfigChange`
- `CommandExecuteBefore`

## Hook 配置草案

`RuntimeConfig` 增加 `hooks` 候选字段：

```json
{
  "hooks": {
    "enabled": true,
    "timeoutMs": 60000,
    "maxOutputBytes": 32768,
    "events": {
      "PreToolUse": [
        {
          "matcher": "Bash|Write|Edit",
          "hooks": [
            {
              "type": "process",
              "command": "node",
              "args": ["scripts/check-tool.mjs"],
              "enabled": true,
              "timeoutMs": 30000
            }
          ]
        }
      ]
    }
  }
}
```

配置原则：

- `events.<event>[]` 是 matcher 列表，顺序稳定。
- `matcher` 是正则字符串。tool 类事件匹配 tool name。
- P0 持久化配置支持 `process` 和 `command` 两类 hook；in-memory `callback` 只作为 core/SDK 注入能力，不写入配置。
- `process` 必须使用 `command + args[]`，通过 adapter 的 spawn/execFile 语义执行，不默认 shell 拼接。
- `command` 使用显式 shell execution mode，主要兼容 Claude Marketplace；Windows shell/path fallback 由 ExecutionPort 负责。
- 每个 hook 的 `enabled` 缺省为 `true`；`enabled:false` 必须在 Runner 注册前跳过。
- `command.async:true` 使用 fire-and-forget 语义，stdout 不能阻断、修改输入或注入上下文；后台完成/失败仍需记录 lifecycle event。
- process hook 输入通过 stdin JSON 传入，stdout 解析为 hook output，stderr 进入诊断和 hook result event。
- 配置合并沿用现有优先级：system < user < project < session < env < CLI。P0 不声明环境变量入口。

## Hook 输入契约

所有 hook input 都继承基础字段：

- `hookEventName`
- `sessionId`
- `turnId`
- `traceId`
- `cwd`
- `mode`
- `agentName`
- `timestamp`

事件专属字段：

- `PreToolUse`：`toolCallId`、`toolName`、`toolInput`、`riskLevel`、`sideEffectScope`
- `PermissionRequest`：`requestId`、`toolCallId`、`toolName`、`toolInput`、`reason`、`riskLevel`、`sideEffectScope`
- `PostToolUse`：`toolCallId`、`toolName`、`toolInput`、完整 `toolResponse`、`toolResultPreview`、`artifactRefs`
- `PostToolUseFailure`：`toolCallId`、`toolName`、`toolInput`、`error`、`isInterrupt`
- `UserPromptSubmit`：`prompt`、`attachmentsSummary`
- `SessionStart`：`source`
- `Stop`：`responsePreview`、`toolCallCount`

模型侧仍只接收受 result budget 约束的工具结果；Hook 兼容边界按 Claude Code 传递完整结构化
`tool_response`。`toolResultPreview` 和 artifact 引用作为 ZCode 扩展保留，不能替代
`tool_response`。

## Hook 输出契约

P0 使用一个统一 JSON 输出：

```json
{
  "continue": true,
  "reason": "optional human-readable reason",
  "suppressOutput": false,
  "systemMessage": "optional user-visible message",
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "allow",
    "updatedInput": {}
  }
}
```

事件专属输出：

- `PreToolUse`
  - `permissionDecision`: `allow | ask | deny`
  - `permissionDecisionReason`
  - `updatedInput`: 完整替代 input，必须重新经过 tool input schema 校验。
  - `additionalContext`
- `PermissionRequest`
  - `decision.behavior`: `allow | deny`
  - `decision.updatedInput`
  - `decision.permissionUpdates`
- `UserPromptSubmit`
  - `additionalContext`
  - `continue: false` 表示阻断本次 prompt。
- `SessionStart`
  - `additionalContext`
- `PostToolUse` / `PostToolUseFailure`
  - `additionalContext`
- `Stop`
  - `continue: false` 或未返回输出表示 turn 可以结束。
  - `continue: true` 且带 `additionalContext` 表示把反馈注入下一轮模型请求。
  - `continue: true` 但没有 `additionalContext` 视为 no-op，避免空循环。

非 JSON stdout 在 P0 不进入模型上下文，只作为 hook diagnostic event 记录。未知 JSON 字段
忽略，不能导致整个 Hook 失败；已知字段类型错误仍归为单 Hook contract violation。

### 事件感知语义

`continue` 字段不能在所有事件中解释成同一个动作：

- `UserPromptSubmit continue:false`：阻断当前 prompt，不写入用户消息、不发起模型请求，返回 hook reason。
- `PreToolUse continue:false`：阻断当前 tool，等价于 hook deny。
- `PermissionRequest continue:false`：拒绝当前权限请求，等价于 hook deny。
- `PostToolUse` / `PostToolUseFailure continue:false`：P0 不阻断已完成的 tool，只记录 hook blocked event 和 reason。
- `SessionStart continue:false`：P0 忽略阻断，只记录 blocked diagnostic；会话仍可继续。
- `Stop decision:"block"`：仅当存在 reason 或 `additionalContext` 时继续下一轮模型请求。
- 为兼容已有 ZCode 配置，`Stop continue:true` 且存在 `additionalContext` 也继续下一轮。

## 决策优先级

Tool 执行路径：

1. `ToolExecutor` 校验原始 input。
2. `HookRunner.run(PreToolUse)`。
3. 如果任何 hook 返回 deny，tool 不执行，记录 hook blocked 与 tool error。
4. 如果 hook 返回 updatedInput，使用完整替代 input，并重新校验 schema。
5. `PermissionService.checkPermission` 对有效 input 执行静态策略。
6. 显式 deny rule、plan mode 写入禁令、tool contract hard guard 不可被 hook allow 绕过。
7. 如果需要 ask，`PermissionRequest` hooks 与交互 broker **并发竞速**（详见
   `permission-responder-race.md`）：broker 的应答通道先建立，hook 链同时启动。
8. 先到的决定生效：hook allow/deny/modify 先到则收口并 abort broker 等待；用户经
   broker 应答先到则收口并 abort hook 链。hook 无决定或失败按退赛处理，只剩 broker
   单边等待。hook 决定不再保证先于用户应答；需要用户不可越过的强制拒绝用
   `PreToolUse` deny 或 permission deny rule 表达。
9. tool 成功后运行 `PostToolUse`，失败后运行 `PostToolUseFailure`。

聚合规则：

- deny/block > ask > allow > passthrough。
- 多个 `updatedInput` 时按执行顺序应用“最后一个有效完整替代 input”。如果后续校验失败，归因为 hook contract violation，tool 不执行。
- 多个 `additionalContext` 按 hook 顺序拼接，并受 hook result budget 限制。
- `Stop` 最多允许连续续跑 3 次；超过后强制结束并记录 hook diagnostic，避免 hook 配置导致无限循环。

## 运行时架构

模块边界：

- `packages/contracts/src/hooks/`
  - hook event enum
  - hook input/output JSON schema
  - hook config schema
  - hook result/error 类型
- `packages/core/src/hooks/`
  - `HookRunner`
  - `HookRegistry`
  - matcher resolver
  - decision aggregator
- `packages/adapters/src/hooks/`
  - `NodeProcessHookExecutionAdapter`
  - 后续 `HttpHookAdapter`
- `packages/bootstrap`
  - 从 config 装配 hook registry 和 adapter
  - 注入 `HookRunner` 到 `AgentRuntime`

核心边界：

- core 不直接 `spawn`、不直接读 config file、不直接读取 `process.env`。
- process hook 使用现有执行 adapter 或专用 `HookExecutionPort`，二者都必须支持 timeout、abort、output truncation、cwd、Windows executable resolution。
- hook runner 只返回结构化 `HookRunResult`，不直接写 UI。
- runtime lifecycle hooks 通过 `packages/core/src/runtime/methods/hooks.ts` 统一触发，避免把 hook 调用散落在 turn loop 各处。
- lifecycle hook 的 additional context 以 synthetic user/system reminder 注入 message history；原始用户文本不被 hook 修改。

## Session Event 与观测

新增 session event：

- `hook_run_started`
- `hook_run_progress`
- `hook_run_completed`
- `hook_run_failed`
- `hook_run_blocked`

事件 payload 至少包含：

- `hookRunId`
- `hookEventName`
- `hookSource`
- `matcher`
- `hookIndex`
- `toolCallId` 或 `requestId`
- `durationMs`
- `outcome`
- `stdoutPreview`
- `stderrPreview`
- `outputBytes`
- `truncated`

日志要求：

- 所有 hook 日志带 `traceId`。
- 默认日志不记录完整 `toolInput`、完整 prompt 或密钥。
- verbose/debug 可以通过受控 artifact 记录更完整的 hook I/O。
- hook 失败默认不让整个 turn 崩溃，除非事件语义允许阻断且 hook 明确 block/deny。

## 安全与跨平台

- P0 支持 `process` 的 argv 形式和 `command` 的显式 shell 形式；后者用于 Claude Marketplace 兼容。
- Windows 下解析 `.cmd` / `.exe`、空格路径和 cwd 失败必须由 adapter 处理。
- `process` 不默认 shell；只有 `command` 可以使用管道、重定向等 shell 语法。
- process hook 的 cwd 默认是 session working directory。
- hook 配置中的相对路径按配置文件所在目录解析，而不是按当前进程 cwd 解析。
- hook 输出大小必须限制，超出进入 artifact 或截断。
- hook 超时必须取消子进程，并记录 `hook_timeout`。
- hook 被取消必须传播 abort signal，不留下 pending promise。
- 用户/project hooks 后续应接入 workspace trust 或等价安全确认；P0 可以先在 TUI/CLI 中默认要求本地项目配置显式开启 `hooks.enabled`。

## 实施阶段

### Phase 1: Spec + Contract

- 新增本文档。
- 在 contracts 中定义 hook event、config、input/output、result schema。
- 在 config schema 中加入 `hooks`；未配置时不执行，配置必须显式设置 `hooks.enabled:true`。
- 补 config parser 和 schema 测试。

### Phase 2: Core Runner

- 实现 matcher resolver 和 decision aggregator。
- 支持 in-memory callback hooks，方便单元测试和 SDK/ZCode app-server 后续接入。
- 在 `ToolExecutor` 接入 `PreToolUse`、`PermissionRequest`、`PostToolUse`、`PostToolUseFailure`。
- 新增 hook session events。

### Phase 3: Runtime Lifecycle Hooks

- 在 `AgentRuntime` 保存同一个 `HookRunner`，供 tool executor 和 runtime lifecycle 共享。
- 接入 `SessionStart`：context 初始化后、首个用户 prompt 进入模型前触发；`source=startup|resume|clear|compact`。
- 接入 `UserPromptSubmit`：用户输入转成 message history 前触发；可阻断，可追加 context，不允许修改原始 prompt。
- 接入 `Stop`：无 client-side tool call 且准备 complete 前触发；可注入 feedback 继续下一轮。
- 为 lifecycle hooks 添加 focused unit tests 和 headless runtime tests。

### Phase 4: Runtime Diagnostics + Hardening

- hook lifecycle events 补齐 stdout/stderr preview、output bytes、truncated、duration。
- process hook 相对路径按配置来源目录解析；如果来源未知，按 session working directory 解析。
- 补 timeout/cancel、invalid JSON、exit code 2、stop continuation limit 的测试。

### Phase 5: Process Adapter

- 实现 Node process hook adapter。
- 支持 stdin JSON、stdout JSON、stderr 诊断、timeout、abort、输出截断。
- 配置文件 hook 可以实际运行。

### Phase 6: User-Facing Integration（已完成桌面/Web 共用设置页）

- 设置页列出 user/project 配置、legacy import-only 配置和已启用/禁用插件 hooks。
- 设置页支持新增、编辑、删除、逐条启停与 legacy 一键导入；写回只修改 `.zcode/config.json`。
- 修改配置后废弃 deferred draft session，下一次发送使用新 runtime snapshot。
- TUI progress 和最近执行结果仍作为后续增强项。

### Phase 7: Expanded Events

- 接入 compact hooks。
- 评估 HTTP / prompt / agent hook；shell command 与 plugin hook 已完成。

## 测试要求

Phase 1：

- config schema 接受合法 hooks 配置并拒绝未知 hook event、非法 hook type、非数组 args。
- config merge 保持优先级稳定。
- 默认配置不启用任何 hook。

Phase 2：

- `PreToolUse` deny 阻止 tool 执行并发出 hook/tool 事件。
- `PreToolUse` updatedInput 会重新校验，非法 input 失败且不执行 tool。
- hook allow 不覆盖 explicit deny rule 和 plan mode。
- `PermissionRequest` allow 跳过 broker 并执行 tool。
- `PermissionRequest` deny 不执行 tool，并移除 pending permission。
- `PostToolUse` additionalContext 进入模型可见 tool result 预算。
- abort 会取消正在等待的 hook。

Phase 3：

- `SessionStart` 在首个 turn 前只运行一次，resume 来源可区分。
- `UserPromptSubmit continue:false` 在写入用户消息和发起模型请求前阻断。
- `UserPromptSubmit` / `SessionStart` 的 `additionalContext` 会进入下一次模型请求。
- `Stop continue:true + additionalContext` 会继续一轮模型请求，并受连续次数上限保护。
- `PreToolUse additionalContext` 在 tool 成功和失败路径都能进入模型可见 tool result。

Phase 4：

- hook lifecycle events 包含 stdout/stderr preview、output bytes、truncated、duration。
- `Stop` continuation 超过上限时记录 diagnostic，且 turn 正常结束。
- abort 会取消正在等待的 lifecycle hook。

Phase 5：

- process hook stdin 收到结构化 JSON。
- stdout 合法 JSON 被解析；非 JSON stdout 仅记录 diagnostic，不使 hook 失败。
- stderr 不进入模型上下文。
- timeout 杀掉子进程并记录 `hook_timeout`。
- Windows 路径、`.cmd`、空格路径至少通过 adapter 单元测试模拟。

Phase 6：

- TUI 能展示 hook running/completed/blocked。
- session resume 不重复执行历史 hook。
- hook events 可按 traceId 关联到对应 turn/tool call。

## 建议的第一批提交拆分

1. `docs: add hooks v2 design`
2. `feat(contracts): add hook schemas and config contract`
3. `feat(core): add hook runner and in-memory callbacks`
4. `feat(core): wire tool lifecycle hooks`
5. `feat(core): wire runtime lifecycle hooks`
6. `feat(adapters): add process hook execution adapter`
7. `feat(cli): surface hook progress in TUI`

## 关键决策

- ZCode 第一版采用完整的事件语义和 deny > ask > allow 决策优先级，同时使用类型化 hook 名称与稳定顺序。
- `process` 是跨平台首选；`command` 作为显式 shell 兼容形态保留，并由类型区分。
- hook 不直接修改 core 状态，只返回显式 decision/context/input replacement。
- permission hook 不替代 permission system，只在 `ask` 阶段提供自动决策入口。
- 所有 hook I/O 都必须可观察、可取消、可测试，并挂在同一个 trace 链上。
