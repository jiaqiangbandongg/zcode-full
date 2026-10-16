# CLI 工具可见性 Denylist Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. 本文同时作为 `--disallowedTools` 的初始设计 spec；实现前若语义变化，先更新本文再改代码。

**Goal:** 为 `zcode` CLI 增加 `--disallowedTools` / `--disallowed-tools <tools...>`，让用户在单次运行中把指定工具规则从 runtime tool pool 中移除，而不是只改变审批权限。

**Architecture:** 新增 runtime-scoped `toolDisallowlist`，由 CLI 解析后透传到 `AgentRuntimeConfig`。built-in、MCP、embedded search、subagent child runtime 都在注册或派生工具集时消费同一份 denylist，保证被禁工具不会进入 provider-visible `tools[]`，也不会留在本地可执行 registry 中。

**Tech Stack:** TypeScript, Node `parseArgs`, Vitest, zcode-cli core runtime, built-in tool registry, MCP registry, subagent runtime。

## Global Constraints

- 先写 spec，再实现；本文是本功能的初始 spec。
- `--disallowedTools` 的语义是工具暴露移除，不复用 `permission.disallowedTools`。
- `--disallowed-tools` 与 `--disallowedTools` 共用一个 help 条目，说明从本次 prompt/TUI 的可用工具集中移除整个工具；示例使用 `"Bash Edit"` 或 `Bash,Edit`，避免暗示支持按命令内容匹配。
- `<tools...>` 是 variadic，支持逗号或括号外普通空格分隔。兼容接收 `Bash(git *)` 等规则字符串，但过滤只使用括号前的工具名：该输入会移除整个 `Bash`，不会只限制 `git *`。
- denylist 只作用于本次 CLI runtime，不写入持久化配置。
- agent schema 语义是：显式 `tools` 替换默认工具集；`disallowedTools` 只从默认工具集移除，且 `tools` 存在时忽略 `disallowedTools`。ZCode CLI 主会话本阶段没有公开 `--tools` flag；内部 `toolAllowlist` 与 CLI `toolDisallowlist` 同时存在时按 deny wins 处理，避免把被 CLI deny 的默认工具重新暴露。
- 需要同时覆盖 headless prompt 与 TUI prompt 创建链路。
- 需要覆盖 built-in tools、MCP tools、embedded search branch、subagent child runtime。
- 不修改 desktop/app-server/mobile remote 协议；本阶段只做 zcode-cli runtime 范围。
- 修改完成后至少执行目标测试；合入前执行 `pnpm typecheck` 与 `pnpm lint`。

---

## 术语与边界

- **permission denylist**：已有 `permission.disallowedTools`，表示审批/执行权限规则。它不等价于工具是否出现在模型请求里。
- **visibility denylist**：本功能新增 `toolDisallowlist`，表示工具从 runtime 可见与可执行集合中移除。
- **provider-visible tools**：最终发给模型请求的 `tools[]`。
- **registry tools**：runtime 内部已注册、可执行的工具集合。
- **parent denylist**：由 top-level CLI flag 得到的 `toolDisallowlist`。
- **subagent profile denylist**：已有 subagent profile/frontmatter 的 `disallowedTools`，只表达子 agent 自己再减去哪些工具。

## 用户可见语义

### CLI help 契约

- 中英文 help 统一使用 `-p, --prompt <text>`，提示词作为一个字符串参数传入。
- 不展示解析器未实现的 `--print`、`--settings`、`--permission-mode`、`--max-turns`、`--allowed-tools`、`--allow-main-worktree-yolo`；它们继续按未知参数报错，不新增兼容解析。
- denylist 只在一个条目中列出两个别名，说明仅作用于本次 prompt/TUI，不修改持久化配置，也不是按命令内容匹配的权限规则。
- 本次整理只修正文案及文档，不改变参数解析、工具注册、权限、协议或会话生命周期。

### Flag 语义基线

