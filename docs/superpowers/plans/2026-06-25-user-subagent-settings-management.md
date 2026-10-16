# User Subagent Settings Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Settings 面板新增用户级 subagent 管理界面，支持全局 user agents 的查看、创建、编辑、删除、启用和禁用，并保证 GUI 写出的 Markdown 被当前 zcode-cli runtime 真实加载和消费。

**Architecture:** 先把 subagent 的用户级文件路径、profile 字段、启用状态从 UI/service 的临时实现收敛到 runtime 实际消费的边界，再接入 Settings UI。P0 只管理 global/user agents；workspace/project agents、plugin agents、structured MCP object editor 和 provider-visible agent 列表载体调整都不进入本计划。

**Tech Stack:** TypeScript、React、Zustand、@zcode/services、@zcode/shared、zcode-cli bootstrap/core、Vitest、Tailwind semantic tokens、现有 Settings 页面组件。

## Global Constraints

- P0 只支持用户级/global subagent 管理；不支持工作区级创建/编辑。
- 用户级 agent Markdown 的默认运行时根目录是 `~/.zcode/agents`，不是 `~/.zcode/cli/agents`。
- GUI 的 enabled/disabled 状态必须被 zcode-cli runtime 启动时消费；不能只影响 Settings 列表或 mention 面板。
- built-in agents `general-purpose` 和 `Explore` 在 P0 只读展示，不支持编辑/删除。
- workspace/project agents 如果需要继续供 mention 使用，必须从 runtime 实际路径 `<workspace>/.zcode/agents` 读取；Settings P0 不提供编辑入口。
- 不让 `packages/services` 直接依赖 `@zcode/core` 或 runtime 具体实现。
- 涉及 `packages/ui` 必须遵守根目录 `DESIGN.md`：使用 semantic color tokens、现有 Button/Input/Switch/Select/Dialog primitives、紧凑 settings 布局、支持 Zai Light/Dark 和响应式。
- UI 文案必须走 i18n：`packages/ui/src/i18n/locales/zh-CN.ts` 与 `packages/ui/src/i18n/locales/en-US.ts` 同步补齐。
- 不自动提交；执行本计划时只有用户明确允许后才提交 commit。

---

## 当前事实基线

- CLI runtime 加载 profile 的入口是 `apps/zcode-cli/packages/bootstrap/src/subagents.ts`。
- CLI runtime 当前读取：
  - user root: `join(storageRoot, "agents")`
  - project root: `join(workingDirectory, ".zcode", "agents")`
- `storageRoot` 默认来自 `DefaultRuntimeConfig.storage.dir = "~/.zcode"`。
- App service 当前 `packages/services/src/subagents/subagentsService.ts` 仍用 `ZCODE_AGENT_RUNTIME.nativeConfigDir` 推导 `~/.zcode/cli/agents` 和 `<workspace>/.zcode/cli/agents`，这和 runtime loader 不一致。
- App service 当前只解析/写回 `name`、`description`、`color`、`model`、`tools`、body；runtime profile 还支持 `disallowedTools`、`skills`、`permissionMode`、`maxTurns`、`background`、`mcpServers`。
- `agents-state.json` 当前只被 service 读写，runtime 不消费。

## File Structure

### Data and service boundary

- Modify: `packages/shared/src/subagents-types.ts`
  - 扩展 Settings P0 需要的 `AgentSummary` / `SubAgentConfig` 字段。
  - 保留旧字段兼容，但把 `tools` 等字段转为 string array 语义。
- Create: `packages/services/src/subagents/subagentMarkdown.ts`
  - Service 侧 Markdown parse/serialize helper。
  - 不依赖 `@zcode/core`。
- Create: `packages/services/src/subagents/subagentStorage.ts`
  - 统一解析 user/global agent root、project agent root、state file path。
  - 读取 `~/.zcode/cli/config.json` 中的 `storage.dir`，fallback 到 `~/.zcode`。
- Modify: `packages/services/src/subagents/subagents.ts`
  - 扩展 service interface，支持 settings user-only list、create/update/delete 的 user scope。
- Modify: `packages/services/src/subagents/subagentsService.ts`
  - 使用新 storage helper，读取 runtime-aligned roots。
  - 列表支持 built-in readonly + user editable + optional workspace readonly。
  - create/update/delete 只写 user/global root。
  - enabled state 写入 runtime 会读取的 state file。

### Runtime consumption

- Modify: `apps/zcode-cli/packages/bootstrap/src/subagents.ts`
  - 读取同一份 disabled state。
  - 加载 user/project Markdown 后过滤 disabled user profiles。
  - 保持 project profiles 继续加载，但 P0 UI 不管理它们。
- Modify: `apps/zcode-cli/packages/bootstrap/src/app/create-app.ts`
  - 如果需要，把 state file path 或 disabled set 传入 `loadZCodeAgentProfiles`。
- Modify: `apps/zcode-cli/packages/core/src/subagent/profile.ts`
  - 如需暴露 builtin summary helper，保持 core 内部，不让 service 依赖 core。

### Settings UI

- Create: `packages/ui/src/settings/SubagentsSection.tsx`
  - Settings 分区主入口，列表、搜索、刷新、打开目录、新建入口。
- Create: `packages/ui/src/settings/SubagentForm.tsx`
  - 创建/编辑 user agent 的 form view。
