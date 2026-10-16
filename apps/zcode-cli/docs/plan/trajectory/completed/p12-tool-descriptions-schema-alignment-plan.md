# P-12 Tool Descriptions / Schema 收敛计划

日期：2026-06-08

## 目标

收敛 ZCode 当前已支持 tool 在最终发送给 model provider 时的 provider-visible surface：

- `tools[].name`
- `tools[].description`
- `tools[].inputSchema`
- tool 是否出现在 main / Explore child request 的最终 `tools[]`
- ZCode 已支持的 `Agent(Explore)` provider-visible description
- Explore Agent / Explore child 的 provider-visible system prompt

本 plan 不以 registry、Zod、adapter、schema transform 等内部实现形态作为验收目标。只有最终 provider body 中工具是否出现、工具名、description、JSON schema 或 child prompt 发生差异，才进入本轮 P-12。

## 已冻结决策

| ID | 决策 |
| --- | --- |
| TD-D1 | `Read/Write/Edit.file_path` 面向模型的 schema/description 统一为 absolute path 语义；runtime 内部是否继续兼容 relative path 不写进 provider-visible wording。 |
| TD-D2 | `TodoWrite.priority` / `activeForm` 字段形态暂不调整；保留 `priority`，只补齐 `content/status`、status enum 和主动维护 todo 的 guidance。 |
| TD-D3 | `Skill` provider-visible schema 改为 `skill` 字段；runtime 可兼容旧 `name` 输入，但最终工具 schema 不再暴露 `name`。 |
| TD-D4 | `Glob/Grep` 从 main provider `tools[]` 移除，只在 Explore child tool surface 保留。`toolAllowlist` 只能收窄当前 tool pool，不能把 Explore-only tool 提升到 main。 |
| TD-D5 | `GoalRead` 是过期 provider tool，从 provider-visible `tools[]` 删除；goal continuation / verification 继续走 runtime prompt、tool result 或已有 goal flow。 |
| TD-D6 | `Agent` 只覆盖当前 ZCode 已支持的 Explore 子集；同时显式收敛 Explore Agent 的 child system prompt；`model`、custom/team/fork/worktree/isolation/cwd 等未支持能力 postponed。 |
| TD-D7 | `WebSearch` provider-visible schema/description/native-search branch 在本轮 P-12 baseline 中暂时 postponed；后续已由 [WebSearch client tool plan](./websearch-client-tool-implementation-plan.md) 单独落地。 |
| TD-D8 | Read PDF / notebook / SVG / `pages` 等 ZCode 未 provider-ready 能力 postponed；本轮只处理 text/image Read 已支持的能力。 |
| TD-D9 | `ExitPlanMode` V2 / plan-file approval flow postponed；保留当前 ZCode contract。 |
| TD-D10 | `ApplyPatch`、`TodoRead`、`ReadSessionContext`、`Workflow` 作为 ZCode-specific tool 保留；只要求 description/schema truthful，不声明不存在的能力。 |
| TD-D11 | `Skill` 是否进入未来其他 agent / custom agent 的 child tool surface 暂时 postponed；当前只调整 main `Skill` schema，Explore child 不暴露 `Skill`。 |

## Phase 0 Baseline 代码事实

本节记录 plan 启动时的 baseline，不代表 Phase 6 完成后的当前状态。最终状态以 Phase 6 的验证结果为准。

- `registerBuiltInTools(...)` 已有 `includeExploreOnlyTools` 开关，`Glob/Grep` 也已经在 explore-only set 内；但 `AgentRuntime` 构造时恒定传入 `includeExploreOnlyTools: true`，导致 main tool pool 仍暴露 `Glob/Grep`。
- `EXPLORE_AGENT_ALLOWED_TOOLS` baseline 包含 `Bash/Glob/Grep/Read/WebFetch/WebSearch/TodoWrite/Skill`；Explore child tool surface 与“保留 Glob/Grep”目标一致，但 `Skill` 是否属于 Explore child 尚未决策。
- `GoalRead` baseline 仍通过 `targetReadToolEntry` 进入 `builtInTools`，因此会出现在 main provider `tools[]`。
- `Skill` baseline provider schema 是 `{ name, args? }`，handler 也只 parse `name`。
- `Read/Write/Edit` 的 `file_path` provider schema description baseline 仍写有 absolute or relative。
- baseline 测试中有旧期望锁住 main 包含 `Glob/Grep`，需要随实现一起改为新的目标期望。