- CLI help 暴露 `--disallowedTools, --disallowed-tools <tools...>`，描述为逗号或空格分隔的 tool names to deny。
- SDK/子进程转发路径会把 `disallowedTools` 数组序列化为 `--disallowedTools` 加逗号拼接值。
- command/skill frontmatter 里同时有 `disallowed-tools` 与规范化别名 `disallowedTools`；语义是当前文件 active 时从模型工具面移除。
- agent schema 里 `disallowedTools` 的语义是从默认工具集移除；如果显式设置 `tools`，则忽略 `disallowedTools`。
- ZCode 本阶段把 `-p` 作为 `--prompt` 的短别名，表达 headless prompt 入口。

### 支持的 flag

```bash
zcode --disallowedTools Bash,Edit -p "分析一下"
zcode --disallowed-tools Bash,Edit -p "分析一下"
zcode --disallowedTools Bash --disallowedTools Edit -p "分析一下"
zcode -p "分析一下" --disallowedTools Bash Edit
zcode -p "分析一下" --disallowed-tools "Bash Edit"
```

### variadic 边界

```bash
# 这会被解析成 disallowedTools = ["Bash", "Edit"]，prompt = "分析一下"，
# 因为 <tools...> 会吞掉后续裸 positional，直到遇到下一个 option；-p 是 option 边界。
zcode --disallowedTools Bash Edit -p "分析一下"

# 如果后面没有 option 边界，裸 positional 会继续被当成 disallowedTools。
zcode --disallowedTools Bash Edit SomeBareToken

# 这会被解析成 disallowedTools = ["Bash(git *)", "Edit"]，
# 因为 quoted token 内部仍按括号外普通空格拆分，括号内的 `git *` 保持在同一条规则里。
# 注册工具时只取括号前的名称，因此会移除整个 Bash 和 Edit，不做 git 命令匹配。
zcode -p "分析一下" --disallowedTools "Bash(git *) Edit"
```

### 名称归一化

- 输入按每个 argv token 内的逗号或普通空格分割，括号内的逗号/空格不分割，去掉空项。
- 支持完整工具规则字符串，例如 `Bash(git *)`、`Read(~/.zshrc)`、`mcp__github__get_issue`。
- 工具名匹配取规则字符串的 tool name 前缀：`Bash(git *)` 的 tool name 是 `Bash`；无括号时整个字符串是 tool name。
- `web_search` 归一化为 `WebSearch`，对齐现有 allowlist helper。
- 其余 tool name 保持 case-sensitive。
- `Bash(git *)` 这类带参数的规则在本功能中会移除整个 `Bash` tool，而不是只移除某个 Bash command 子规则；这是因为 provider-visible `tools[]` 只能按 tool schema 出现或消失，不能只隐藏 Bash 的某个命令模式。

## 影响面文件

### 需要创建或修改的设计文档

- Modify: `apps/zcode-cli/docs/design/v2/tool/18-cli-tool-visibility-denylist.md`
- Optional Modify: `apps/zcode-cli/docs/design/v2/tool/README.md`
- Optional Modify: `apps/zcode-cli/docs/design/v2/tool/00-tool-change-chain.md`

### CLI 入口

- Modify: `apps/zcode-cli/packages/cli/src/run.ts`
- Modify: `apps/zcode-cli/packages/cli/src/prompt-command.ts`
- Modify: `apps/zcode-cli/packages/cli/src/tui-command.ts`
- Modify: `apps/zcode-cli/packages/cli/src/tui-prompt-handler.ts`
- Modify: `apps/zcode-cli/packages/i18n/src/locales/en-US.ts`
- Modify: `apps/zcode-cli/packages/i18n/src/locales/zh-CN.ts`

### Runtime 配置与工具注册