- Create: `packages/ui/src/settings/SubagentCard.tsx`
  - 列表 row/card：颜色点、名称、描述、model/tools/background/permission badges、enabled switch、edit/delete actions。
- Modify: `packages/ui/src/settings/settingsPageConfig.ts`
  - 加入 `subagents` sidebar section。
- Modify: `packages/ui/src/lib/settingsNavigation.ts`
  - 增加 `SettingsSectionId = "subagents"`。
- Modify: `packages/ui/src/SettingsPage.tsx`
  - 渲染 `<SubagentsSection />`。
- Modify: `packages/ui/src/store/subagentsStore.ts`
  - 若现有 store 够用则扩展；否则保持 hook-local state，避免把 form draft 放进全局 store。
- Modify: `packages/ui/src/hooks/useSubagents.ts`
  - 支持 settings 场景传入 list mode。
- Modify: `packages/ui/src/i18n/locales/zh-CN.ts`
- Modify: `packages/ui/src/i18n/locales/en-US.ts`
- Modify: `packages/shared/src/test-ids.ts`
  - 增加 Settings subagents 页面和关键交互 test id。

### Tests

- Create or modify: `packages/services/test/subagentsService.test.ts`
- Modify: `apps/zcode-cli/packages/bootstrap/tests/subagents.test.ts`
- Modify: `apps/zcode-cli/packages/core/tests/subagent-profile.test.ts`
- Create: `packages/ui/test/subagentsSettingsSection.test.tsx`
- Modify: `packages/ui/test/settingsPageConfig.test.ts`
- Modify: `packages/ui/test/settingsNavigation.test.ts`
- Modify: `packages/ui/test/subagentsMentionProvider.test.ts`

---

## Interfaces

### Shared types

```ts
export type AgentScope = "built-in" | "workspace" | "user";

export type AgentSource = "built-in" | "user" | "plugin";

export type AgentProfileModel = "inherit" | "main" | "lite";

export type AgentPermissionMode =
  | "acceptEdits"
  | "auto"
  | "bypassPermissions"
  | "default"
  | "dontAsk"
  | "plan";

export type AgentColor =
  | "red"
  | "blue"
  | "green"
  | "yellow"
  | "purple"
  | "orange"
  | "pink"
  | "cyan";

export interface AgentSummary {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  color?: AgentColor;
  model?: AgentProfileModel;
  tools?: string[];
  disallowedTools?: string[];
  skills?: string[];
  permissionMode?: AgentPermissionMode;
  maxTurns?: number;
  background?: boolean;
  mcpServers?: unknown[];
  path: string;
  scope: AgentScope;
  source: AgentSource;
  enabled: boolean;
  readOnly: boolean;
  projectPath?: string;
}

export interface SubAgentConfig {
  name: string;
  description: string;
  systemPrompt: string;
  color?: AgentColor;
  model?: AgentProfileModel;
  tools?: string[];
  disallowedTools?: string[];
  skills?: string[];
  permissionMode?: AgentPermissionMode;
  maxTurns?: number;
  background?: boolean;
  mcpServers?: unknown[];
}

export type SubagentsListMode = "allRuntimeScopes" | "settingsUserOnly";
```

### Service list params

```ts
interface SubagentsListParams {
  workspacePath: string;
  workspaceIdentity?: string;
  provider?: ZCodeProvider;
  mode?: SubagentsListMode;
}
```

Semantics:

- `allRuntimeScopes`: mention provider and future runtime-aware surfaces use this. Includes built-in, user, and workspace readonly profiles.
- `settingsUserOnly`: Settings P0 uses this. Includes built-in readonly and user editable profiles only. Workspace profiles are intentionally hidden.

### Stable state id

```ts
function createAgentStateId(input: {
  source: AgentSource;
  scope: AgentScope;
  name: string;
}): string {
  return `${input.source}:${input.scope}:${input.name.trim().toLowerCase()}`;
}
```

P0 runtime consumes disabled user state ids. Built-in ids are stable for future use but not toggled in P0 UI.

---

### Task 1: 扩展 shared subagent 类型

**Files:**

- Modify: `packages/shared/src/subagents-types.ts`

**Interfaces:**

- Produces: `AgentProfileModel`、`AgentPermissionMode`、`AgentColor`、`SubagentsListMode`、扩展后的 `AgentSummary` 和 `SubAgentConfig`。
- Consumes: 现有 service/store/hook 的 `AgentSummary`、`SubAgentConfig`。

- [ ] **Step 1: 修改 shared 类型**

将 `packages/shared/src/subagents-types.ts` 调整为支持完整 P0 profile 字段。保留 `AgentScope` 中的 `workspace`，因为 mention provider 仍可能需要展示 runtime project profiles；Settings P0 只传 `settingsUserOnly`。

核心形状：

```ts
export type AgentScope = "built-in" | "workspace" | "user";
export type AgentSource = "built-in" | "user" | "plugin";
export type AgentProfileModel = "inherit" | "main" | "lite";
export type AgentPermissionMode =
  | "acceptEdits"
  | "auto"
  | "bypassPermissions"
  | "default"
  | "dontAsk"
  | "plan";
export type AgentColor =
  | "red"
  | "blue"
  | "green"
  | "yellow"
  | "purple"
  | "orange"
  | "pink"
  | "cyan";
export type SubagentsListMode = "allRuntimeScopes" | "settingsUserOnly";
```

- [ ] **Step 2: 修复 TypeScript 调用点**