## 非目标

- 不调整 WebSearch。
- 不实现 Read PDF / notebook / SVG / `pages`。
- 不迁移 Todo runtime/session model 到 `activeForm`。
- 不新增 subagent `model` override 或 custom agent。
- 不决定 `Skill` 是否应该进入未来其他 agent / custom agent 的 child tool surface；当前 Explore child 明确不暴露 `Skill`。
- 不重写 plan mode / `ExitPlanMode` V2 flow。
- 不改变 session store、UI transcript、permission broker、tool execution side effect 行为，除非 provider schema 改动要求 runtime 兼容解析。

## Phase Gate

每个 phase 完成后必须停止，交付以下内容给用户 review，等待用户确认后才能进入下一 phase：

1. 本 phase 改动摘要和影响面。
2. Focused unit test 结果。
3. 与本 phase 对应的 prompt-trajectory e2e 输出目录，并说明需查看的 `*.openai_request_body.json`。
4. 当前 provider-visible diff 是否符合预期，是否有 postponed / residual risk。

## Phase 0：Baseline 和红绿测试准备

状态：已完成。当前 focused tests 按 TDD 预期红灯，失败点是 main 仍暴露 `Glob/Grep/GoalRead`；这是 Phase 1 的目标修复项。Prompt-trajectory baseline 已生成到 `tools/prompt-trajectory/out/p12-tool-surface-phase0/test20260608-163914`。

目标：先锁住当前 provider-visible tool surface，避免后续改动靠人工目测。

### Checklist

- [x] 更新或新增 focused tests，明确当前 target：
  - main runtime provider `tools[]` 不应包含 `Glob` / `Grep` / `GoalRead`。
  - 即使 main `toolAllowlist` 显式包含 `Glob` / `Grep`，也不能提升 Explore-only tools。
  - Explore child provider `tools[]` 应包含 `Glob` / `Grep`，且不包含 edit/write/agent tools。
  - provider-native `web_search` 行为暂不改变，相关断言只保证本轮没有意外删除已有 native projection。
- [x] 新增或更新 prompt-trajectory testcase，覆盖：
  - main basic request tool list。
  - Agent-enabled parent request tool list。
  - Explore child request tool list。
- [x] 记录当前会失败的旧断言，例如 `main-tool-pool.test.ts` 里 main 包含 `Glob/Grep` 的旧期望。

### 预期修改文件

- `apps/zcode-cli/packages/core/tests/main-tool-pool.test.ts`
- `apps/zcode-cli/packages/core/tests/subagent-explore.test.ts`
- `apps/zcode-cli/packages/core/tests/tool-contracts.test.ts`
- `apps/zcode-cli/tools/prompt-trajectory/testcases/p12-tool-surface/*`

### 验证命令

```bash
cd apps/zcode-cli
pnpm --filter @zcode/core exec vitest run tests/main-tool-pool.test.ts tests/subagent-explore.test.ts tests/tool-contracts.test.ts
pnpm --filter @zcode/bootstrap^... build
pnpm --filter @zcode/bootstrap build
pnpm prompt-trajectory:testcases -- --cases testcases/p12-tool-surface --out-root out/p12-tool-surface
```

## Phase 1：Tool Exposure 收敛

状态：已完成。Focused tests 已转绿；prompt-trajectory e2e 输出到 `tools/prompt-trajectory/out/p12-tool-surface-phase1/test20260608-165619`，parent requests 已无 `Glob/Grep/GoalRead`，Explore child request 仍保留 `Glob/Grep`。

目标：只改最终 provider-visible tool list，不调整工具 handler 行为。

### Checklist