- Modify: `apps/zcode-cli/packages/core/src/runtime/types.ts`
- Modify: `apps/zcode-cli/packages/core/src/runtime/helpers/tool-allowlist.ts`
- Create: `apps/zcode-cli/packages/core/src/tool/tool-visibility.ts`
- Modify: `apps/zcode-cli/packages/core/src/runtime/agent-runtime.ts`
- Modify: `apps/zcode-cli/packages/core/src/runtime/methods/embedded-search-branch.ts`
- Modify: `apps/zcode-cli/packages/core/src/runtime/methods/mcp.ts`
- Modify: `apps/zcode-cli/packages/core/src/runtime/methods/subagent.ts`
- Modify: `apps/zcode-cli/packages/core/src/tool/handlers/index.ts`
- Modify: `apps/zcode-cli/packages/core/src/mcp/index.ts`

### 测试

- Modify: `apps/zcode-cli/packages/cli/tests/cli.unit.test.ts`
- Modify: `apps/zcode-cli/packages/core/tests/main-tool-pool.test.ts`
- Modify: `apps/zcode-cli/packages/core/tests/mcp-tool-bridge.test.ts`
- Modify: `apps/zcode-cli/packages/core/tests/subagent-explore.test.ts`

实现时优先追加到已有测试文件，不为单个小断言拆出新测试文件。

---

## Phase 0: 实现前确认

**目标:** 确认当前工作树、测试命令和目标文件仍与本文一致。

**Checklist**

- [ ] 运行 `git status --short --branch`，确认没有未理解的用户改动。
- [ ] 运行 `rg "toolAllowlist|disallowedTools|allowedTools" apps/zcode-cli/packages -n`，确认相关入口没有再次大幅迁移。
- [ ] 运行 `rg "parseGlobalArgs|runPrompt|createTuiSubmitPrompt" apps/zcode-cli/packages/cli -n`，确认 CLI 入口位置。
- [ ] 运行 `rg "RegisterBuiltInToolsOptions|RegisterMcpToolsOptions|resolveSubagentToolAllowlist" apps/zcode-cli/packages/core -n`，确认工具注册与 subagent 派生位置。
- [ ] 如果发现文件位置变化，先更新本文“影响面文件”再继续。

**验收**

- [ ] 本文列出的入口文件和当前代码一致。
- [ ] 没有代码实现改动发生在 Phase 0。

---

## Phase 1: CLI 解析与 runtime config 透传

**目标:** CLI 能接受 `--disallowedTools` / `--disallowed-tools`，并把归一化后的工具名数组传入 runtime config。

**Files**

- Modify: `apps/zcode-cli/packages/cli/src/run.ts`
- Modify: `apps/zcode-cli/packages/cli/src/prompt-command.ts`
- Modify: `apps/zcode-cli/packages/cli/src/tui-command.ts`
- Modify: `apps/zcode-cli/packages/cli/src/tui-prompt-handler.ts`
- Modify: `apps/zcode-cli/packages/core/src/runtime/types.ts`
- Modify: `apps/zcode-cli/packages/cli/tests/cli.unit.test.ts`

**Interfaces**

- Produces:
  - `AgentRuntimeConfig.toolDisallowlist?: readonly string[]`
  - CLI normalized denylist: `readonly string[] | undefined`
- Consumes later:
  - Phase 2 registry filters consume `toolDisallowlist`
  - Phase 4 subagent inheritance consumes `toolDisallowlist`

**Checklist**

- [ ] 在 `AgentRuntimeConfig` 增加 `toolDisallowlist?: readonly string[]`。
- [ ] 在 `parseGlobalArgs` 的 `prompt` option 增加 `short: "p"`，让文档示例里的 headless prompt 入口可运行。
- [ ] 在 `parseGlobalArgs` 之前增加 `extractDisallowedToolsArgs` 预处理：
  - [ ] 支持 `--disallowedTools`
  - [ ] 支持 `--disallowed-tools`
  - [ ] 支持 `--disallowedTools=value`
  - [ ] 支持同一 flag 重复出现
  - [ ] 消费后续 argv token，直到遇到下一个 option token