更新编译错误最小集合：

- `packages/ui/src/mentions/providers/subagentsMentionProvider.ts`
- `packages/ui/src/store/subagentsStore.ts`
- `packages/services/src/subagents/subagentsService.ts`

对于旧的 `tools?: string` 读取，改成：

```ts
const toolSummary = agent.tools?.length ? agent.tools.join(", ") : "";
```

- [ ] **Step 3: 运行类型检查**

Run:

```bash
pnpm --filter @zcode/shared lint
pnpm --filter @zcode/ui test -- --run test/subagentsMentionProvider.test.ts
```

Expected:

- `@zcode/shared lint` PASS。
- mention provider test 如有 fixture 编译错误，更新 fixture 字段后 PASS。

---

### Task 2: 新增 service 侧 Markdown profile helper

**Files:**

- Create: `packages/services/src/subagents/subagentMarkdown.ts`
- Test: `packages/services/test/subagentsService.test.ts`

**Interfaces:**

- Consumes: `SubAgentConfig` from `@zcode/shared`。
- Produces:
  - `parseSubagentMarkdown(content: string, path: string, scope: AgentScope): AgentSummary | SubagentMarkdownDiagnostic`
  - `serializeSubagentMarkdown(config: SubAgentConfig): string`

- [ ] **Step 1: 写 failing parser/serializer test**

在 `packages/services/test/subagentsService.test.ts` 增加 helper-level tests，覆盖数组字段和 body 保真：

```ts
it("serializes user subagent markdown with runtime profile fields", () => {
  const markdown = serializeSubagentMarkdown({
    name: "code-reviewer",
    description: "提交前审查代码",
    systemPrompt: "你是严格的代码审查员。",
    color: "cyan",
    model: "lite",
    tools: ["Read", "Grep", "Bash(git diff *)"],
    disallowedTools: ["Write"],
    skills: ["code-review"],
    permissionMode: "acceptEdits",
    maxTurns: 7,
    background: true,
  });

  expect(markdown).toContain('name: "code-reviewer"');
  expect(markdown).toContain("tools:");
  expect(markdown).toContain("- Read");
  expect(markdown).toContain("- Bash(git diff *)");
  expect(markdown).toContain("permissionMode: acceptEdits");
  expect(markdown).toContain("maxTurns: 7");
  expect(markdown).toContain("background: true");
  expect(markdown).toContain("你是严格的代码审查员。");
});
```

- [ ] **Step 2: 实现 serializer**

`serializeSubagentMarkdown` 使用 YAML frontmatter 风格，但不引入 service->core 依赖。推荐复用 `yaml` package，避免手写转义遗漏。

```ts
import YAML from "yaml";
import type { SubAgentConfig } from "@zcode/shared";

export function serializeSubagentMarkdown(config: SubAgentConfig): string {
  const frontmatter: Record<string, unknown> = {
    name: config.name.trim(),
    description: config.description.trim(),
  };
  if (config.color) frontmatter.color = config.color;
  if (config.model && config.model !== "inherit") frontmatter.model = config.model;
  if (config.tools?.length) frontmatter.tools = config.tools;
  if (config.disallowedTools?.length) frontmatter.disallowedTools = config.disallowedTools;
  if (config.skills?.length) frontmatter.skills = config.skills;
  if (config.permissionMode) frontmatter.permissionMode = config.permissionMode;
  if (config.maxTurns !== undefined) frontmatter.maxTurns = config.maxTurns;
  if (config.background !== undefined) frontmatter.background = config.background;
  if (config.mcpServers?.length) frontmatter.mcpServers = config.mcpServers;

  return `---\n${YAML.stringify(frontmatter).trimEnd()}\n---\n\n${config.systemPrompt.trim()}\n`;
}
```

- [ ] **Step 3: 实现 parser**

Parser 要接受 runtime 当前 loose parser 能接受的格式。P0 不支持嵌套 MCP object editor，但 parser 可以把 `mcpServers` array 保留下来。

```ts
export interface SubagentMarkdownDiagnostic {
  code: "agent_missing_frontmatter" | "agent_missing_required_frontmatter" | "agent_invalid_frontmatter";
  message: string;
  path: string;
}
```

解析失败时不要 throw；返回 diagnostic，让 Settings 页能展示诊断。

- [ ] **Step 4: 运行 service 测试**

Run:

```bash
pnpm --filter @zcode/services test -- --run test/subagentsService.test.ts
```

Expected:

- 新增 parser/serializer tests PASS。
- 如果 `@zcode/services` 当前没有 test script，用根命令运行：

```bash
pnpm test -- --run packages/services/test/subagentsService.test.ts
```

---

### Task 3: 统一 service 的 user root 与 runtime root

**Files:**

- Create: `packages/services/src/subagents/subagentStorage.ts`
- Modify: `packages/services/src/subagents/subagentsService.ts`
- Test: `packages/services/test/subagentsService.test.ts`

**Interfaces:**

- Produces:
  - `resolveUserSubagentRoot(): Promise<string>`
  - `resolveWorkspaceSubagentRoot(workspacePath: string): string`
  - `resolveSubagentStateFile(): Promise<string>`
- Consumes: `~/.zcode/cli/config.json` 的 `storage.dir`，fallback `~/.zcode`。

- [ ] **Step 1: 写 failing root resolution test**

使用临时 HOME，创建 `~/.zcode/cli/config.json`：