- [x] 将 main runtime 的 `includeExploreOnlyTools` 改为仅在 `config.toolset === "explore"` 时开启。
- [x] 保持 `resolveBuiltInToolAllowlist(...)` 与 register filter 的顺序：先按 toolset scope 过滤，再应用 allowlist，确保 allowlist 不能把 `Glob/Grep` 提升到 main。
- [x] 从 provider-visible built-in tool list 中移除 `GoalRead`。
- [x] 保留 `target.ts` / goal runtime 需要的非 provider-visible逻辑；删除 provider tool registration，不删除还被内部引用的 goal continuation / verification 能力。
- [x] 确认 Explore child 仍包含 `Glob/Grep`。
- [x] 确认 ZCode-specific `ApplyPatch/TodoRead/ReadSessionContext/Workflow` 没有被误删。

### 预期修改文件

- `apps/zcode-cli/packages/core/src/runtime/agent-runtime.ts`
- `apps/zcode-cli/packages/core/src/tool/handlers/index.ts`
- `apps/zcode-cli/packages/core/tests/main-tool-pool.test.ts`
- `apps/zcode-cli/packages/core/tests/subagent-explore.test.ts`
- `apps/zcode-cli/packages/core/tests/tool-contracts.test.ts`
- `apps/zcode-cli/packages/core/tests/target-tool.test.ts`

### 验收标准

- main provider request `tools[].name` 不包含 `Glob/Grep/GoalRead`。
- Explore child provider request `tools[].name` 包含 `Glob/Grep`。
- `toolAllowlist: ["Glob", "Grep"]` 在 main 下不会生成这两个 provider tools。

## Phase 2：Provider Schema 硬差异修正

状态：已完成。Focused tests 与 contracts tests 已转绿；prompt-trajectory e2e 输出到 `tools/prompt-trajectory/out/p12-tool-surface-phase2/test20260608-170424`，确认 parent request 中 `Skill` schema 暴露 `skill` 而非 `name`，`Read` provider schema 不再暴露 `pages`，`Read/Write/Edit.file_path` 为 absolute path wording，`TodoWrite` description 包含 proactive / `in_progress` / do-not-mark-complete guidance。`Read.pages` 的 provider-visible 恢复已作为 P-12/Read media-docs postponed item 记录，后续等真实 PDF/pages 能力完成后单独重开；runtime schema 暂保留 legacy `pages` 兼容。

目标：处理 schema 层会直接改变模型输入 contract 的差异。

### Checklist

- [x] `Skill` provider schema 改为 `{ skill: string, args?: string }`。
- [x] `Skill` runtime parser 兼容旧 `{ name: string }` 和新 `{ skill: string }`，但 `inputSchema` 只投影新字段。
- [x] `Skill` handler 内部统一 normalize 成 `skillName`，避免后续代码继续依赖 provider-visible `name`。
- [x] `Read/Write/Edit.file_path` schema description 改为 absolute path 语义。
- [x] `Read.pages` 如果当前没有真实 provider-ready 能力，本轮不新增/不强调；如果字段仍暂时存在，description 必须避免声明未支持能力为可用能力，必要时将其移出 provider schema并保留 runtime-only 兼容。
- [x] `TodoWrite` 保留 `priority`，不加 `activeForm`；补齐 `content/status`、status enum、最多一个 `in_progress` 和主动维护 todo guidance。

### 预期修改文件

- `apps/zcode-cli/packages/contracts/src/tools/skill.ts`
- `apps/zcode-cli/packages/core/src/tool/handlers/skill.ts`
- `apps/zcode-cli/packages/core/src/tool/handlers/read.ts`
- `apps/zcode-cli/packages/core/src/tool/handlers/todo.ts`
- `apps/zcode-cli/packages/core/tests/skill-tool.test.ts`
- `apps/zcode-cli/packages/contracts/src/tools/read.ts`
- `apps/zcode-cli/packages/contracts/src/tools/write.ts`
- `apps/zcode-cli/packages/contracts/src/tools/edit.ts`
- `apps/zcode-cli/packages/contracts/src/tools/todo.ts`
- `apps/zcode-cli/packages/core/tests/tool-contracts.test.ts`
- `apps/zcode-cli/packages/core/tests/tool-input-normalization.test.ts`