- [ ] 不把 `--disallowedTools` 直接交给 `node:util.parseArgs`；当前 Node `parseArgs` 不能表达所需的 `<tools...>` variadic 行为。
- [ ] 增加 CLI 层归一化 helper，行为为：
  - [ ] 接受预处理收集到的 `readonly string[]`
  - [ ] 按逗号或括号外普通空格分割；括号内的逗号/空格保持在当前规则里
  - [ ] 去掉空项
  - [ ] `web_search` 转为 `WebSearch`
  - [ ] 去重且保持首次出现顺序
  - [ ] 空数组返回 `undefined`
- [ ] `runPrompt` 签名增加 `toolDisallowlist?: readonly string[]`。
- [ ] headless `createZCodeApp` 的 `runtimeConfig` 增加 `toolDisallowlist`。
- [ ] `runTuiCommand` 签名增加 `toolDisallowlist?: readonly string[]`。
- [ ] `createTuiSubmitPrompt` 签名增加 `toolDisallowlist?: readonly string[]`。
- [ ] TUI `createZCodeApp` 的 `runtimeConfig` 增加 `toolDisallowlist`。
- [ ] 不把 `toolDisallowlist` 写入 `resolveAppConfigOptions` 或任何持久化 config override。

**测试 Checklist**

- [ ] CLI 单测覆盖 `--disallowedTools Bash,Edit`。
- [ ] CLI 单测覆盖 `--disallowed-tools Bash,Edit`。
- [ ] CLI 单测覆盖重复传参 `--disallowedTools Bash --disallowedTools Edit`。
- [ ] CLI 单测覆盖 `--disallowedTools Bash Edit --prompt "hello"` 的 variadic option-boundary 行为。
- [ ] CLI 单测覆盖 `-p "hello" --disallowedTools Bash`。
- [ ] CLI 单测覆盖 `--disallowedTools "Bash(git *) Edit"`。
- [ ] CLI 单测覆盖 `--disallowedTools web_search` 传入 runtime 后是 `WebSearch`。
- [ ] CLI 单测覆盖空值不会生成空数组。
- [ ] CLI 单测保持 unknown option strict reject 行为。
- [ ] TUI prompt handler 单测覆盖 runtimeConfig 带 `toolDisallowlist`。

**建议测试命令**

```bash
pnpm --filter @zcode/cli exec node --disable-warning=DEP0205 --import tsx --test tests/cli.unit.test.ts
```

如果该 filter 名称不匹配，先运行：

```bash
pnpm -r list --depth -1 | rg "@zcode/cli|zcode-cli"
```

**验收**

- [ ] `zcode --disallowedTools Bash,Edit -p "..."` 不再因 unknown option 失败。
- [ ] `zcode -p "..." --disallowedTools Bash` 可运行。
- [ ] headless 与 TUI 都能把 denylist 传进 `AgentRuntimeConfig`。
- [ ] 尚未要求 denied tool 真正被移除；这是 Phase 2 的验收。

---

## Phase 2: built-in 与 MCP 注册层移除工具

**目标:** 被 `toolDisallowlist` 命中的 built-in/MCP tool 不进入 runtime registry。

**Files**

- Modify: `apps/zcode-cli/packages/core/src/runtime/helpers/tool-allowlist.ts`
- Create: `apps/zcode-cli/packages/core/src/tool/tool-visibility.ts`
- Modify: `apps/zcode-cli/packages/core/src/runtime/agent-runtime.ts`
- Modify: `apps/zcode-cli/packages/core/src/tool/handlers/index.ts`
- Modify: `apps/zcode-cli/packages/core/src/runtime/methods/mcp.ts`
- Modify: `apps/zcode-cli/packages/core/src/mcp/index.ts`
- Modify: `apps/zcode-cli/packages/core/tests/main-tool-pool.test.ts`
- Modify: `apps/zcode-cli/packages/core/tests/mcp-tool-bridge.test.ts`

