# Feature Boundary Planner ZCode Domain Map

## 背景

`feature-boundary-planner` 从 conversation 专项 skill 泛化为 ZCode 通用功能边界澄清入口后，主流程保留了
formal-proof、case catalog 和用户剪枝方法，但核心是先问清功能边界。后续用户提出“切换模型”
“手机模式”“队列功能”“渲染性能”“持久化数据更新”“监控埋点”“数据跟踪”等问题时，skill 需要先把可能交叉的
产品状态列出来，再引导用户逐步剪枝，而不是只套 conversation 默认维度。

## 目标

- 在 skill 内增加一份 ZCode 能力域和交叉轴参考，帮助使用者从自然语言需求定位相关文档、代码和状态所有者。
- 让矩阵枚举覆盖桌面端、Web 端、手机远控、远程 workspace、model/provider、queue、persistence、telemetry、
  rendering performance、permission/tool/MCP、theme/locale 等真实产品交叉点。
- 保持 `SKILL.md` 精简，把详细 domain map 放入 `references/`，按需加载。
- 保留用户剪枝机制：skill 只能提出候选语义和影响面，不能替用户静默决定产品行为。

## 主要事实源

| 能力域                         | 代表文档                                                                                                                                              | 代表代码入口                                                                                                                                                                   |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 架构与消息流                   | `docs/architecture/zcode-code-architecture-overview.md`, `docs/architecture/message-flow.md`                                                          | `packages/shared`, `packages/services`, `packages/desktop`, `packages/ui`, `apps/zcode-cli`                                                                                    |
| Conversation 状态空间          | `docs/zcode-protocol.md`, `docs/conversation-product-state-space.md`, `docs/testing/conversation-session-*.md`                                        | `packages/formal-proof`, `packages/ui/src/v4/conversationProjectionStore.ts`, `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/`                                       |
| 模型与 Provider                | `docs/working-memory/provider-refactor/design/`                                                                                                       | `packages/provider`, `packages/provider-node`, `packages/services/src/provider-runtime`, `packages/ui/src/settings`                                                            |
| 手机远控与 replayable          | `docs/web-remote-control/*.md`, `docs/zcode-protocol.md`                                                                                              | `packages/shared/src/zcode-protocol-v4/`, `packages/ui/src/v4/agentConversationTransport.ts`, `packages/desktop/src/main/webRemoteControlManager.ts`                           |
| Queue / command                | `docs/ui/chat-message-queue.md`, `docs/zcode-protocol.md`                                                                                             | `packages/shared/src/zcode-protocol-v4/command.ts`, `packages/ui/src/v4/SessionPane.tsx`, `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/commands/handlers/queue.ts` |
| Persistence / identity         | `docs/task/task-sqlite-index.md`, `docs/task/task-snapshot-on-demand.md`, `docs/remote-workspace-session-unified-settings.md`                         | `packages/services/src/session/taskIndexRepo.ts`, `packages/ui/src/store/tabWorkspaceIdentity.ts`, `packages/shared/src/workspaceSessionRestore.ts`                            |
| Rendering performance          | `docs/chat/message-render-performance.md`, `docs/performance/streaming-tool-input-backpressure.md`, `docs/performance/renderer-production-logging.md` | `packages/ui/src/v4/ConversationTimeline.tsx`, `packages/ui/src/v4/ConversationRowView.tsx`, `packages/ui/src/v4/conversationProjectionStore.ts`                               |
| Monitoring / telemetry / usage | `docs/monitoring/performance-telemetry-catalog.md`, `docs/monitoring/business-monitoring.md`, `docs/usage-stats-app-coding-plan-split.md`             | `packages/ui/src/lib/appTelemetry.ts`, `packages/ui/src/lib/uiPerfArmsTelemetry.ts`, `packages/services/src/telemetry`, `packages/services/src/usage-stats`                    |
| Permission / tool / MCP        | `docs/permission-project-approval.md`, `docs/mcp-platform-boundary.md`, `docs/agent-tool-call-renderer.md`                                            | `packages/shared/src/zcode-protocol-v4/`, `packages/shared/src/mcp.ts`, `packages/ui/src/v4/V4InteractionDialogs.tsx`, `packages/ui/src/ToolCallBlocks*`                       |
| Theme / locale / mobile shell  | `docs/ui/zai-themes.md`, `docs/ui/default-theme.md`, `docs/web-remote-control/mobile-theme-control.md`                                                | `packages/ui/src/i18n`, `packages/ui/src/useTheme.ts`, `packages/ui/src/WebRemoteControlMobileShell.tsx`, `packages/shared/src/protocol.ts`                                    |

