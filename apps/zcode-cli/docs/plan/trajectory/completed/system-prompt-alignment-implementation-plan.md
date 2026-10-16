# System Prompt Assembly Historical Plan

日期：2026-06-02

状态：主体已实现。本文是历史完成记录，不再作为 executable implementation plan 使用。

相关提交：

- `5f073d6a feat(zcode-cli): align system prompt assembly`
- `37de3682 fix(zcode-cli): align provider-visible prompt identity`
- `523f1332 fix(zcode-cli): align git system context prompt`

## 原始目标

在 active system prompt slice 内，确定 zcode-cli 最终发送给 model provider 的 system prompt 内容、结构和顺序：

- P-01：稳定 ZCode CLI/product identity prefix。
- P-02：default stable system body。
- P-03：`systemPrompt` 的 custom prompt 语义（替换 default body，保留 CLI prefix 与 request-level context）。
- P-04：第一批 active dynamic system sections：`session_guidance`、`language`、`output_style`、`frc`、`summarize_tool_results`。
- P-05：git/env_info/project_context provider-visible context 策略。

不在本 slice 内实现：request-level `userContext`、follow-up attachments、P-12 tool schema text、P-13 ToolSearch、postponed MCP instructions、auxiliary/side request prompt chrome。

## 完成状态

| Slice | 状态 | 结果 |
| --- | --- | --- |
| SP-S1 CLI prefix + stable body | Done | Provider-visible request body 使用独立首条 system message 承载 ZCode CLI prefix；stable body 从 `# Agent Identity` 开始，不重复 prefix 句。 |
| SP-S2 custom prompt semantics | Done | `systemPrompt` 走 custom path：保留 ZCode CLI prefix 和 request-level/meta-user context，跳过 default stable body、dynamic system sections、`env_info`、git snapshot 和 `project_context`；已移除独立 `overrideSystemPrompt` 输入，避免第二套覆盖语义。 |
| SP-S3 active dynamic sections | Done | 已补 `session_guidance`、current-prompt-language guidance、`output_style`、FRC、`summarize_tool_results`，并按下文 “active dynamic system section order” 的相对顺序输出。 |
| SP-S3 postponed dynamic sections | Done as absence | `scratchpad`、`token_budget`、MCP instructions，以及 ZCode 没有对应功能的 dynamic sections 不生成空占位。 |
| SP-S4 git/env_info/systemContext | Partial | `env_info` 已收敛为 env_info_simple，git branch/status/commits 已拆成独立 gitStatus systemContext message 并插在 dynamic system 之后；`project_context` 与 `systemContext` 的完整决策背景和 provider-visible 位置后续单独展开。 |
| SP-S5 prompt-trajectory evidence | Manual evidence | `system-prompt-basic` testcase 和 `git-system-context-check` out request body 已用于人工确认 provider-visible 顺序；当前不扩展 `expect.json` 自动比对能力。 |

## 最终 Provider-Visible Shape

默认主会话：

```text
messages:
  [0] system: ZCode CLI prefix
  [1] system: stable body beginning with # Agent Identity
  [2] system: selected dynamic system sections
  [3] system: optional gitStatus systemContext snapshot when cwd is a git repository
  [4...] user meta context / conversation messages
```

custom body：

```text
messages:
  [0] system: ZCode CLI prefix
  [1] system: custom system body from systemPrompt
  [2...] user meta context / conversation messages
```

active dynamic system section order:

```text
session_guidance
memory
env_info_simple
language
output_style
frc
summarize_tool_results
```

## Implementation Evidence

| Area | Evidence |
| --- | --- |
| ContextBuilder boundaries | `apps/zcode-cli/packages/core/tests/context-builder.test.ts` covers separate prefix/stable/dynamic/git systemContext messages, custom body, default semantic anchors, current-prompt-language guidance, output style framing, FRC and summarize conditions. |
| Runtime request shape | `apps/zcode-cli/packages/core/tests/runtime-trace.test.ts` covers `systemPrompt`, no request-time context prefix mutation after MCP initialization, and multi-turn request shape with dynamic sections plus MCP tools. |
| Bootstrap locale boundary | `apps/zcode-cli/packages/bootstrap/tests/session-persistence.test.ts` covers UI locale detection/persistence while keeping provider-visible language guidance independent of locale, plus model refresh and resume-time git systemContext snapshot stability. |
| Prompt trajectory | `apps/zcode-cli/tools/prompt-trajectory/testcases/system-prompt-basic/` and `apps/zcode-cli/tools/prompt-trajectory/out/git-system-context-check/trajectories/0001.openai_request_body.json` provide manual provider request-body inspection evidence. |

Focused validation used for this slice:

```bash
pnpm --filter @zcode/core exec vitest tests/context-builder.test.ts tests/runtime-trace.test.ts tests/runtime-hooks.test.ts tests/runtime-memory.test.ts tests/mcp-runtime.test.ts --run
pnpm --filter @zcode/bootstrap exec vitest tests/session-persistence.test.ts --run
pnpm --filter @zcode/prompt-trajectory typecheck
```

## Residual Follow-Ups

| Item | Status | Note |
| --- | --- | --- |
| SP-S4 project_context / systemContext background | Follow-up | 需要后续单独展开当时的决策背景、`systemContext` 语义、ZCode `project_context` provider-visible surface，以及是否继续收敛。 |
| Auxiliary / side request prompt chrome | Out of scope | 不作为本 system prompt active slice 的验收标准；应在 auxiliary request / P-36 / P-37 独立文档中处理。 |
| Prompt-trajectory `expect.json` automation | Skipped | 当前只保留人工 request-body evidence；不在本次 cleanup 中实现自动比对。 |
| Full repo checks | Not recorded here | 本历史记录只列 focused validation；repo-wide `pnpm typecheck` / `pnpm lint` 结果不作为该历史 plan 的完成证明。 |

## Completion Notes

- 原 executable checklist 已移除，避免后续 agent 误按旧步骤重复实现或重复提交。
- 旧 plan 中的中间态 code snippets 已移除；最终实现以当前源码和测试为准。
- 后续若继续推进 SP-S4 或 auxiliary request，应新建/更新独立 plan，而不是复用本文。