**Interfaces**

- Produces:
  - `normalizeToolNameAlias(toolName: string): string`
  - `getToolRuleName(rule: string): string`
  - `createToolRuleNameSet(rules?: readonly string[]): ReadonlySet<string> | undefined`
  - `isToolNameDisallowed(toolName: string, disallowedTools?: readonly string[]): boolean`
  - `filterDisallowedToolNames(toolNames: readonly string[], disallowedTools?: readonly string[]): readonly string[]`
  - `RegisterBuiltInToolsOptions.disallowedTools?: readonly string[]`
  - `RegisterMcpToolsOptions.disallowedTools?: readonly string[]`
- Consumes:
  - `AgentRuntimeConfig.toolAllowlist`
  - `AgentRuntimeConfig.toolDisallowlist`

**Checklist**

- [ ] 新增 `tool/tool-visibility.ts`，把 tool rule name 提取、alias 归一化和 denylist 过滤收敛到一个 helper。
- [ ] 迁移 `web_search -> WebSearch` 归一化到共享 helper，保留现有 `resolveBuiltInToolAllowlist` 行为兼容。
- [ ] `registerBuiltInTools` options 增加 `disallowedTools`。
- [ ] built-in 注册循环判断顺序为：
  - [ ] 如果 `allowedTools` 存在且当前工具不在其中，跳过
  - [ ] 如果当前工具在 `disallowedTools` 中，跳过
  - [ ] 否则注册
- [ ] `AgentRuntime` 构造时把 `this.config.toolDisallowlist` 传给 `registerBuiltInTools`。
- [ ] `RegisterMcpToolsOptions` 增加 `disallowedTools`。
- [ ] MCP 注册循环按 exact tool name 执行 deny 过滤。
- [ ] `runtime/methods/mcp.ts` 把 `this.config.toolDisallowlist` 传给 MCP 注册。
- [ ] 不在 provider adapter 层额外做主逻辑过滤；过滤主责任放在 registry 注册层。
- [ ] 可选增加 defensive filter：`filterRuntimeVisibleTools` 可再次过滤 denied tool，但不能作为唯一防线。

**测试 Checklist**

- [ ] core 单测覆盖 `toolDisallowlist: ["Bash"]` 后 registry 没有 `Bash`。
- [ ] core 单测覆盖 `toolDisallowlist: ["Bash(git *)"]` 后 registry 没有 `Bash`。
- [ ] core 单测覆盖 provider-visible `tools[]` 没有 `Bash`。
- [ ] core 单测覆盖 `toolAllowlist: ["Read", "Bash"]` 且 `toolDisallowlist: ["Bash"]` 时只剩 `Read`。
- [ ] core 单测覆盖 `toolDisallowlist: ["web_search"]` 后 provider-visible 不包含 `WebSearch`。
- [ ] MCP 单测覆盖 exact MCP tool name 被 deny 后不注册。
- [ ] MCP 单测覆盖 `mcp__server__tool(*)` 按 tool name 前缀移除同名 MCP tool。
- [ ] MCP 单测覆盖 deny 不影响其他同 server tools。

**建议测试命令**

```bash
pnpm --filter @zcode/core exec vitest run tests/main-tool-pool.test.ts tests/mcp-tool-bridge.test.ts
```

**验收**

- [ ] denied built-in tool 不出现在 registry。
- [ ] denied built-in tool 不出现在 provider-visible `tools[]`。
- [ ] denied MCP tool 不出现在 registry。
- [ ] deny wins 规则有测试证明。

---

## Phase 3: embedded search branch 语义对齐

**目标:** `Bash` 被 deny 时，embedded search branch 不再误判 Bash 可用。

**Files**

- Modify: `apps/zcode-cli/packages/core/src/runtime/methods/embedded-search-branch.ts`
- Modify: `apps/zcode-cli/packages/core/tests/main-tool-pool.test.ts`

**Interfaces**