## Skill 行为要求

1. 当用户给出 ZCode 功能或 bug-prone interaction 时，先把需求映射到 1-4 个能力域，读相应源文档，再看代码。
2. 对每个能力域记录状态所有者：UI local state、Zustand store、host service、desktop main、relay、agent runtime、SQLite /
   session file、remote host 或 backend API。
3. 维度提取必须包含端类型和交付语义：桌面 `desktop-continuous` 与手机 `web-remote-replayable` 不能互相代替。
4. 涉及 workspace 级状态时必须区分 `workspaceIdentity`、`workspacePath` 与 `workspaceKey = workspaceIdentity?.trim() || workspacePath`。
5. 先枚举候选交叉组合，再用 guard、不变量、等价类和代表 case 剪枝；被剪掉的组合必须写明 invariant。
6. `undefined` case 必须转成给用户的小批量问题，包含候选答案和影响面。
7. accepted case 必须说明 setup、action、assertion 和证据层，至少包含一个非 UI 证据层。

## 高风险交叉轴

| 交叉轴                                                                  | 为什么必须显式考虑                                                                                                               |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| 模型切换 x task 切换 / 新建 / 发送 / fork / edit / queue                | 模型事实源跨 toolbar、workspace default、task config、task meta、draft session、provider registry 和 runtime `defaultModelRef`。 |
| 模型/provider x 远程 workspace                                          | 本地 app-global provider registry 与远端 runtime 执行事实源不同，重连和 runtime restart 会暴露旧状态。                           |
| 手机远控 x queue / permission / elicitation / stop                      | 手机端依赖 replayable mirror、snapshot watermark、owner command 和 host command queue，不能按桌面本地 queue 推断。               |
| replayable snapshot x 持久化数据                                        | `ZCodeTaskSnapshot.runtime` 是响应态运行时补充，不写回 session JSON；task index 只负责列表元数据。                               |
| queue x stop / compact / goal / edit / fork                             | queue 是未来用户意图，不能被 compact、edit、fork 隐式改写；stop 后 autoDrain 语义需要明确。                                      |
| rendering performance x streaming tool input / background task / replay | 大工具输入、Markdown、Mermaid、后台任务和 replayable gap 会放大 store 写入、解析和 React render 成本。                           |
| telemetry x message stream / tool step / privacy / volume               | 高频 step/chunk 级事件会放大 ARMS 或日志量；用户内容、credential、hash 和原始 payload 不能进入不该进入的通道。                   |
| theme / locale x desktop / mobile / persisted settings                  | 桌面和手机远控主题本地偏好互不耦合；locale 可能影响命令、菜单、toast、截图断言和测试文案。                                       |
| workspace identity x cache / task list / skill/plugin/MCP load          | 远程 workspace 不能只按 path 做隔离；缓存、队列、配置、任务列表和远程历史都要用 identity fallback 规则。                         |
| tool/MCP/permission x mobile remote                                     | MCP 平台能力通过 `IPlatformService` 和 shared-host attachment 走；permission options 必须透传 agent response，不能由 UI 猜。     |

## 验收

- `feature-boundary-planner` 的 `SKILL.md` 指向新的 domain map reference，并在流程中要求先澄清功能边界，再做能力域映射。
- reference 文件覆盖上述能力域、事实源、状态所有者和高风险交叉轴。
- case planning template 能容纳 domain scope、state owners、高风险交叉和证据层。
- 运行 skill validation、`pnpm typecheck` 和 `pnpm lint`。