### 验收标准

- provider-visible `Skill.inputSchema.properties` 有 `skill`，没有 `name`。
- runtime 执行 `Skill` 时新旧输入都能 parse。
- provider-visible `Read/Write/Edit.file_path` 不再教模型使用 relative path。
- 本轮没有引入 `activeForm`、`Agent.model`、WebSearch 或 Read media capability。

## Phase 3：Common Tool Description / Guidance 补齐

状态：已完成。Focused tests 与 P-12 combined tests 已转绿；prompt-trajectory e2e 输出到 `tools/prompt-trajectory/out/p12-tool-surface-phase3/test20260608-171828`，确认 main / follow-up request 无旧的 `Glob/Grep` main guidance，`Read/Bash/EnterPlanMode/WebFetch` provider-visible description 已覆盖 Phase 3 目标；parent request 仍无 `Glob/Grep/GoalRead`，Explore child 仍保留 `Glob/Grep`。

目标：description 语义覆盖齐全，但不要求逐字一致。

### Checklist

- [x] `Read` description 补齐已支持能力的指引：已知文件路径优先用 Read、目录用 Bash `ls`、默认 line output 语义、空文件/不可读结果不要臆测、不要用 Bash `cat` 替代 Read。
- [x] `Write` description 补齐：已有文件必须先 Read，修改已有文件优先 Edit，不主动创建 docs/README，不默认添加 emoji。
- [x] `Edit` description 补齐：必须先 Read，`old_string` 唯一性，使用 line-number-prefixed Read output 时要还原真实内容，`replace_all` 使用边界。
- [x] `Bash` description 补齐：destructive git / hooks / package install / polling / background / timeout / sandbox override guidance；同时避免 main prompt 无条件要求使用不存在的 `Glob/Grep`。
- [x] `WebFetch` description 只在当前字段范围内补齐 source/quote safety、private/auth URL、redirect、GitHub prefer CLI、MCP preference 等语义；不做 WebSearch/native-search。
- [x] `AskUserQuestion` description 补齐 clarification 使用时机、不要替代 plan approval、Other 选项由客户端提供、preview/multiSelect 使用边界。
- [x] `EnterPlanMode` description 若仍提到 `Glob/Grep/Read`，调整为 main 可用工具事实：main 可用 `Read/Bash/Agent(Explore)`；Explore child 内才有 `Glob/Grep`。
- [x] 保留 ZCode-specific tool truthful wording：`ApplyPatch/TodoRead/ReadSessionContext/Workflow` 只描述自身真实能力。

### 预期修改文件

- `apps/zcode-cli/packages/core/src/tool/handlers/read.ts`
- `apps/zcode-cli/packages/core/src/tool/handlers/write.ts`
- `apps/zcode-cli/packages/core/src/tool/handlers/edit.ts`
- `apps/zcode-cli/packages/core/src/tool/handlers/bash.ts`
- `apps/zcode-cli/packages/core/src/tool/handlers/webfetch.ts`
- `apps/zcode-cli/packages/core/src/tool/handlers/todo.ts`
- `apps/zcode-cli/packages/core/src/tool/handlers/ask-user-question.ts`
- `apps/zcode-cli/packages/core/src/tool/handlers/plan-mode.ts`
- `apps/zcode-cli/packages/core/tests/tool-contracts.test.ts`

### 验收标准

- main provider `Bash.description` 不再无条件指向 main 不存在的 `Glob/Grep`。
- `Read/Write/Edit/Bash/TodoWrite` 的关键行为 guidance 都能在 provider-visible description 中找到。
- description 没有声明 postponed 或未实现能力。

## Phase 4：Glob / Grep Explore-only Schema 和 Description

状态：已完成。Focused tests 已转绿；prompt-trajectory e2e 输出到 `tools/prompt-trajectory/out/p12-tool-surface-phase4-full-description-20260608-175318/test20260608-175318`，确认 parent/follow-up request 仍无 `Glob/Grep/GoalRead`，Explore child request 保留 `Glob/Grep`，且 `Glob/Grep` provider schema path wording 为 current working directory 语义、`additionalProperties: false`，description 保留完整语义：fast pattern matching / ripgrep search、mtime 排序、regex/filter/output mode、禁止 Bash grep/rg 替代，以及 open-ended multi-round search 交给 Agent tool。