- Consumes:
  - `AgentRuntimeConfig.toolAllowlist`
  - `AgentRuntimeConfig.toolDisallowlist`
  - Phase 2 的 visibility helper
- Produces:
  - `resolveRuntimeEmbeddedSearchEnabled` 正确考虑 denylist

**Checklist**

- [ ] 更新 `resolveRuntimeEmbeddedSearchEnabled` 的 `bashAvailable` 判断。
- [ ] 判断语义为：
  - [ ] allowlist 不存在或包含 `Bash`
  - [ ] 且 denylist 不包含 `Bash`
- [ ] 保持现有 `toolset === "explore"` 行为。
- [ ] `refreshBranchAwareBuiltInTools` 注册 direct search fallback 工具时继续传入 allowlist 与 denylist。
- [ ] 明确记录：如果用户只 deny `Bash`，embedded search 关闭后 direct fallback 是否会让 `Glob/Grep` 出现，必须由测试固定当前产品语义。

**推荐产品语义**

第一版建议语义如下：

- `--disallowedTools Bash` 表示 Bash 不可用。
- 因为 embedded search 依赖 Bash，不再启用 embedded search。
- 如果 direct fallback 分支会注册 `Glob/Grep`，它们仍可用，除非用户同时传 `--disallowedTools Glob,Grep`。
- 如果产品期望“deny Bash 也要禁止所有搜索 fallback”，需要把 `Glob/Grep` 也作为派生 deny 写入 spec，再实现。

**测试 Checklist**

- [ ] 覆盖 `toolDisallowlist: ["Bash"]` 时 `resolveRuntimeEmbeddedSearchEnabled` 为 false。
- [ ] 覆盖 `toolAllowlist: ["Bash"]` 且 `toolDisallowlist: ["Bash"]` 时 deny wins。
- [ ] 覆盖 direct fallback 下 `Glob/Grep` 的 provider-visible 结果，按本文推荐语义固定测试。

**建议测试命令**

```bash
pnpm --filter @zcode/core exec vitest run tests/main-tool-pool.test.ts
```

**验收**

- [ ] `Bash` 被 deny 时，runtime 不会认为 Bash-backed embedded search 可用。
- [ ] search branch 行为有测试固定，不依赖人工猜测。

---

## Phase 4: subagent 继承 parent denylist

**目标:** parent CLI denylist 对 subagent child runtime 仍然生效，避免 profile 显式 tools 绕过。

**Files**

- Modify: `apps/zcode-cli/packages/core/src/runtime/methods/subagent.ts`
- Modify: `apps/zcode-cli/packages/core/tests/subagent-explore.test.ts`

**Interfaces**

- Consumes:
  - `this.config.toolDisallowlist`
  - `request.allowedTools`
  - `request.disallowedTools`
  - subagent profile `disallowedTools`
- Produces:
  - child runtime config 中的 `toolDisallowlist`
  - child runtime `toolAllowlist` 已经减去 parent denylist 与 profile/request denylist

**Checklist**

- [ ] 创建 child runtime config 时传入 `toolDisallowlist: this.config.toolDisallowlist`。
- [ ] `resolveSubagentToolAllowlist` 合并 deny 来源：
  - [ ] parent `this.config.toolDisallowlist`
  - [ ] request/profile 层的 `disallowedTools`
- [ ] `allowedTools: ["*"]` 展开时，从 `this.getTools()` 得到的 parent-visible tools 再扣掉合并 denylist。
- [ ] 显式 `allowedTools: ["Bash"]` 时，如果 parent denylist 包含 `Bash`，结果不能包含 `Bash`。
- [ ] 保持已有 subagent dispatch tool 自过滤逻辑，例如不把 Task/Agent 调度工具错误暴露给 child。
- [ ] 保持 Skill 特例：只有 skills 存在且 `Skill` 没有被任一 denylist 命中时才加入。
- [ ] subagent MCP required-server 检查使用已经扣掉 parent/profile denylist 的 effective allowed tools，避免被 parent deny 的 MCP tool 仍触发缺失 server 报错。