```ts
it("uses runtime storage.dir agents root for user subagents", async () => {
  const home = await mkdtemp(join(tmpdir(), "zcode-subagents-home-"));
  const storageRoot = join(home, "custom-storage");
  await mkdir(join(home, ".zcode", "cli"), { recursive: true });
  await writeFile(
    join(home, ".zcode", "cli", "config.json"),
    JSON.stringify({ storage: { dir: storageRoot } }),
    "utf8",
  );

  const root = await resolveUserSubagentRoot({ homeDir: home });

  expect(root).toBe(join(storageRoot, "agents"));
});
```

- [ ] **Step 2: 实现 storage helper**

`subagentStorage.ts` 不直接使用 `ZCODE_AGENT_RUNTIME.nativeConfigDir` 推导 agent root。它只用 native config path 读取 config 文件：

```ts
const DEFAULT_STORAGE_DIR = "~/.zcode";
const ZCODE_CONFIG_PATH = join(resolveUserHomeDir(), ".zcode", "cli", "config.json");

export async function resolveUserSubagentRoot(): Promise<string> {
  const storageDir = await readStorageDirFromCliConfig();
  return join(resolveConfigPath(storageDir), "agents");
}

export function resolveWorkspaceSubagentRoot(workspacePath: string): string {
  return join(workspacePath, ".zcode", "agents");
}

export async function resolveSubagentStateFile(): Promise<string> {
  const storageDir = await readStorageDirFromCliConfig();
  return join(resolveConfigPath(storageDir), "v2", "agents-state.json");
}
```

- [ ] **Step 3: 更新 service list/create/update/delete 使用新 root**

`createAgent` / `updateAgent` 只写 `resolveUserSubagentRoot()`。`list` 默认可以读 workspace root，但 Settings P0 通过 `mode: "settingsUserOnly"` 隐藏 workspace。

- [ ] **Step 4: 保留兼容迁移读取**

为了不让已有 `~/.zcode/cli/agents` 用户立刻消失，P0 可以只读 legacy root 但不再写 legacy root。实现为：

```ts
const roots = [
  { scope: "user" as const, rootPath: await resolveUserSubagentRoot(), writable: true },
  { scope: "user" as const, rootPath: resolveLegacyUserSubagentRoot(), writable: false },
];
```

同名时 runtime root 优先，legacy root 被 shadow，不可编辑。若产品决定不迁移旧路径，可以删掉这一步；但要在最终说明中明确。

- [ ] **Step 5: 运行 service 测试**

Run:

```bash
pnpm test -- --run packages/services/test/subagentsService.test.ts
```

Expected:

- root resolution test PASS。
- create/update/delete 写入 `${storage.dir}/agents/<name>.md`。

---

### Task 4: Runtime 消费 disabled user agents

**Files:**

- Modify: `apps/zcode-cli/packages/bootstrap/src/subagents.ts`
- Modify: `apps/zcode-cli/packages/bootstrap/src/app/create-app.ts`
- Test: `apps/zcode-cli/packages/bootstrap/tests/subagents.test.ts`

**Interfaces:**

- Consumes: `${storageRoot}/v2/agents-state.json`
- Produces: `loadZCodeAgentProfiles(...)` 返回已过滤 disabled user profiles。

- [ ] **Step 1: 写 failing runtime disabled test**

在 `apps/zcode-cli/packages/bootstrap/tests/subagents.test.ts` 增加：

```ts
it("does not load disabled user agent profiles into runtime config", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcode-subagents-disabled-"));
  const storageRoot = join(root, "home");
  const workingDirectory = join(root, "workspace");
  await mkdir(join(storageRoot, "agents"), { recursive: true });
  await mkdir(join(storageRoot, "v2"), { recursive: true });
  await writeFile(
    join(storageRoot, "agents", "reviewer.md"),
    `---
name: reviewer
description: review code
---
review prompt`,
    "utf8",
  );
  await writeFile(
    join(storageRoot, "v2", "agents-state.json"),
    JSON.stringify({ disabledAgentIds: ["user:user:reviewer"] }),
    "utf8",
  );

  const result = loadZCodeAgentProfiles({ storageRoot, workingDirectory });

  expect(result.profiles.map((profile) => profile.name)).not.toContain("reviewer");
});
```

- [ ] **Step 2: 实现 state reader**

在 bootstrap 侧新增本地 pure helper，避免依赖 app service：

```ts
function readDisabledAgentIds(storageRoot: string): Set<string> {
  const path = join(storageRoot, "v2", "agents-state.json");
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { disabledAgentIds?: unknown };
    return new Set(
      Array.isArray(parsed.disabledAgentIds)
        ? parsed.disabledAgentIds.filter((id): id is string => typeof id === "string")
        : [],
    );
  } catch {
    return new Set();
  }
}
```

- [ ] **Step 3: 过滤 user profiles**

加载 profile 后计算：

```ts
const stateId = `${result.profile.source}:${result.profile.source === "project" ? "workspace" : "user"}:${result.profile.name.trim().toLowerCase()}`;
if (result.profile.source === "user" && disabledAgentIds.has(stateId)) {
  continue;
}
```

P0 只让 user disabled 影响 runtime。Project disabled 留给 P1。

- [ ] **Step 4: 确认 provider-visible list 不包含 disabled**