目标：只在 Explore child surface 提供 `Glob/Grep`，main 不再暴露。

### Checklist

- [x] `Glob` schema 字段收敛到当前 ZCode 支持范围：`pattern` required，`path` optional，strict object。
- [x] `Glob` description 聚焦 fast file pattern matching、modification-time sorting、find files by name patterns，以及 open-ended multi-round search 使用 Agent tool。
- [x] `Grep` schema 字段收敛到当前 ZCode 支持范围：`pattern` required，`path/glob/output_mode/-A/-B/-C/context/-n/-i/type/head_limit/offset/multiline` 等已支持字段保持 truthful。
- [x] `Grep` description 聚焦 ripgrep-compatible search、regex、glob/type filter、output modes、不要用 Bash `grep/rg` 替代专用工具，以及 open-ended multi-round search 使用 Agent tool。
- [x] 如果同一 description 仍被 registry 共享，必须确认 main 已不会看到 `Glob/Grep` tool contract。

### 预期修改文件

- `apps/zcode-cli/packages/contracts/src/tools/glob.ts`
- `apps/zcode-cli/packages/contracts/src/tools/grep.ts`
- `apps/zcode-cli/packages/core/src/tool/handlers/glob.ts`
- `apps/zcode-cli/packages/core/src/tool/handlers/grep.ts`
- `apps/zcode-cli/packages/core/tests/tool-contracts.test.ts`
- `apps/zcode-cli/packages/core/tests/subagent-explore.test.ts`

### 验收标准

- Explore child request 中 `Glob/Grep` schema/description 覆盖完整。
- main request 中没有 `Glob/Grep`，因此不会收到它们的 description。

## Phase 5：Agent Tool Description + Explore Agent Prompt 收敛

状态：已完成。Focused tests 已转绿；prompt-trajectory e2e 输出到 `tools/prompt-trajectory/out/p12-tool-surface-phase5-agent-full-usage-20260608-182624/test20260608-182625`，确认 parent request 的 `Agent` description 覆盖完整 usage notes 中 ZCode 已支持的部分：description/prompt 参数说明、result relay、trust-but-verify、background/foreground、fresh agent/self-contained prompt、parallel launch 和 available agents；同时覆盖 open-ended codebase research、stateless child、parent relay、background/parallel usage，且未暴露 `model` / `isolation` 字段。Explore child system prompt 覆盖 read-only file-search/codebase-research specialist、tool priority、read-only shell pipeline 允许边界、final report guidance，并移除旧的 `|` 管道误禁。Explore child 不写入 `Skill` guidance，也不暴露 `Skill` tool；main `Skill` tool schema 调整仍属于 Phase 2。

目标：同时收敛两个 provider-visible 面：main request 里 `Agent` tool 的 description/schema，以及 Explore child request 里的 Explore Agent system prompt。不引入 ZCode 未支持的 agent feature。

### Checklist