**测试 Checklist**

- [ ] 覆盖 parent `toolDisallowlist: ["Bash"]`，subagent `allowedTools: ["*"]` 时 child 不包含 `Bash`。
- [ ] 覆盖 parent `toolDisallowlist: ["Bash"]`，subagent 显式 `allowedTools: ["Bash", "Read"]` 时 child 只包含 `Read`。
- [ ] 覆盖 profile/request `disallowedTools` 与 parent denylist 合并生效。
- [ ] 覆盖 `Skill` 被 parent deny 时不会因 skills 存在被自动加回。
- [ ] 覆盖 parent deny 掉 profile 里的 MCP tool 时，不再要求该 MCP server 已连接。

**建议测试命令**

```bash
pnpm --filter @zcode/core exec vitest run tests/subagent-explore.test.ts
```

**验收**

- [ ] top-level `--disallowedTools Bash` 对主 agent 和 child agent 都生效。
- [ ] 子 agent profile 无法把 parent 已 deny 的工具重新加回来。

---

## Phase 5: CLI help、文档和用户说明

**目标:** 用户能从 help 和文档理解该 flag 的精确语义，避免和 permission denylist 混淆。

**Files**

- Modify: `apps/zcode-cli/packages/i18n/src/locales/en-US.ts`
- Modify: `apps/zcode-cli/packages/i18n/src/locales/zh-CN.ts`
- Modify: `apps/zcode-cli/docs/design/v2/tool/18-cli-tool-visibility-denylist.md`
- Optional Modify: `apps/zcode-cli/docs/design/v2/tool/README.md`

**Checklist**

- [ ] 中英文 help 各用一个条目列出 `--disallowed-tools, --disallowedTools <tools...>`。
- [ ] 中英文 help 使用 `"Bash Edit"` 等工具名示例，说明支持逗号或空格分隔。
- [ ] 中英文 help/spec 明确这是从本次 prompt/TUI 可用工具集中移除整个工具，不是按命令内容匹配的权限规则。
- [ ] 文档示例包含 comma-separated 和 repeated flag。
- [ ] 文档明确 `Bash(...)` 规则会移除整个 `Bash` tool，不做 Bash 子命令级 provider-visible 裁剪。
- [ ] 文档明确这是 runtime scoped，不持久化。
- [ ] 如果 README 有 tool spec 索引，补充 `18-cli-tool-visibility-denylist.md` 链接。

**测试 Checklist**

- [ ] CLI help 快照或文本单测覆盖新 flag。
- [ ] 手动运行 `zcode --help`，确认中文/英文环境下文案不换行错乱。

**建议测试命令**

```bash
pnpm --filter @zcode/cli exec node --disable-warning=DEP0205 --import tsx --test tests/cli.unit.test.ts
```

**验收**

- [ ] 用户能从 help 看出该 flag 是工具可见性控制。
- [ ] 文档中没有把本功能描述成 permission 规则。

---

## Phase 6: 端到端验证与回归

**目标:** 证明最终 provider request 里不含 denied tools，并且 runtime 不可执行 denied tools。

**Checklist**

- [ ] 运行 CLI 单测。
- [ ] 运行 core tool pool 单测。
- [ ] 运行 WebSearch 单测。
- [ ] 运行 MCP 注册相关单测。
- [ ] 运行 subagent 相关单测。
- [ ] 运行 `pnpm typecheck`。
- [ ] 运行 `pnpm lint`。
- [ ] 用 debug/model-io 或测试替身确认 `--disallowedTools Bash` 后 provider request `tools[]` 不含 `Bash`。
- [ ] 用 debug/model-io 或测试替身确认 `--disallowedTools web_search` 后 provider request 不含 `WebSearch`。
- [ ] 用 subagent 测试确认 child runtime 不含 parent denied tool。