在 `apps/zcode-cli/packages/core/tests/subagent-profile.test.ts` 增加或更新测试：传入 profiles 不包含 disabled user 时，`formatAgentProfilesForPrompt` 不输出该 agent。

Run:

```bash
pnpm --filter @zcode/bootstrap test -- --run tests/subagents.test.ts
pnpm --filter @zcode/core test -- --run tests/subagent-profile.test.ts
```

Expected:

- disabled user profile 不进入 runtime profiles。
- provider prompt formatter 不输出 disabled profile。

---

### Task 5: 完善 SubagentsService 行为

**Files:**

- Modify: `packages/services/src/subagents/subagents.ts`
- Modify: `packages/services/src/subagents/subagentsService.ts`
- Test: `packages/services/test/subagentsService.test.ts`

**Interfaces:**

- `list({ mode: "settingsUserOnly" })` 返回 built-in readonly + user editable。
- `list({ mode: "allRuntimeScopes" })` 返回 built-in + user + workspace readonly。
- `createAgent` / `updateAgent` / `deleteAgent` 只允许 user scope。

- [ ] **Step 1: 写 list mode tests**

```ts
it("settings user-only list hides workspace agents", async () => {
  const result = await service.list({
    workspacePath,
    provider: "glm",
    mode: "settingsUserOnly",
  });

  expect(result.agents.every((agent) => agent.scope !== "workspace")).toBe(true);
  expect(result.agents.some((agent) => agent.source === "built-in")).toBe(true);
  expect(result.agents.some((agent) => agent.scope === "user")).toBe(true);
});
```

- [ ] **Step 2: 添加 built-in readonly summaries**

Service 不能依赖 `@zcode/core`。在 service 内定义与 runtime built-ins 同名的 summary 常量：

```ts
const BUILT_IN_AGENT_SUMMARIES: AgentSummary[] = [
  {
    id: "built-in:built-in:general-purpose",
    name: "general-purpose",
    description: "General-purpose agent for researching complex questions...",
    systemPrompt: "",
    tools: ["*"],
    path: "built-in:general-purpose",
    scope: "built-in",
    source: "built-in",
    enabled: true,
    readOnly: true,
  },
  {
    id: "built-in:built-in:Explore",
    name: "Explore",
    description: "Read-only search agent for broad fan-out searches...",
    model: "lite",
    tools: ["Bash", "Glob", "Grep", "Read", "WebFetch", "WebSearch", "TodoWrite"],
    systemPrompt: "",
    path: "built-in:Explore",
    scope: "built-in",
    source: "built-in",
    enabled: true,
    readOnly: true,
  },
];
```

If duplication becomes uncomfortable later, move built-in metadata to a shared pure package. Do not make services import runtime core in this task.

- [ ] **Step 3: create/update/delete validation**

P0 validation:

```ts
const NAME_REGEX = /^[a-zA-Z0-9-]+$/;
const MIN_NAME_LENGTH = 3;
const MAX_NAME_LENGTH = 50;
```

Validate:

- name length 3..50
- letters/numbers/hyphen only
- description non-empty
- systemPrompt non-empty
- model must be `inherit/main/lite` when present
- maxTurns must be positive integer when present

- [ ] **Step 4: enabled state writes runtime-consumed ids**

`setEnabled({ agentId, enabled })` should store ids like `user:user:code-reviewer`. For backwards compatibility, when reading old `user:code-reviewer`, normalize it to new id once on write.

- [ ] **Step 5: Run tests**

Run:

```bash
pnpm test -- --run packages/services/test/subagentsService.test.ts
pnpm --filter @zcode/ui test -- --run test/subagentsMentionProvider.test.ts
```

Expected:

- Settings list hides workspace agents.
- Mention provider can still receive workspace agents when service called with default/all mode.
- enabled state ids match runtime test from Task 4.

---

### Task 6: 更新 subagents hook/store 支持 Settings mode

**Files:**

- Modify: `packages/ui/src/hooks/useSubagents.ts`
- Modify: `packages/ui/src/store/subagentsStore.ts`
- Test: `packages/ui/test/subagentsMentionProvider.test.ts`

**Interfaces:**

- Produces: `useSubagents(workspacePath, provider, { mode })`
- Consumes: `ISubagentsService.list({ mode })`

- [ ] **Step 1: 扩展 hook signature**

```ts
export function useSubagents(
  workspacePath: string | null,
  provider: ZCodeProvider,
  options: { mode?: SubagentsListMode } = {},
) {
  // existing logic
}
```

- [ ] **Step 2: store cache key 加 mode**

Current key is workspace + provider。改为：

```ts
function getAgentLoadKey(
  workspacePath: string,
  provider: ZCodeProvider,
  mode: SubagentsListMode,
  workspaceIdentity?: string,
): string {
  return `${workspaceIdentity?.trim() || workspacePath}::${provider}::${mode}`;
}
```

- [ ] **Step 3: mention provider 保持 allRuntimeScopes**

`useSubagentsMentionProvider` 不传 mode 或显式传 `allRuntimeScopes`，确保 workspace readonly profiles 不被 Settings P0 隐藏逻辑影响。

- [ ] **Step 4: run tests**

Run:

```bash
pnpm --filter @zcode/ui test -- --run test/subagentsMentionProvider.test.ts
```

Expected:

- Existing mention tests PASS。
- 新增一个 test 确认 disabled agents 仍不进入 mention items。

---

### Task 7: 新增 Settings sidebar section