- [x] `Agent` provider description 改为 Explore routing 语义：适合 open-ended codebase research / locating files / references / answering where/how questions；不应继续写成“不适合 open-ended analysis”这种与 Explore 目标冲突的描述。
- [x] `Agent` description 明确 Explore 是 stateless、read-only、final answer 只返回给 parent，需要 parent relay。
- [x] `Agent` schema 保持只暴露当前支持字段：`description/prompt/run_in_background/subagent_type: "Explore"`；不加 `model`。
- [x] Explore Agent prompt 的 identity / role framing 改为 read-only file-search and codebase research specialist 语义，同时保留 ZCode identity。
- [x] Explore Agent prompt 的 read-only critical section 补齐：禁止创建、修改、删除、移动、复制文件，禁止临时文件，禁止会改变文件/process/system state 的 Bash 命令。
- [x] 修正 Explore Agent prompt 中 “Using redirect operators (>, >>, |) ...” 对 `|` 的过宽禁止：禁止重定向 / heredoc 写文件和 state-changing command，但允许 read-only pipeline。
- [x] Explore Agent prompt 的 tool guidance 与最终 child `tools[]` 一致：优先 `Glob` 找文件、`Grep` 搜内容、`Read` 读已知路径、`Bash` 只做 read-only shell 操作；不允许再 spawn agent。
- [x] Agent description 与 Explore Agent prompt 保持 ZCode 真实扩展工具面：WebFetch/TodoWrite guidance 只描述当前已支持行为；`Skill` 不写入 Explore system prompt，且不进入 Explore child `tools[]`；`WebSearch` / native-search exact schema 和 provider-specific request body 在本轮 P-12 baseline 中 postponed，后续已由 WebSearch client tool plan 单独落地；Agent description 和 Explore prompt 允许用语义化 `WebSearch` 指导 current / post-knowledge-cutoff information search。
- [x] Explore Agent prompt 的 final answer guidance 补齐：直接回答、给出证据文件路径、只在必要时引用代码片段、证据不足时说明缺口、输出足够紧凑供 parent agent 继续处理。

### 预期修改文件

- `apps/zcode-cli/packages/contracts/src/tools/agent.ts`
- `apps/zcode-cli/packages/core/src/tool/handlers/agent.ts`
- `apps/zcode-cli/packages/core/src/subagent/explore.ts`
- `apps/zcode-cli/packages/core/tests/subagent-explore.test.ts`
- `apps/zcode-cli/packages/core/tests/tool-contracts.test.ts`

### 验收标准

- Parent request 有 `Agent` 时，其 description 明确 Explore 的使用场景和限制。
- Explore child request 的 system prompt 明确是 read-only file-search/codebase-research specialist，并覆盖 read-only boundary、tool priority、final answer guidance。
- Explore child request 的 system prompt 不误禁 read-only pipe。
- Child request tool list 与 Phase 1 目标一致。

## Phase 6：Prompt Trajectory E2E 和文档收口

状态：已完成。Focused tests / touched package typecheck / prompt-trajectory e2e / request-body 抽检已通过；`tools/prompt-trajectory/out/p12-tool-surface-final-review-20260608-184856/test20260608-184857` 是最终 Phase 6 evidence。`pnpm typecheck` / `pnpm lint` 在 root 或 `apps/zcode-cli` 入口被本地 pnpm/turbo 环境阻塞，已用 touched package `tsc --noEmit` 与 touched-file `oxlint` 兜底验证；阻塞细节见本节下方。

目标：用 provider-visible request body 做最终验收，并同步本计划状态。

### Checklist

- [x] 跑 main request testcase，检查 `tools[].name`、`Skill.inputSchema`、`Read/Write/Edit.file_path` description。
- [x] 跑 Agent-enabled parent/Explore child testcase，检查 parent 无 `Glob/Grep/GoalRead`，child 有 `Glob/Grep`。
- [x] 检查 Explore child request 的 system prompt，确认 Phase 5 的 identity、read-only boundary、tool priority、final answer guidance 都 provider-visible。
- [x] 对比生成的 `*.openai_request_body.json`，确保没有 request top-level / message-level runtime metadata 泄漏。`AskUserQuestion.metadata.source` 是 provider-visible tool schema 字段，不属于 runtime metadata。
- [x] 更新本计划各 phase 状态与验证结果。
- [x] 在 `trajectory-align-log.md` 当天条目下合并记录本轮 P-12 实现摘要。

### Phase 6 验证结果