**建议验证命令**

```bash
pnpm --filter @zcode/cli exec node --disable-warning=DEP0205 --import tsx --test tests/cli.unit.test.ts
pnpm --filter @zcode/core exec vitest run tests/main-tool-pool.test.ts tests/mcp-tool-bridge.test.ts tests/subagent-explore.test.ts
pnpm typecheck
pnpm lint
```

如果 package filter 名称和当前 workspace 不匹配，先用下面命令确认：

```bash
pnpm -r list --depth -1 | rg "zcode-cli|core"
```

**验收**

- [ ] 单测全部通过。
- [ ] `pnpm typecheck` 通过。
- [ ] `pnpm lint` 通过。
- [ ] provider-visible request 里没有 denied tools。
- [ ] runtime registry 里没有 denied tools。

---

## Phase 7: 代码审查重点

**Checklist**

- [ ] 没有把 `permission.disallowedTools` 当作本功能来源。
- [ ] 没有把 `toolDisallowlist` 写入持久化 config。
- [ ] deny wins 覆盖 built-in、MCP、subagent。
- [ ] `web_search` alias 与现有 `toolAllowlist` 兼容。
- [ ] embedded search 的 Bash 可用性判断包含 denylist。
- [ ] 子 agent 显式 tools 不能绕过 parent denylist。
- [ ] provider adapter 没有承担主过滤职责。
- [ ] CLI strict parser 仍然拒绝未知参数。
- [ ] 文档/help 没有承诺 wildcard 或 permission matcher。
- [ ] 没有引入 desktop/app-server/mobile remote 协议变更。

---

## 分阶段提交建议

如果实现时需要拆 commit，建议按以下顺序：

```bash
git commit -m "docs: specify cli tool visibility denylist"
git commit -m "feat(cli): parse disallowed tools flag"
git commit -m "feat(runtime): filter disallowed tools from registries"
git commit -m "feat(runtime): inherit tool denylist in subagents"
git commit -m "test(cli): cover disallowed tools flag"
```

实际提交前以最终 diff 为准；不要为了匹配上面的拆分而制造无意义 commit。

## Rollback Plan

- 如果 CLI parser 出现兼容问题，先回滚 Phase 1 的 flag 暴露，保留文档中的 pending 状态。
- 如果 registry 过滤导致 embedded search 或 MCP 回归，优先回滚 Phase 2/3 的 runtime 使用点，保留 helper 和测试失败样例用于继续定位。
- 如果 subagent 继承导致已有 profile 行为争议，保留 parent registry deny，不允许主 agent 暴露 denied tool；subagent 继承语义回到本文重新评审后再落。

## Open Questions

- 是否需要支持 wildcard，例如 `mcp__github__*`？当前只定义了 `Bash(git *)` 这类规则字符串；如果要把 wildcard 扩展到 tool name 本身，需要定义 matcher 优先级、转义规则和 permission matcher 差异。
- `--disallowedTools Bash` 是否应该连带禁用 `Glob/Grep` direct search fallback？本文默认不连带，用户可显式 deny `Glob,Grep`。
- 是否需要为 desktop/app-server/mobile remote 暴露同名配置？本文第一版不做。

## Done Definition

- [ ] `zcode --disallowedTools Bash,Edit -p "..."` 可运行。
- [ ] `zcode -p "..." --disallowedTools Bash` 可运行。
- [ ] `zcode --disallowed-tools Bash,Edit -p "..."` 可运行。
- [ ] denied built-in tool 不在 registry。
- [ ] denied MCP tool 不在 registry。
- [ ] denied tool 不在 provider-visible `tools[]`。
- [ ] subagent child runtime 不能重新获得 parent denied tool。
- [ ] `permission.disallowedTools` 语义未被改变。
- [ ] 中文/英文 help 已更新。
- [ ] 本文已按最终语义更新。
- [ ] 目标单测、`pnpm typecheck`、`pnpm lint` 均通过。