**Files:**

- Modify: `packages/ui/src/settings/settingsPageConfig.ts`
- Modify: `packages/ui/src/lib/settingsNavigation.ts`
- Modify: `packages/ui/src/SettingsPage.tsx`
- Modify: `packages/ui/src/i18n/locales/zh-CN.ts`
- Modify: `packages/ui/src/i18n/locales/en-US.ts`
- Modify: `packages/shared/src/test-ids.ts`
- Test: `packages/ui/test/settingsPageConfig.test.ts`
- Test: `packages/ui/test/settingsNavigation.test.ts`

**Interfaces:**

- Produces: settings section id `"subagents"`。
- Consumes: existing Settings section rendering branch。

- [ ] **Step 1: 写 failing config tests**

Update `settingsPageConfig.test.ts`:

```ts
expect(SETTINGS_SECTIONS.map((section) => section.id)).toContain("subagents");
```

Update `settingsNavigation.test.ts`:

```ts
expect(navigation.resolveSettingsSection("subagents", "general")).toBe("subagents");
```

- [ ] **Step 2: 更新 SettingsSectionId**

`packages/ui/src/lib/settingsNavigation.ts`:

```ts
export type SettingsSectionId =
  | "general"
  | "codePreview"
  | "migration"
  | "indexing"
  | "modelProvider"
  | "mcp"
  | "plugins"
  | "usage"
  | "skills"
  | "commands"
  | "subagents"
  | "hooks";
```

同步更新 `isSettingsSectionId`。

- [ ] **Step 3: 增加 sidebar config**

`packages/ui/src/settings/settingsPageConfig.ts` 引入 lucide icon，推荐 `Bot` 或 `UsersRound`：

```ts
{
  id: "subagents",
  icon: Bot,
  titleId: "settings.subagents.title",
}
```

位置建议放在 `skills` 之后、`mcp` 之前。

- [ ] **Step 4: SettingsPage 渲染占位 section**

先接入 `<SubagentsSection />`，Task 8 实现组件。

```tsx
) : activeSection === "subagents" ? (
  <SubagentsSection workspacePath={activeWorkspacePath} workspaceIdentity={activeWorkspaceIdentity} />
) : activeSection === "skills" ? (
```

- [ ] **Step 5: i18n**

`zh-CN.ts`:

```ts
"settings.subagents.title": "子代理",
"settings.subagents.description": "管理全局用户子代理。子代理由 Markdown 文件定义，运行时会在 Agent 工具中使用这些定义。",
```

`en-US.ts`:

```ts
"settings.subagents.title": "Subagents",
"settings.subagents.description": "Manage global user subagents. Subagents are defined by Markdown files and are consumed by the Agent tool at runtime.",
```

- [ ] **Step 6: run tests**

Run:

```bash
pnpm --filter @zcode/ui test -- --run test/settingsPageConfig.test.ts test/settingsNavigation.test.ts
```

Expected: PASS。

---

### Task 8: 实现 SubagentsSection 列表页

**Files:**

- Create: `packages/ui/src/settings/SubagentsSection.tsx`
- Create: `packages/ui/src/settings/SubagentCard.tsx`
- Modify: `packages/ui/src/i18n/locales/zh-CN.ts`
- Modify: `packages/ui/src/i18n/locales/en-US.ts`
- Test: `packages/ui/test/subagentsSettingsSection.test.tsx`

**Interfaces:**

- Consumes: `useSubagents(activeWorkspacePath, ZCODE_AGENT_PROVIDER, { mode: "settingsUserOnly" })`
- Produces: search/filter/list/toggle/edit/delete entry points。

- [ ] **Step 1: 写 failing render test**

Use existing UI test pattern. Mock `useServices().subagentsService.list` to return built-in + user:

```tsx
it("renders built-in and user subagents in settings user-only mode", async () => {
  render(<SubagentsSection workspacePath="/repo" />);

  expect(await screen.findByText("general-purpose")).toBeInTheDocument();
  expect(await screen.findByText("code-reviewer")).toBeInTheDocument();
  expect(screen.queryByText("workspace-reviewer")).not.toBeInTheDocument();
});
```

- [ ] **Step 2: 实现 section header**

UI shape:

- description text left
- icon buttons right: new, open folder, refresh
- compact search input below

Use:

- `Button` variant `ghost` size `icon-sm`
- `Input` size `lg`
- `ControlHintTooltip`
- `Plus`, `FolderOpen`, `RefreshCw`

- [ ] **Step 3: 实现 grouped list**

Group order:

1. Built-in
2. User agents

`SubagentCard` props:

```ts
interface SubagentCardProps {
  agent: AgentSummary;
  operating: boolean;
  onToggle: (agent: AgentSummary, enabled: boolean) => void;
  onEdit: (agent: AgentSummary) => void;
  onDelete: (agent: AgentSummary) => void;
}
```

Rules:

- `agent.readOnly === true`: hide edit/delete, disable switch or hide switch for built-ins.
- User agent: show switch, edit icon, delete icon.
- Display badges for model/tools/background/permissionMode if present.
- Use color swatch only from runtime enum; fallback to neutral dot.

- [ ] **Step 4: open user folder**

Use existing `subagentsService.getPrimaryUserAgentsDirectory({ provider: ZCODE_AGENT_PROVIDER })` then `platform.openInFileManager(path)`。Failure toast uses existing `appHeader.openInFileManagerFailed`。