- Focused core tests：`packages/core` 下 `main-tool-pool`、`subagent-explore`、`tool-contracts`、`skill-tool`、`tool-input-normalization`、`target-tool` 共 6 files / 36 tests 通过。
- Focused contracts tests：`packages/contracts/tests/grep.test.ts` 1 file / 1 test 通过。
- Touched package typecheck：`@zcode/contracts`、`@zcode/core`、`@zcode/bootstrap` 的 `tsc --noEmit` 均通过。
- Build for trajectory：`@zcode/contracts`、`@zcode/core`、`@zcode/bootstrap` 的 `tsc` build 均通过。
- Prompt trajectory：`tools/prompt-trajectory/out/p12-tool-surface-final-review-20260608-184856/test20260608-184857`。
- Request-body 抽检：parent request 有 `Agent/Skill` 且无 `Glob/Grep/GoalRead`；Explore child 有 `Read/Bash/Glob/Grep` 且无 `Agent/Skill/Write/Edit/ApplyPatch/GoalRead`，本轮 P-12 baseline fixture 未出现 provider-native `web_search`；`Skill` schema 有 `skill` 无 `name`；`Read/Write/Edit.file_path` description 为 absolute path；`Agent` schema 无 `model/isolation`；Agent description 和 Explore prompt 可语义提示 `WebSearch`。`WebSearch` / native-search exact schema 和 provider-specific request body 后续已由 WebSearch client tool plan 单独落地；Explore prompt 无旧 `|` pipe 误禁且不包含 `Use Skill`。
- Touched-file lint：P-12 touched `contracts/core/bootstrap` src/tests 文件通过 `oxlint`。
- `git diff --check`：通过。

阻塞说明：

- root `pnpm typecheck` / `pnpm lint` 被 pnpm deps status check 阻塞：无 TTY 时拒绝清理 `node_modules` 并退出。
- `apps/zcode-cli` 的 `pnpm typecheck` / `pnpm lint` 被本地 `turbo` shim 阻塞：找不到 `apps/zcode-cli/node_modules/turbo/bin/turbo`。
- 更广的 package `oxlint src tests` 命中既有 `max-lines` / unused / optional-chaining 问题，例如 `core/src/workflow/lifecycle.ts`、`core/src/subagent/runner.ts`、`contracts/src/model/index.ts`、`bootstrap/src/zcode-protocol/session-mapper.ts` 等，不属于本轮 P-12 touched file。

### 预期验证命令

```bash
cd apps/zcode-cli
pnpm --filter @zcode/core exec vitest run tests/main-tool-pool.test.ts tests/subagent-explore.test.ts tests/tool-contracts.test.ts tests/skill-tool.test.ts tests/tool-input-normalization.test.ts
pnpm --filter @zcode/core exec vitest run tests/target-tool.test.ts
pnpm --filter @zcode/contracts exec vitest run tests/grep.test.ts
pnpm --filter @zcode/bootstrap^... build
pnpm --filter @zcode/bootstrap build
pnpm prompt-trajectory:testcases -- --cases testcases/p12-tool-surface --out-root out/p12-tool-surface
pnpm typecheck
pnpm lint
git diff --check
```

如果 full `pnpm lint` 被既有未触碰问题阻塞，需要在交付中列出阻塞文件和 focused lint/typecheck 结果，不能把 blocked 说成 passed。

## 风险点

- `Skill.skill` 是 provider schema breaking change；需要 runtime parser 兼容旧 `name`，并检查 trajectory/replay 中历史 tool call 是否还能执行。
- 移除 main `Glob/Grep` 会改变模型可用搜索路径；需要确认 `Agent` 在 subagent capability 可用时已暴露，且 Bash/plan-mode guidance 不再要求 main 直接使用 `Glob/Grep`。
- 删除 `GoalRead` provider tool 不能影响 goal continuation / verification 的内部 prompt 或 tool result flow；需要 focused test 保证 goal runtime 仍可工作。
- `Bash` description 是 main 和 Explore 共享的 provider text；需要避免写成某个 surface 独有事实，除非最终只有该 surface 可见。
- `Read.pages` 当前字段和真实能力之间可能存在历史不一致；Phase 2 需要先确认 handler/provider 是否真的支持，再决定是移出 provider schema还是改成 postponed-safe wording。

## 执行备注

- 每个 phase 结束后必须停止等待用户 review，不自动进入下一 phase。
- 不自动 commit；只有用户明确要求 commit 时才提交。
- 代码注释如必须新增，使用中文解释 bug/设计原因，不在代码注释里提其他产品名。
- Plan 完成态只在 Phase 6 验收通过并更新本计划状态后标记。