- [ ] **Step 5: toggle enabled**

Call store/hook `setEnabled(agent.id, enabled)`。On failure show toast and keep list refreshed from service.

- [ ] **Step 6: run UI tests**

Run:

```bash
pnpm --filter @zcode/ui test -- --run test/subagentsSettingsSection.test.tsx
```

Expected:

- Built-ins render readonly.
- User agent renders editable actions.
- Workspace fixture is hidden in settings mode.
- Toggle calls `subagentsService.setEnabled` with expected id.

---

### Task 9: 实现 SubagentForm 创建/编辑页

**Files:**

- Create: `packages/ui/src/settings/SubagentForm.tsx`
- Modify: `packages/ui/src/settings/SubagentsSection.tsx`
- Modify: `packages/ui/src/i18n/locales/zh-CN.ts`
- Modify: `packages/ui/src/i18n/locales/en-US.ts`
- Test: `packages/ui/test/subagentsSettingsSection.test.tsx`

**Interfaces:**

- Consumes: `SubAgentConfig`
- Produces: validated `SubAgentConfig` for `createAgent` / `updateAgent`

- [ ] **Step 1: 写 failing create form test**

```tsx
it("creates a user subagent from the settings form", async () => {
  render(<SubagentsSection workspacePath="/repo" />);

  await user.click(screen.getByLabelText("新建子代理"));
  await user.type(screen.getByLabelText("名称"), "code-reviewer");
  await user.type(screen.getByLabelText("描述"), "提交前审查代码");
  await user.type(screen.getByLabelText("系统提示词"), "你是严格的代码审查员。");
  await user.click(screen.getByRole("button", { name: "保存" }));

  expect(subagentsService.createAgent).toHaveBeenCalledWith(
    expect.objectContaining({
      config: expect.objectContaining({
        name: "code-reviewer",
        description: "提交前审查代码",
        systemPrompt: "你是严格的代码审查员。",
      }),
    }),
  );
});
```

- [ ] **Step 2: 表单字段**

P0 fields:

- name
- description
- model select: inherit/main/lite
- color swatches: red/blue/green/yellow/purple/orange/pink/cyan
- tools editor:
  - quick toggles for common tools: Read, Grep, Glob, Bash, Edit, Write, WebFetch, WebSearch, TodoWrite
  - advanced comma/newline text field preserving custom patterns like `Bash(git diff *)`
- background switch
- permissionMode select
- maxTurns number input
- systemPrompt textarea

P0 advanced collapsed fields:

- disallowedTools text field
- skills text field
- mcpServers text field as comma/newline string only

- [ ] **Step 3: validation**

Validation:

```ts
const NAME_REGEX = /^[a-zA-Z0-9-]+$/;
const MIN_NAME_LENGTH = 3;
const MAX_NAME_LENGTH = 50;
```

Errors:

- name required and length 3..50
- name only letters/numbers/hyphen
- description required
- systemPrompt required
- maxTurns positive integer if set

- [ ] **Step 4: save behavior**

Create:

```ts
await createAgent(config, ZCODE_AGENT_PROVIDER, subagentsService);
```

Edit:

```ts
await updateAgent(agent.id, config, agent.path, ZCODE_AGENT_PROVIDER, subagentsService);
```

After success:

- close form view
- refresh list
- toast saved

- [ ] **Step 5: responsive layout**

Follow `DESIGN.md`:

- Form container: `rounded-xl border border-border bg-card p-4`
- Use `text-sm`
- `grid gap-3 md:grid-cols-2` for top fields
- `Textarea` min height for prompt, no raw color values
- No nested cards

- [ ] **Step 6: run tests**

Run:

```bash
pnpm --filter @zcode/ui test -- --run test/subagentsSettingsSection.test.tsx
```

Expected:

- Create form calls service with normalized arrays.
- Edit form pre-populates fields.
- Validation errors are localized.

---

### Task 10: 删除和错误态

**Files:**

- Modify: `packages/ui/src/settings/SubagentsSection.tsx`
- Modify: `packages/ui/src/settings/SubagentCard.tsx`
- Modify: `packages/ui/src/i18n/locales/zh-CN.ts`
- Modify: `packages/ui/src/i18n/locales/en-US.ts`
- Test: `packages/ui/test/subagentsSettingsSection.test.tsx`

**Interfaces:**

- Consumes: existing `useConfirmDialog` pattern from `CommandsSection`。
- Produces: delete confirm flow and diagnostics/error display。

- [ ] **Step 1: 写 delete confirmation test**

```tsx
it("confirms before deleting a user subagent", async () => {
  render(<SubagentsSection workspacePath="/repo" />);

  await user.click(await screen.findByLabelText("删除子代理"));
  await user.click(screen.getByRole("button", { name: "删除" }));

  expect(subagentsService.deleteAgent).toHaveBeenCalledWith(
    expect.objectContaining({
      agentId: "user:user:code-reviewer",
      filePath: expect.stringContaining("code-reviewer.md"),
    }),
  );
});
```

- [ ] **Step 2: implement confirmation**

Use:

```ts
const confirmed = await confirmDialog({
  title: intl.formatMessage({ id: "settings.subagents.delete.title" }),
  description: intl.formatMessage(
    { id: "settings.subagents.delete.description" },
    { name: agent.name },
  ),
  confirmLabel: intl.formatMessage({ id: "common.delete" }),
});
```

- [ ] **Step 3: diagnostics display**

If service returns diagnostics for invalid Markdown, show collapsible warning block near top:

- count summary
- code label
- path in mono

Do not block valid agents from rendering.

- [ ] **Step 4: run tests**

Run:

```bash
pnpm --filter @zcode/ui test -- --run test/subagentsSettingsSection.test.tsx
```

Expected:

- Delete needs confirmation.
- Built-in delete button not rendered.
- Diagnostics block renders without hiding valid user agents.

---

### Task 11: Provider-visible/runtime regression coverage

**Files:**

- Modify: `apps/zcode-cli/packages/bootstrap/tests/subagents.test.ts`
- Modify: `apps/zcode-cli/packages/core/tests/subagent-profile.test.ts`
- Optional Modify: 历史差异审计文档（已删除）

**Interfaces:**

- Consumes: service-written markdown shape from Task 2.
- Produces: confidence that GUI-created profiles are runtime-loadable and disabled profiles are provider-invisible.

- [ ] **Step 1: Add GUI markdown compatibility test in bootstrap**

Use a Markdown fixture generated by service serializer format:

```ts
await writeFile(
  join(storageRoot, "agents", "code-reviewer.md"),
  `---
name: code-reviewer
description: 提交前审查代码
model: lite
tools:
  - Read
  - Grep
  - Bash(git diff *)
disallowedTools:
  - Write
skills:
  - code-review
permissionMode: acceptEdits
maxTurns: 7
background: true
color: cyan
---
你是严格的代码审查员。`,
  "utf8",
);
```

Expect:

```ts
expect(result.profiles[0]).toMatchObject({
  name: "code-reviewer",
  model: "lite",
  tools: ["Read", "Grep", "Bash"],
  disallowedTools: ["Write"],
  skills: ["code-review"],
  permissionMode: "acceptEdits",
  maxTurns: 7,
  background: true,
  color: "cyan",
});
```

- [ ] **Step 2: Add provider-visible list test**

`formatAgentProfilesForPrompt` with loaded profiles should include enabled user agent and omit disabled one.

- [ ] **Step 3: Optional docs update**

If implementation changes current diff facts, update 历史差异审计文档（已删除）:

- Service/UI now writes runtime-aligned user root.
- GUI P0 intentionally excludes workspace editing.
- enabled state now affects runtime profile load.

- [ ] **Step 4: run tests**

Run:

```bash
pnpm --filter @zcode/bootstrap test -- --run tests/subagents.test.ts
pnpm --filter @zcode/core test -- --run tests/subagent-profile.test.ts
```

Expected: PASS。

---

### Task 12: Full validation

**Files:**

- No new files unless prior tasks require snapshots.

**Interfaces:**

- Consumes: all prior tasks.
- Produces: final verification evidence.

- [ ] **Step 1: Targeted tests**

Run:

```bash
pnpm --filter @zcode/ui test -- --run \
  test/settingsPageConfig.test.ts \
  test/settingsNavigation.test.ts \
  test/subagentsMentionProvider.test.ts \
  test/subagentsSettingsSection.test.tsx
```

Expected: PASS。

- [ ] **Step 2: Service/runtime tests**

Run:

```bash
pnpm test -- --run packages/services/test/subagentsService.test.ts
pnpm --filter @zcode/bootstrap test -- --run tests/subagents.test.ts
pnpm --filter @zcode/core test -- --run tests/subagent-profile.test.ts
```

Expected: PASS。

- [ ] **Step 3: Repo required checks**

Run:

```bash
pnpm typecheck
pnpm lint
```

Expected: PASS。

- [ ] **Step 4: Manual smoke**

Start the app using the repo's normal dev command for this worktree. Then:

1. Open Settings.
2. Open Subagents section.
3. Create user agent `code-reviewer`.
4. Confirm file exists at `~/.zcode/agents/code-reviewer.md` or configured `${storage.dir}/agents/code-reviewer.md`.
5. Disable `code-reviewer`.
6. Start a new agent session.
7. Inspect model-io/provider-visible request and confirm `code-reviewer` is absent from available agent list.
8. Enable `code-reviewer`.
9. Start another new agent session and confirm `code-reviewer` appears in provider-visible agent list.

Expected:

- Settings list and runtime provider-visible body agree.
- No workspace agent editing UI is exposed.
- Built-in agents are visible but readonly.

---

## Risks and Non-goals

- This plan does not change the separate provider-visible carrier question: ZCode currently injects the agent list through `context_prefix` rather than the Agent tool prompt.
- This plan does not add workspace/project agent creation or editing.
- This plan does not add plugin agents.
- This plan does not implement nested YAML object editing for `mcpServers`; P0 preserves simple array values and can expose raw text only.
- This plan does not change `Agent` / `Task` tool schema or SendMessage behavior.

## Self-Review Checklist

- [ ] Every P0 requirement maps to at least one task.
- [ ] Settings GUI writes runtime-consumed user agent root.
- [ ] Runtime consumes disabled state.
- [ ] Mention provider is not accidentally narrowed to settings user-only mode.
- [ ] Workspace editing is not exposed in UI.
- [ ] Built-in agents are readonly.
- [ ] No service import from `@zcode/core`.
- [ ] i18n keys exist in both zh-CN and en-US.
- [ ] `pnpm typecheck` and `pnpm lint` are included in validation.
