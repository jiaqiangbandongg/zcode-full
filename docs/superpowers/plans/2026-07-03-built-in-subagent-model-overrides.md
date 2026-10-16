# 内置 Subagent 模型覆盖实施计划

> **给执行 agent：** 必须使用 `superpowers:executing-plans` 按任务执行。本计划的步骤使用 `- [ ]` checklist 语法，执行时逐项勾选。

**目标：** 让用户可以像 custom subagent 一样，为内置 `general-purpose` 和 `Explore` subagent 持久配置模型。

**架构：** 不把内置 subagent 变成可编辑 custom agent，而是在现有 subagent state 上增加一层 built-in model override。Settings 只开放内置 agent 的模型选择，runtime 启动时读取同一份 state 并注入 built-in profile；`Explore` 的工具面必须和最终 child model 使用同一个 effective model 计算。

**技术栈：** TypeScript、React、Vitest、Zod/JSON Schema tool contract、现有 subagents service、现有 zcode-cli runtime/bootstrap。

## 本轮执行边界

- 不自动提交；计划中的 `git commit` 步骤只作为人工提交参考，本轮执行不运行。
- 不修改 `package.json`、`pnpm-lock.yaml`、`pnpm-workspace.yaml` 或构建拓扑；如果 E2E 构建入口因既有 workspace 问题失败，只记录为验证阻塞。
- E2E 不验证“Settings 热保存后已启动 agent 立即生效”。当前桌面 agent 会在窗口启动早期初始化，正式 E2E 只验证启动前已有 `agents-state.json` 覆盖时：Settings 回显、bootstrap 读取、child provider-visible request 使用覆盖模型。
- Settings 保存/清空覆盖由 UI/service 单测覆盖；provider-visible runtime 生效由 core/bootstrap 单测和冷启动 WDIO case 覆盖。
- 只覆盖内置 `general-purpose` / `Explore` 的模型覆盖；不扩展 prompt/tools/description/delete/disable，也不引入 workspace 级覆盖或 mobile `/remote` replayable 语义。
- `Explore` 的工具面断言以 effective child model 为准；无覆盖时 effective child model 继承主模型，不能再按旧 `lite` 默认值计算。

## 全局约束

- 新增功能先补 `docs` spec，再实现代码。
- 涉及 `packages/ui` 的 UI 改动前必须遵守根目录 `DESIGN.md`。
- 内置 `general-purpose` / `Explore` 仍然只读；本计划只开放模型覆盖，不开放 prompt、tools、description、delete、disable。
- custom subagent 现有模型格式继续使用 `custom:provider-id:model-id`，不新增第二套模型 id 格式。
- `general-purpose` 未配置覆盖时继续继承父会话主模型。
- `Explore` 未配置覆盖时继承父会话主模型。
- `Explore` provider-visible child tools 必须按最终 effective child model 判断 embedded-search 分支。
- 不把 subagent/session/task 状态下沉到 relay 或 Electron main。
- 若执行中改动 `Agent` tool provider-visible schema，必须同步更新 `apps/zcode-cli/docs/design/v2/tool/00-tool-change-chain.md` 与 `apps/zcode-cli/docs/design/v2/tool/07-subagent.md`。
- 每个 phase 完成后跑 targeted tests；最终跑 `pnpm typecheck` 与 `pnpm lint`。

---

## 当前事实

- `apps/zcode-cli/packages/core/src/subagent/profile.ts` 的 `AgentProfile` 已支持 `model?: string`。
- custom markdown profile 已支持保存 `model: custom:provider:model`。
- `createBuiltInExploreAgentProfile()` 当前不再写默认 `model` 字段，运行时等价于继承 main model。
- `createBuiltInGeneralPurposeAgentProfile()` 当前没有 `model` 字段，运行时等价于继承 main model。
- `apps/zcode-cli/packages/core/src/subagent/runner.ts` 已经把 `request.model` 与 `profile.model` 合并后传给 child runtime。
- `apps/zcode-cli/packages/core/src/runtime/methods/subagent.ts` 已经能把 `custom:provider:model` 解析成 `ModelRef`。
- `packages/services/src/subagents/subagentsService.ts` 当前把内置 agent 作为 `readOnly: true` summary 返回。
- `packages/ui/src/settings/SubagentsSection.tsx` 当前只允许 user agent edit/delete/toggle，并隐藏 built-in model badge。

## 文件职责

- 新建 `docs/subagents-built-in-model-overrides.md`：功能与 runtime 语义 spec。
- 修改 `docs/ui/subagents-built-in-model-badge.md`：从“隐藏内置模型 badge”改成“内置模型只读配置控件”。
- 修改 `packages/shared/src/subagents-types.ts`：共享 built-in override 类型与 service 参数。
- 修改 `packages/services/src/subagents/subagents.ts`：新增 service 方法。
- 修改 `packages/services/src/subagents/subagentsService.ts`：读写 state、投影 built-in effective model。
- 修改 `packages/services/test/subagentsService.test.ts`：service 侧 state 与 list 测试。
- 修改 `apps/zcode-cli/packages/bootstrap/src/subagents.ts`：启动时读取 built-in overrides。
- 修改 `apps/zcode-cli/packages/bootstrap/src/app/create-app.ts`：把 overrides 传入 runtime config。
- 修改 `apps/zcode-cli/packages/bootstrap/src/app/runtime-config.ts`：合并 config overrides。
- 修改 `apps/zcode-cli/packages/bootstrap/tests/subagents.test.ts`：bootstrap loader 测试。
- 修改 `apps/zcode-cli/packages/core/src/runtime/types.ts`：runtime config 增加 `subagents.builtInModelOverrides`。
- 修改 `apps/zcode-cli/packages/core/src/subagent/profile.ts`：built-in profile 创建时接收 overrides。
- 修改 `apps/zcode-cli/packages/core/src/subagent/runner.ts`：`Explore` allowed tools 接收 effective model 上下文。
- 修改 `apps/zcode-cli/packages/core/src/runtime/methods/subagent.ts`：抽 shared effective model resolver，供 child runtime 与 allowlist 共用。
- 修改 `apps/zcode-cli/packages/core/tests/subagent-profile.test.ts`：profile override 测试。
- 修改 `apps/zcode-cli/packages/core/tests/subagent-explore.test.ts`：provider-visible child model 与 `Explore` tool branch 测试。
- 修改 `packages/ui/src/settings/SubagentsSection.tsx`：内置 row 增加模型控件。
- 修改 `packages/ui/test/subagentsSection.test.ts`：UI 渲染与保存行为测试。
- 修改现有 i18n 文件：补内置默认模型、保存失败文案。

## Phase 0：补 spec 并锁定边界

### Task 1：写功能 spec

**文件：**
- 新建 `docs/subagents-built-in-model-overrides.md`
- 修改 `docs/ui/subagents-built-in-model-badge.md`

**产出接口：**
- 明确 `BuiltInSubagentName = "general-purpose" | "Explore"`。
- 明确 `builtInModelOverrides` 存储在现有 subagent state 文件里。
- 明确内置 agent 只开放模型覆盖。

- [ ] **Step 1：创建功能 spec**

创建 `docs/subagents-built-in-model-overrides.md`，写入：

````markdown
# 内置 Subagent 模型覆盖

## 目标

用户可以为内置 `general-purpose` 和 `Explore` subagent 配置持久模型覆盖。

## 非目标

- 不允许编辑内置 agent 的名称、描述、system prompt、tools、权限、删除状态。
- 不允许禁用内置 agent。
- 不新增 workspace 级内置覆盖。
- 不改变 custom subagent 的 markdown 模型字段语义。

## 默认行为

- `general-purpose` 未配置覆盖时继承父会话 main model。
- `Explore` 未配置覆盖时继承父会话 main model。
- 清空覆盖后恢复上述默认行为。

## 存储格式

扩展现有 subagent state：

```json
{
  "disabledAgentIds": [],
  "builtInModelOverrides": {
    "general-purpose": "custom:custom-openai:gpt-5.4",
    "Explore": "custom:custom-openai:glm-5.2"
  }
}
```

缺少 `builtInModelOverrides` 表示没有覆盖。

## Runtime 语义

```ts
type BuiltInSubagentName = "general-purpose" | "Explore";
type BuiltInSubagentModelOverrides = Partial<Record<BuiltInSubagentName, string>>;
```

runtime bootstrap 读取 state 后，把 overrides 注入 built-in profile 构造。custom / project / plugin profile 的既有加载与优先级保持不变。

## Explore 工具面

`Explore` 的 allowed tools 必须使用最终 effective child model 判断 embedded-search 分支。也就是说，无覆盖时应按继承的 main model 计算，配置覆盖后按覆盖模型计算。

## 验收

- Settings 中内置 agent 有模型控件。
- Settings 中内置 agent 仍无编辑、删除、禁用入口。
- 保存 `general-purpose` 覆盖后，child provider-visible request 使用覆盖模型。
- 保存 `Explore` 覆盖后，child provider-visible request 使用覆盖模型。
- `Explore` child tools 与覆盖模型能力一致。
- 清空覆盖恢复默认模型。
````

- [ ] **Step 2：更新 UI 文档**

把 `docs/ui/subagents-built-in-model-badge.md` 改为：

```markdown
# 内置 Subagent 模型控件

Settings 为内置 subagent 显示模型控件，但其他字段仍保持只读。

- `general-purpose` 默认继承父会话 main model。
- `Explore` 默认继承父会话 main model。
- 用户选择具体模型后写入 built-in model override。
- 清空覆盖后恢复内置默认行为。
- 内置 agent 不显示 edit、delete、enabled switch、prompt editor 或 tools editor。
- user 和 plugin subagent 继续沿用现有模型摘要展示。

该规则影响 `packages/ui` 展示、settings service state，以及 bootstrap 注入 runtime 的 built-in profile。
```

- [ ] **Step 3：文档自检**

运行：

```bash
node -e 'const fs=require("node:fs"); for (const file of ["docs/subagents-built-in-model-overrides.md","docs/ui/subagents-built-in-model-badge.md"]) { const text=fs.readFileSync(file,"utf8"); for (const marker of ["T"+"BD","TO"+"DO","implement "+"later","fill "+"in"]) { if (text.includes(marker)) { console.error(`${file}: ${marker}`); process.exitCode=1; } } }'
```

预期：无输出，退出码为 0。

- [ ] **Step 4：提交 spec**

```bash
git add docs/subagents-built-in-model-overrides.md docs/ui/subagents-built-in-model-badge.md
git commit -m "docs: specify built-in subagent model overrides"
```

## Phase 1：Shared 类型与 Service state

### Task 2：补共享类型与 service 接口

**文件：**
- 修改 `packages/shared/src/subagents-types.ts`
- 修改 `packages/services/src/subagents/subagents.ts`

**产出接口：**

```ts
export type BuiltInSubagentName = "general-purpose" | "Explore";
export type BuiltInSubagentModelOverrides = Partial<Record<BuiltInSubagentName, AgentProfileModel>>;

export interface BuiltInSubagentModelOverrideParams {
  agentName: BuiltInSubagentName;
  model?: AgentProfileModel;
}
```

- [ ] **Step 1：修改 shared 类型**

在 `packages/shared/src/subagents-types.ts` 的 agent 类型区域加入：

```ts
export type BuiltInSubagentName = "general-purpose" | "Explore";

export type BuiltInSubagentModelOverrides = Partial<Record<BuiltInSubagentName, AgentProfileModel>>;
```

扩展 `AgentSummary`：

```ts
  defaultModel?: AgentProfileModel;
  modelOverride?: AgentProfileModel;
```

加入 service 参数：

```ts
export interface BuiltInSubagentModelOverrideParams {
  agentName: BuiltInSubagentName;
  model?: AgentProfileModel;
}
```

- [ ] **Step 2：修改 service 接口**

在 `packages/services/src/subagents/subagents.ts` 引入 `BuiltInSubagentModelOverrideParams`，并在 `ISubagentsService` 增加：

```ts
  setBuiltInModelOverride(params: BuiltInSubagentModelOverrideParams): Promise<void>;
```

- [ ] **Step 3：运行类型检查**

```bash
pnpm typecheck
```

预期：出现 implementation 缺少 `setBuiltInModelOverride` 的类型错误。

### Task 3：实现 service state 读写

**文件：**
- 修改 `packages/services/src/subagents/subagentsService.ts`
- 修改 `packages/services/test/subagentsService.test.ts`

**消费接口：**
- `BuiltInSubagentModelOverrides`
- `BuiltInSubagentModelOverrideParams`

**产出接口：**
- `createSubagentsService().setBuiltInModelOverride(...)`
- `list()` 返回 built-in agent 的 `model`、`defaultModel`、`modelOverride`

- [ ] **Step 1：写失败测试**

在 `packages/services/test/subagentsService.test.ts` 的 `describe("createSubagentsService", ...)` 中加入：

```ts
  it("persists model overrides for built-in subagents without making them editable", async () => {
    const home = await makeTempHome();
    const workspacePath = join(home, "workspace");
    const service = createSubagentsService({ homeDir: home, isDesktopRuntime: true });

    await service.setBuiltInModelOverride({
      agentName: "general-purpose",
      model: "custom:custom-openai:gpt-5.4",
    });
    await service.setBuiltInModelOverride({
      agentName: "Explore",
      model: "custom:custom-openai:glm-5.2",
    });

    const result = await service.list({
      workspacePath,
      provider: "glm",
      mode: "settingsUserOnly",
    });

    expect(result.agents.find((agent) => agent.name === "general-purpose")).toMatchObject({
      model: "custom:custom-openai:gpt-5.4",
      modelOverride: "custom:custom-openai:gpt-5.4",
      readOnly: true,
    });
    expect(result.agents.find((agent) => agent.name === "Explore")).toMatchObject({
      defaultModel: "lite",
      model: "custom:custom-openai:glm-5.2",
      modelOverride: "custom:custom-openai:glm-5.2",
      readOnly: true,
    });
  });

  it("clears a built-in subagent model override and restores the built-in default", async () => {
    const home = await makeTempHome();
    const workspacePath = join(home, "workspace");
    const service = createSubagentsService({ homeDir: home, isDesktopRuntime: true });

    await service.setBuiltInModelOverride({
      agentName: "Explore",
      model: "custom:custom-openai:glm-5.2",
    });
    await service.setBuiltInModelOverride({
      agentName: "Explore",
      model: undefined,
    });

    const result = await service.list({
      workspacePath,
      provider: "glm",
      mode: "settingsUserOnly",
    });

    expect(result.agents.find((agent) => agent.name === "Explore")).toMatchObject({
      model: undefined,
      modelOverride: undefined,
      readOnly: true,
    });
  });
```

- [ ] **Step 2：确认测试失败**

```bash
pnpm --filter @zcode/services test -- --run test/subagentsService.test.ts
```

预期：失败，原因是 `setBuiltInModelOverride` 尚未实现。

- [ ] **Step 3：扩展 state 结构**

在 `packages/services/src/subagents/subagentsService.ts` 中修改 import：

```ts
  type BuiltInSubagentModelOverrideParams,
  type BuiltInSubagentModelOverrides,
```

修改 state interface：

```ts
interface AgentsStateFile {
  builtInModelOverrides: BuiltInSubagentModelOverrides;
  disabledAgentIds: string[];
}
```

加入空 state helper：

```ts
function emptyAgentsState(): AgentsStateFile {
  return {
    builtInModelOverrides: {},
    disabledAgentIds: [],
  };
}
```

- [ ] **Step 4：读 state 时兼容旧文件**

把 `readAgentStateFile()` 中的 fallback 改成 `emptyAgentsState()`，并解析 overrides：

```ts
const builtInModelOverrides = isRecord(parsed.builtInModelOverrides)
  ? normalizeBuiltInModelOverrides(parsed.builtInModelOverrides)
  : {};

return {
  builtInModelOverrides,
  disabledAgentIds: Array.isArray(parsed.disabledAgentIds)
    ? parsed.disabledAgentIds.filter(
        (id): id is string => typeof id === "string" && id.trim().length > 0,
      )
    : [],
};
```

在文件底部已有工具函数附近加入：

```ts
function normalizeBuiltInModelOverrides(input: Record<string, unknown>): BuiltInSubagentModelOverrides {
  const result: BuiltInSubagentModelOverrides = {};
  const generalPurpose = scalarModel(input["general-purpose"]);
  const explore = scalarModel(input.Explore);
  if (generalPurpose) result["general-purpose"] = generalPurpose;
  if (explore) result.Explore = explore;
  return result;
}

function scalarModel(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}
```

若本文件没有 `isRecord()`，加入：

```ts
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
```

- [ ] **Step 5：built-in summary 投影 override**

把 `createBuiltInAgents()` 改成：

```ts
function createBuiltInAgents(overrides: BuiltInSubagentModelOverrides = {}): AgentSummary[] {
  const generalPurposeOverride = overrides["general-purpose"]?.trim();
  const exploreOverride = overrides.Explore?.trim();
  return [
    {
      id: createAgentStateId({
        name: "general-purpose",
        scope: "built-in",
        source: "built-in",
      }),
      name: "general-purpose",
      description:
        "General-purpose agent for researching complex questions, searching for code, and executing multi-step tasks.",
      color: "blue",
      ...(generalPurposeOverride
        ? { model: generalPurposeOverride, modelOverride: generalPurposeOverride }
        : {}),
      systemPrompt: "",
      tools: ["*"],
      path: "built-in:general-purpose",
      scope: "built-in",
      source: "built-in",
      enabled: true,
      readOnly: true,
    },
    {
      id: createAgentStateId({
        name: "Explore",
        scope: "built-in",
        source: "built-in",
      }),
      name: "Explore",
      description: "Read-only search agent for broad fan-out searches.",
      color: "cyan",
      defaultModel: "lite",
      model: exploreOverride || "lite",
      ...(exploreOverride ? { modelOverride: exploreOverride } : {}),
      systemPrompt: "",
      tools: ["Bash", "Glob", "Grep", "Read", "WebFetch", "WebSearch", "TodoWrite"],
      path: "built-in:Explore",
      scope: "built-in",
      source: "built-in",
      enabled: true,
      readOnly: true,
    },
  ];
}
```

在 `list()` 里先读 state，再创建 built-ins：

```ts
const state = await readAgentStateFile(storageOptions);
const builtInAgents = createBuiltInAgents(state.builtInModelOverrides);
```

删除后面重复读取 state 的代码，保留 `attachEnabledState(discoveredAgents, state)`。

- [ ] **Step 6：实现保存方法**

在 service object 中加入：

```ts
async setBuiltInModelOverride(params: BuiltInSubagentModelOverrideParams): Promise<void> {
  const runUpdate = async () => {
    const state = await readAgentStateFile(storageOptions);
    const builtInModelOverrides = { ...state.builtInModelOverrides };
    const model = params.model?.trim();
    if (model) {
      builtInModelOverrides[params.agentName] = model;
    } else {
      delete builtInModelOverrides[params.agentName];
    }
    await writeAgentStateFile(
      {
        ...state,
        builtInModelOverrides,
      },
      storageOptions,
    );
  };

  const queued = writeQueue.then(runUpdate, runUpdate);
  writeQueue = queued.catch(() => {});
  await queued;
},
```

- [ ] **Step 7：跑 service 测试**

```bash
pnpm --filter @zcode/services test -- --run test/subagentsService.test.ts
```

预期：通过。

- [ ] **Step 8：提交**

```bash
git add packages/shared/src/subagents-types.ts packages/services/src/subagents/subagents.ts packages/services/src/subagents/subagentsService.ts packages/services/test/subagentsService.test.ts
git commit -m "feat(subagents): persist built-in model overrides"
```

## Phase 2：Bootstrap 与 Runtime 消费

### Task 4：启动时读取 built-in overrides

**文件：**
- 修改 `apps/zcode-cli/packages/bootstrap/src/subagents.ts`
- 修改 `apps/zcode-cli/packages/bootstrap/src/app/create-app.ts`
- 修改 `apps/zcode-cli/packages/bootstrap/src/app/runtime-config.ts`
- 修改 `apps/zcode-cli/packages/bootstrap/tests/subagents.test.ts`
- 修改 `apps/zcode-cli/packages/core/src/runtime/types.ts`

**产出接口：**

```ts
subagents: {
  builtInModelOverrides?: BuiltInSubagentModelOverrides;
}
```

- [ ] **Step 1：写失败测试**

在 `apps/zcode-cli/packages/bootstrap/tests/subagents.test.ts` 的 `describe("loadZCodeAgentProfiles", ...)` 中加入：

```ts
it("loads built-in model overrides from shared subagent state", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcode-subagents-built-in-model-"));
  const storageRoot = join(root, "home");
  const workingDirectory = join(root, "workspace");
  try {
    await mkdir(join(storageRoot, "v2"), { recursive: true });
    await writeFile(
      join(storageRoot, "v2", "agents-state.json"),
      JSON.stringify({
        disabledAgentIds: [],
        builtInModelOverrides: {
          "general-purpose": "custom:custom-openai:gpt-5.4",
          Explore: "custom:custom-openai:glm-5.2",
        },
      }),
      "utf8",
    );

    const result = loadZCodeAgentProfiles({ storageRoot, workingDirectory });

    expect(result.builtInModelOverrides).toEqual({
      "general-purpose": "custom:custom-openai:gpt-5.4",
      Explore: "custom:custom-openai:glm-5.2",
    });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
```

- [ ] **Step 2：确认测试失败**

```bash
pnpm --filter @zcode/bootstrap test -- --run tests/subagents.test.ts
```

预期：失败，原因是 loader 尚未返回 `builtInModelOverrides`。

- [ ] **Step 3：扩展 bootstrap loader**

在 `apps/zcode-cli/packages/bootstrap/src/subagents.ts` 引入 shared 类型：

```ts
import type { BuiltInSubagentModelOverrides } from "@zcode/shared";
```

扩展 result：

```ts
interface LoadZCodeAgentProfilesResult {
  builtInModelOverrides: BuiltInSubagentModelOverrides;
  diagnostics: AgentProfileParseDiagnostic[];
  profiles: AgentProfile[];
}
```

用 `readAgentState()` 替换原 `readDisabledAgentIds()`：

```ts
const state = readAgentState(input.storageRoot);
const disabledAgentIds = state.disabledAgentIds;
```

返回：

```ts
return {
  builtInModelOverrides: state.builtInModelOverrides,
  diagnostics,
  profiles,
};
```

加入 helper：

```ts
function readAgentState(storageRoot: string): {
  builtInModelOverrides: BuiltInSubagentModelOverrides;
  disabledAgentIds: Set<string>;
} {
  try {
    const raw = readFileSync(join(storageRoot, "v2", "agents-state.json"), "utf8");
    const parsed = JSON.parse(raw) as { builtInModelOverrides?: unknown; disabledAgentIds?: unknown };
    return {
      builtInModelOverrides: isRecord(parsed.builtInModelOverrides)
        ? normalizeBuiltInModelOverrides(parsed.builtInModelOverrides)
        : {},
      disabledAgentIds: new Set(
        Array.isArray(parsed.disabledAgentIds)
          ? parsed.disabledAgentIds.filter(
              (id): id is string => typeof id === "string" && id.trim().length > 0,
            )
          : [],
      ),
    };
  } catch {
    return { builtInModelOverrides: {}, disabledAgentIds: new Set() };
  }
}

function normalizeBuiltInModelOverrides(input: Record<string, unknown>): BuiltInSubagentModelOverrides {
  const result: BuiltInSubagentModelOverrides = {};
  const generalPurpose = scalarModel(input["general-purpose"]);
  const explore = scalarModel(input.Explore);
  if (generalPurpose) result["general-purpose"] = generalPurpose;
  if (explore) result.Explore = explore;
  return result;
}

function scalarModel(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
```

- [ ] **Step 4：把 overrides 传入 runtime config**

在 `apps/zcode-cli/packages/bootstrap/src/app/create-app.ts` 中保留 loader outcome：

```ts
const zcodeSubagentProfileOutcome = loadZCodeAgentProfiles({
  logger,
  storageRoot,
  workingDirectory,
});
const zcodeSubagentProfiles = zcodeSubagentProfileOutcome.profiles;
```

调用 `resolveAppRuntimeConfig()` 时传入：

```ts
builtInSubagentModelOverrides: zcodeSubagentProfileOutcome.builtInModelOverrides,
```

在 `apps/zcode-cli/packages/bootstrap/src/app/runtime-config.ts` 的 input 类型加入：

```ts
builtInSubagentModelOverrides: BuiltInSubagentModelOverrides;
```

合并进 runtime config：

```ts
subagents: {
  ...options.runtimeConfig?.subagents,
  builtInModelOverrides: {
    ...input.builtInSubagentModelOverrides,
    ...options.runtimeConfig?.subagents?.builtInModelOverrides,
  },
  enabled: options.runtimeConfig?.subagents?.enabled ?? configResult.config.features.subagent,
  outputRootDir: options.runtimeConfig?.subagents?.outputRootDir ?? subagentOutputRootDir,
  profiles: [
    ...(options.runtimeConfig?.subagents?.profiles ?? []),
    ...subagentProfiles,
  ],
},
```

- [ ] **Step 5：扩展 core runtime 类型**

在 `apps/zcode-cli/packages/core/src/runtime/types.ts` 中给 `subagents` 增加：

```ts
builtInModelOverrides?: Partial<Record<"general-purpose" | "Explore", string>>;
```

不要让 core 反向依赖 services。若 core 当前允许依赖 `@zcode/shared`，也可以使用 shared 类型；否则保留上面的 core-local 类型。

- [ ] **Step 6：跑 bootstrap 测试**

```bash
pnpm --filter @zcode/bootstrap test -- --run tests/subagents.test.ts
```

预期：通过。

### Task 5：内置 profile 应用模型覆盖

**文件：**
- 修改 `apps/zcode-cli/packages/core/src/subagent/profile.ts`
- 修改 `apps/zcode-cli/packages/core/src/subagent/runner.ts`
- 修改 `apps/zcode-cli/packages/core/src/runtime/methods/subagent.ts`
- 修改 `apps/zcode-cli/packages/core/tests/subagent-profile.test.ts`
- 修改 `apps/zcode-cli/packages/core/tests/subagent-explore.test.ts`

- [ ] **Step 1：写 profile 失败测试**

在 `apps/zcode-cli/packages/core/tests/subagent-profile.test.ts` 中加入：

```ts
it("applies built-in model overrides when normalizing built-in profiles", () => {
  const profiles = normalizeAgentProfiles([], {
    builtInModelOverrides: {
      "general-purpose": "custom:custom-openai:gpt-5.4",
      Explore: "custom:custom-openai:glm-5.2",
    },
  });

  expect(profiles.find((profile) => profile.name === "general-purpose")?.model).toBe(
    "custom:custom-openai:gpt-5.4",
  );
  expect(profiles.find((profile) => profile.name === "Explore")?.model).toBe(
    "custom:custom-openai:glm-5.2",
  );
});
```

- [ ] **Step 2：修改 built-in profile 构造**

在 `apps/zcode-cli/packages/core/src/subagent/profile.ts` 中加入：

```ts
export type BuiltInSubagentModelOverrides = Partial<
  Record<typeof GENERAL_PURPOSE_AGENT_TYPE | typeof EXPLORE_AGENT_TYPE, AgentProfileModel>
>;
```

修改 `createBuiltInExploreAgentProfile()`：

```ts
export function createBuiltInExploreAgentProfile(
  options: { model?: AgentProfileModel } = {},
): AgentProfile {
  return {
    name: EXPLORE_AGENT_TYPE,
    description:
      'Read-only search agent for broad fan-out searches - when answering means sweeping many files, directories, or naming conventions and you only need the conclusion, not the file dumps. It reads excerpts rather than whole files, so it locates code; it doesn\\'t review or audit it. Specify search breadth: "medium" for moderate exploration, "very thorough" for multiple locations and naming conventions.',
    color: "cyan",
    model: options.model?.trim() || "lite",
    source: "built-in",
    systemPrompt: "",
    tools: ["Bash", "Glob", "Grep", "Read", "WebFetch", "WebSearch", "TodoWrite"],
  };
}
```

修改 `createBuiltInGeneralPurposeAgentProfile()`：

```ts
export function createBuiltInGeneralPurposeAgentProfile(
  options: { model?: AgentProfileModel } = {},
): AgentProfile {
  const model = options.model?.trim();
  return {
    name: DEFAULT_SUBAGENT_TYPE,
    description:
      "General-purpose agent for researching complex questions, searching for code, and executing multi-step tasks. When you are searching for a keyword or file and are not confident that you will find the right match in the first few tries use this agent to perform the search for you.",
    color: "blue",
    ...(model ? { model } : {}),
    source: "built-in",
    systemPrompt: buildGeneralPurposeSystemPrompt(),
    tools: ["*"],
  };
}
```

修改 `normalizeAgentProfiles()`：

```ts
export function normalizeAgentProfiles(
  profiles: readonly AgentProfile[],
  options: { builtInModelOverrides?: BuiltInSubagentModelOverrides } = {},
): AgentProfile[] {
  const active = new Map<string, AgentProfile>();
  active.set(
    DEFAULT_SUBAGENT_TYPE,
    createBuiltInGeneralPurposeAgentProfile({
      model: options.builtInModelOverrides?.[DEFAULT_SUBAGENT_TYPE],
    }),
  );
  active.set(
    EXPLORE_AGENT_TYPE,
    createBuiltInExploreAgentProfile({
      model: options.builtInModelOverrides?.[EXPLORE_AGENT_TYPE],
    }),
  );
  for (const profile of profiles) {
    active.set(profile.name, profile);
  }
  return Array.from(active.values());
}
```

- [ ] **Step 3：把 runtime config 传入 port**

在 `apps/zcode-cli/packages/core/src/subagent/runner.ts` 的 `ExploreSubagentPortOptions` 中加入：

```ts
builtInModelOverrides?: BuiltInSubagentModelOverrides;
```

创建 profiles 时改为：

```ts
const profiles = normalizeAgentProfiles(options.profiles ?? [], {
  builtInModelOverrides: options.builtInModelOverrides,
});
```

在 `apps/zcode-cli/packages/core/src/runtime/methods/subagent.ts` 创建 port 时加入：

```ts
builtInModelOverrides: this.config.subagents?.builtInModelOverrides,
```

- [ ] **Step 4：写 runtime provider-visible 模型测试**

在 `apps/zcode-cli/packages/core/tests/subagent-explore.test.ts` 中加入 `general-purpose` 测试：

```ts
it("runs built-in general-purpose on configured concrete model override", async () => {
  const sessionId = createSessionId("runtime-general-purpose-built-in-model-override");
  const eventStore = createTestSessionEventStore();
  const childRequests: any[] = [];
  let parentCallCount = 0;

  const runtime = new AgentRuntime(
    sessionId,
    {
      mode: "build",
      modelRef: {
        providerId: createModelProviderId("provider-main"),
        modelId: createModelId("main-model"),
        role: ModelRole.Main,
        source: ModelRefSource.Config,
      },
      workingDirectory: "/workspace/project",
      subagents: {
        builtInModelOverrides: {
          "general-purpose": "custom:custom-openai:gpt-5.4",
        },
      },
    },
    {
      eventStore,
      modelAdapter: {
        async generateText(request: any) {
          const toolNames = (request.tools ?? []).map((tool: any) => tool.name);
          if (toolNames.includes("Agent")) {
            parentCallCount++;
            if (parentCallCount === 1) {
              return {
                finishReason: "tool-calls",
                model: request.model,
                providerMetadata: undefined,
                text: "",
                toolCalls: [
                  {
                    id: "call_general_purpose_override",
                    name: "Agent",
                    input: {
                      description: "Inspect defaults",
                      prompt: "Inspect the default agent model.",
                    },
                  },
                ],
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              };
            }
            return {
              finishReason: "stop",
              model: request.model,
              providerMetadata: undefined,
              text: "done",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            };
          }

          childRequests.push(request);
          return {
            finishReason: "stop",
            model: request.model,
            providerMetadata: undefined,
            text: "general-purpose used override.",
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          };
        },
      } as never,
    },
  );

  await runtime.executeTurn("Use the default Agent");

  expect(childRequests[0].model).toMatchObject({
    providerId: "custom-openai",
    modelId: "gpt-5.4",
    role: ModelRole.Subagent,
  });
});
```

再加入 `Explore` 测试：

```ts
it("runs built-in Explore on configured concrete model override", async () => {
  const sessionId = createSessionId("runtime-explore-built-in-model-override");
  const eventStore = createTestSessionEventStore();
  const childRequests: any[] = [];
  let parentCallCount = 0;

  const runtime = new AgentRuntime(
    sessionId,
    {
      mode: "build",
      modelRef: {
        providerId: createModelProviderId("provider-main"),
        modelId: createModelId("main-model"),
        role: ModelRole.Main,
        source: ModelRefSource.Config,
      },
      workingDirectory: "/workspace/project",
      subagents: {
        builtInModelOverrides: {
          Explore: "custom:custom-openai:glm-5.2",
        },
      },
    },
    {
      eventStore,
      modelAdapter: {
        async generateText(request: any) {
          const toolNames = (request.tools ?? []).map((tool: any) => tool.name);
          if (toolNames.includes("Agent")) {
            parentCallCount++;
            if (parentCallCount === 1) {
              return {
                finishReason: "tool-calls",
                model: request.model,
                providerMetadata: undefined,
                text: "",
                toolCalls: [
                  {
                    id: "call_explore_override",
                    name: "Agent",
                    input: {
                      description: "Inspect search",
                      prompt: "Inspect the Explore model.",
                      subagent_type: "Explore",
                    },
                  },
                ],
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              };
            }
            return {
              finishReason: "stop",
              model: request.model,
              providerMetadata: undefined,
              text: "done",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            };
          }

          childRequests.push(request);
          return {
            finishReason: "stop",
            model: request.model,
            providerMetadata: undefined,
            text: "Explore used override.",
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          };
        },
      } as never,
    },
  );

  await runtime.executeTurn("Use Explore");

  expect(childRequests[0].model).toMatchObject({
    providerId: "custom-openai",
    modelId: "glm-5.2",
    role: ModelRole.Subagent,
  });
});
```

- [ ] **Step 5：跑 core targeted tests**

```bash
pnpm --filter @zcode/core test -- --run tests/subagent-profile.test.ts tests/subagent-explore.test.ts
```

预期：通过。

### Task 6：修正 Explore allowed tools 的 effective model 边界

**文件：**
- 修改 `apps/zcode-cli/packages/core/src/subagent/runner.ts`
- 修改 `apps/zcode-cli/packages/core/src/runtime/methods/subagent.ts`
- 修改 `apps/zcode-cli/packages/core/tests/subagent-explore.test.ts`

**目标：** `Explore` child request 使用哪个模型，`Explore` allowed tools 就按哪个模型判断。

- [ ] **Step 1：写失败测试**

在 `apps/zcode-cli/packages/core/tests/subagent-explore.test.ts` 中新增测试。模型名要选一个当前 capability resolver 会走 direct fallback 的 fixture；如果下面 provider/model 与当前 capability 表不匹配，只改 provider/model 字符串，不改断言目标：

```ts
it("resolves Explore allowed tools from the effective overridden model", async () => {
  const sessionId = createSessionId("runtime-explore-override-tool-branch");
  const eventStore = createTestSessionEventStore();
  const childRequests: any[] = [];
  let parentCallCount = 0;

  const runtime = new AgentRuntime(
    sessionId,
    {
      mode: "build",
      modelRef: {
        providerId: createModelProviderId("provider-main"),
        modelId: createModelId("main-model"),
        role: ModelRole.Main,
        source: ModelRefSource.Config,
      },
      liteModelRef: {
        providerId: createModelProviderId("provider-lite"),
        modelId: createModelId("lite-model"),
        role: ModelRole.Lite,
        source: ModelRefSource.Config,
      },
      workingDirectory: "/workspace/project",
      subagents: {
        builtInModelOverrides: {
          Explore: "custom:direct-search-provider:direct-search-model",
        },
      },
    },
    {
      eventStore,
      modelConnectionPort: {
        resolveConnection(modelRef) {
          return {
            baseURL: "https://example.test",
            providerId: modelRef.providerId,
            providerKind: "anthropic",
          };
        },
      },
      modelAdapter: {
        async generateText(request: any) {
          const toolNames = (request.tools ?? []).map((tool: any) => tool.name);
          if (toolNames.includes("Agent")) {
            parentCallCount++;
            if (parentCallCount === 1) {
              return {
                finishReason: "tool-calls",
                model: request.model,
                providerMetadata: undefined,
                text: "",
                toolCalls: [
                  {
                    id: "call_explore_direct_branch",
                    name: "Agent",
                    input: {
                      description: "Inspect search branch",
                      prompt: "Inspect the Explore search branch.",
                      subagent_type: "Explore",
                    },
                  },
                ],
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              };
            }
            return {
              finishReason: "stop",
              model: request.model,
              providerMetadata: undefined,
              text: "done",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            };
          }

          childRequests.push(request);
          return {
            finishReason: "stop",
            model: request.model,
            providerMetadata: undefined,
            text: "Explore branch checked.",
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          };
        },
      } as never,
    },
  );

  await runtime.executeTurn("Use Explore");

  expect(childRequests[0].model).toMatchObject({
    providerId: "direct-search-provider",
    modelId: "direct-search-model",
    role: ModelRole.Subagent,
  });
  expect(childRequests[0].tools.map((tool: any) => tool.name)).toEqual(
    expect.arrayContaining(["Glob", "Grep"]),
  );
});
```

- [ ] **Step 2：抽 effective model helper**

在 `apps/zcode-cli/packages/core/src/runtime/methods/subagent.ts` 中加入：

```ts
function resolveEffectiveSubagentModelRef(input: {
  agentType: string;
  defaultModelRef: ModelRef;
  liteModelRef?: ModelRef;
  model: string | undefined;
  profileModel: string | undefined;
}): { modelRef: ModelRef; useLiteModel: boolean } {
  const concreteModelRef = resolveConcreteSubagentModelRef(
    input.model,
    input.defaultModelRef.providerId,
  );
  const useLite =
    !concreteModelRef &&
    (input.model === "lite" ||
      (input.model === undefined &&
        input.profileModel === undefined &&
        input.agentType === EXPLORE_AGENT_TYPE));
  const selected =
    concreteModelRef ?? (useLite ? (input.liteModelRef ?? input.defaultModelRef) : input.defaultModelRef);
  return {
    modelRef: {
      ...selected,
      role: ModelRole.Subagent,
    },
    useLiteModel: useLite,
  };
}
```

把 `resolveSubagentModelRef()` 改成调用它：

```ts
return resolveEffectiveSubagentModelRef({
  agentType: request.agentType,
  defaultModelRef: this.defaultModelRef,
  liteModelRef: this.config.liteModelRef,
  model: request.model,
  profileModel: request.profile.model,
});
```

- [ ] **Step 3：runner 给 allowlist 传模型上下文**

在 `apps/zcode-cli/packages/core/src/subagent/runner.ts` 中把 `getAllowedTools` 类型改为：

```ts
getAllowedTools?: (input: {
  agentType: string;
  model?: AgentProfile["model"];
  profile: AgentProfile;
}) => readonly string[];
```

把 `resolveAllowedTools()` 改为：

```ts
function resolveAllowedTools(
  profile: AgentProfile,
  options: ExploreSubagentPortOptions,
  request?: Pick<SubagentRunRequest, "agentType" | "model">,
): readonly string[] {
  const profileTools =
    profile.name === EXPLORE_AGENT_TYPE
      ? options.getAllowedTools?.({
          agentType: request?.agentType ?? profile.name,
          model: resolveRequestedModel(request?.model, profile.model),
          profile,
        }) ?? getExploreAllowedTools(options)
      : profile.tools;
  const baseTools = [...(profileTools ?? [])];
  const disallowed = new Set(profile.disallowedTools ?? []);
  if (profile.skills && profile.skills.length > 0 && !disallowed.has("Skill")) {
    baseTools.push("Skill");
  }
  return baseTools.filter((tool) => !disallowed.has(tool));
}
```

把调用点改为：

```ts
allowedTools: [...resolveAllowedTools(profile, options, request)],
```

以及：

```ts
allowedTools: resolveAllowedTools(lifecycle.profile, options, request),
```

- [ ] **Step 4：runtime allowlist closure 使用 effective model**

在 `createDefaultSubagentPort()` 中改 `getAllowedTools`：

```ts
getAllowedTools: (input) => {
  const childModel = resolveEffectiveSubagentModelRef({
    agentType: input.agentType,
    defaultModelRef: this.defaultModelRef,
    liteModelRef: this.config.liteModelRef,
    model: input.model,
    profileModel: input.profile.model,
  }).modelRef;
  return buildExploreAllowedTools({
    embeddedSearchEnabled: resolveSubagentEmbeddedSearchEnabled(this, childModel),
  });
},
```

- [ ] **Step 5：跑 runtime 测试**

```bash
pnpm --filter @zcode/core test -- --run tests/subagent-explore.test.ts
```

预期：通过。

- [ ] **Step 6：提交 runtime**

```bash
git add apps/zcode-cli/packages/bootstrap/src/subagents.ts apps/zcode-cli/packages/bootstrap/src/app/create-app.ts apps/zcode-cli/packages/bootstrap/src/app/runtime-config.ts apps/zcode-cli/packages/bootstrap/tests/subagents.test.ts apps/zcode-cli/packages/core/src/runtime/types.ts apps/zcode-cli/packages/core/src/subagent/profile.ts apps/zcode-cli/packages/core/src/subagent/runner.ts apps/zcode-cli/packages/core/src/runtime/methods/subagent.ts apps/zcode-cli/packages/core/tests/subagent-profile.test.ts apps/zcode-cli/packages/core/tests/subagent-explore.test.ts
git commit -m "feat(agent): apply built-in subagent model overrides"
```

## Phase 3：Settings UI

### Task 7：给内置 subagent 增加模型控件

**文件：**
- 修改 `packages/ui/src/settings/SubagentsSection.tsx`
- 修改 `packages/ui/test/subagentsSection.test.ts`
- 修改现有 i18n 文件

**消费接口：**
- `AgentSummary.defaultModel`
- `AgentSummary.modelOverride`
- `subagentsService.setBuiltInModelOverride(...)`

- [ ] **Step 1：重新确认 UI 设计约束**

```bash
sed -n '1,220p' DESIGN.md
```

预期：确认使用紧凑业务 UI、semantic tokens、i18n 友好、浅色/深色兼容。

- [ ] **Step 2：补 service mock**

在 `packages/ui/test/subagentsSection.test.ts` 的 `subagentsService` mock 中加入：

```ts
setBuiltInModelOverride: vi.fn(),
```

- [ ] **Step 3：写 UI 失败测试**

在 `packages/ui/test/subagentsSection.test.ts` 中加入：

```ts
it("shows a model control for built-in subagents without edit or delete actions", async () => {
  stateOverrides = new Map<number, unknown>([
    [
      1,
      [
        {
          id: "built-in:built-in:general-purpose",
          name: "general-purpose",
          description: "General-purpose agent",
          systemPrompt: "",
          path: "built-in:general-purpose",
          scope: "built-in",
          source: "built-in",
          enabled: true,
          readOnly: true,
          tools: ["*"],
        },
        {
          id: "built-in:built-in:Explore",
          name: "Explore",
          description: "Search broadly",
          systemPrompt: "",
          defaultModel: "lite",
          model: "custom:custom-openai:gpt-5.4",
          modelOverride: "custom:custom-openai:gpt-5.4",
          path: "built-in:Explore",
          scope: "built-in",
          source: "built-in",
          enabled: true,
          readOnly: true,
          tools: ["Read"],
        },
      ],
    ],
    [2, { userScopeAvailable: true }],
  ]);

  const html = await renderSubagentsSection();

  expect(html).toContain("general-purpose");
  expect(html).toContain("Explore");
  expect(html).toContain("gpt-5.4");
  expect(capturedModelConfigSelects.length).toBeGreaterThan(0);
  expect(html).not.toContain("settings.subagents.edit");
  expect(html).not.toContain("common.delete");
});
```

- [ ] **Step 4：增加 built-in model helper**

在 `packages/ui/src/settings/SubagentsSection.tsx` 中加入：

```ts
function canConfigureBuiltInModel(agent: AgentSummary): boolean {
  return isBuiltInAgent(agent);
}

function getBuiltInDefaultModelValue(agent: AgentSummary): string {
  return agent.defaultModel?.trim() || INHERIT_MODEL_VALUE;
}

function getBuiltInModelValue(agent: AgentSummary): string {
  return agent.modelOverride?.trim() || getBuiltInDefaultModelValue(agent);
}
```

- [ ] **Step 5：增加 built-in 默认选项组**

加入：

```ts
function createBuiltInSubagentModelSelectGroups(
  defaultLabel: string,
  defaultValue: string,
  modelGroups: readonly ModelSelectGroup[],
): ModelSelectGroup[] {
  return [
    ...modelGroups,
    {
      key: "subagent-model:built-in-default",
      label: defaultLabel,
      directItems: true,
      items: [
        {
          key: "subagent-model:built-in-default:item",
          value: defaultValue,
          name: defaultLabel,
        },
      ],
    },
  ];
}
```

- [ ] **Step 6：新增内置模型控件组件**

在 `AgentListRow` 附近加入：

```tsx
function BuiltInModelControl({
  agent,
  disabled,
  modelSelectGroups,
  onChange,
  onManageModels,
}: {
  agent: AgentSummary;
  disabled: boolean;
  modelSelectGroups: readonly ModelSelectGroup[];
  onChange: (agent: AgentSummary, model: string) => void;
  onManageModels?: () => void;
}) {
  const { intl } = useZCodeIntl();
  const defaultValue = getBuiltInDefaultModelValue(agent);
  const defaultLabel = intl.formatMessage({ id: "settings.subagents.model.builtInDefault" });
  const groups = createBuiltInSubagentModelSelectGroups(defaultLabel, defaultValue, modelSelectGroups);
  const value = getBuiltInModelValue(agent);
  const label = resolveSubagentModelLabel(defaultLabel, groups, value);

  if (disabled) {
    return <AgentBadge>{label}</AgentBadge>;
  }

  return (
    <ModelConfigSelect
      modelGroups={groups}
      normalizedValue={value}
      triggerLabel={label}
      showManageModelsAction={Boolean(onManageModels)}
      lockReasonMessage=""
      isItemLocked={MODEL_ITEM_NEVER_LOCKED}
      onValueChange={(nextValue) => onChange(agent, nextValue)}
      tooltipTitle={intl.formatMessage({ id: "settings.subagents.form.model.label" })}
      manageModelsLabel={intl.formatMessage({ id: "chat.toolbar.model.manageModels" })}
      onManageModels={onManageModels}
      contentSide="bottom"
      focusSelectorOnClose={null}
      labelVisibilityClassName="inline-flex min-w-0"
      triggerClassName="h-7 w-fit max-w-full min-w-0 justify-between rounded-md border border-input-border bg-input px-2 py-1 text-sm text-foreground hover:border-input-border-hover hover:bg-input focus-visible:border-input-border-focused focus-visible:bg-input-focused"
      triggerLabelClassName="inline-flex min-w-0 truncate text-left"
    />
  );
}
```

- [ ] **Step 7：接入 AgentListRow**

扩展 `AgentListRow` props：

```ts
onBuiltInModelChange: (agent: AgentSummary, model: string) => void;
onManageModels?: () => void;
```

在 badges 区域渲染：

```tsx
{canConfigureBuiltInModel(agent) ? (
  <BuiltInModelControl
    agent={agent}
    disabled={isOperating}
    modelSelectGroups={modelSelectGroups}
    onChange={onBuiltInModelChange}
    onManageModels={onManageModels}
  />
) : showModelBadge ? (
  <AgentBadge>{modelLabel}</AgentBadge>
) : null}
```

保留 edit/delete/switch 的 `editable` guard，不要让 built-in 进入完整编辑表单。

- [ ] **Step 8：保存 built-in model override**

在 `SubagentsSection` 中加入：

```ts
const handleBuiltInModelChange = async (agent: AgentSummary, nextValue: string) => {
  if (!isBuiltInAgent(agent)) return;
  setOperatingAgentId(agent.id);
  try {
    const defaultValue = getBuiltInDefaultModelValue(agent);
    const model = nextValue === defaultValue ? undefined : toPersistedModel(nextValue);
    await subagentsService.setBuiltInModelOverride({
      agentName: agent.name as "general-purpose" | "Explore",
      model,
    });
    await refreshAgents({ silent: true });
  } catch (error) {
    toast({
      title: intl.formatMessage({ id: "settings.subagents.model.overrideFailed" }),
      description: error instanceof Error ? error.message : String(error),
      variant: "destructive",
    });
  } finally {
    setOperatingAgentId(null);
  }
};
```

把 `handleBuiltInModelChange` 和 `onManageModels` 传给每个 `AgentListRow`。

- [ ] **Step 9：补 i18n**

在现有 locale 文件中加入英文：

```json
{
  "settings.subagents.model.builtInDefault": "Inherit default",
  "settings.subagents.model.overrideFailed": "Failed to update subagent model"
}
```

中文：

```json
{
  "settings.subagents.model.builtInDefault": "继承默认",
  "settings.subagents.model.overrideFailed": "更新子智能体模型失败"
}
```

- [ ] **Step 10：跑 UI 测试**

```bash
pnpm --filter @zcode/ui test -- --run test/subagentsSection.test.ts
```

预期：通过。

- [ ] **Step 11：提交 UI**

```bash
git add packages/ui/src/settings/SubagentsSection.tsx packages/ui/test/subagentsSection.test.ts
git add packages/ui/src/i18n packages/ui/src/**/locales 2>/dev/null || true
git commit -m "feat(ui): configure built-in subagent models"
```

## Phase 4：验证与清理

### Task 8：端到端验证

**文件：**
- 不计划修改代码。若验证暴露问题，只改对应失败链路文件。

- [ ] **Step 1：跑 targeted tests**

```bash
pnpm --filter @zcode/services test -- --run test/subagentsService.test.ts
pnpm --filter @zcode/bootstrap test -- --run tests/subagents.test.ts
pnpm --filter @zcode/core test -- --run tests/subagent-profile.test.ts tests/subagent-explore.test.ts
pnpm --filter @zcode/ui test -- --run test/subagentsSection.test.ts
```

预期：全部通过。

- [ ] **Step 2：检查 provider-visible 断言**

确认 `apps/zcode-cli/packages/core/tests/subagent-explore.test.ts` 中存在：

```ts
expect(childRequests[0].model).toMatchObject({
  providerId: "custom-openai",
  modelId: "gpt-5.4",
  role: ModelRole.Subagent,
});
```

以及：

```ts
expect(childRequests[0].tools.map((tool: any) => tool.name)).toEqual(
  expect.arrayContaining(["Glob", "Grep"]),
);
```

- [ ] **Step 3：跑机械门禁**

```bash
pnpm typecheck
pnpm lint
```

预期：全部通过。

- [ ] **Step 4：查 stale 文档描述**

```bash
rg -n "hide built-in subagent model|内置.*不展示模型|built-in.*不展示模型|first version does not support.*Agent.*model" docs apps/zcode-cli/docs packages -S
```

预期：当前设计文档没有过期描述；changelog 里的历史记录可以保留。

- [ ] **Step 5：必要时提交文档清理**

若 Step 4 修改了当前 docs：

```bash
git add docs apps/zcode-cli/docs
git commit -m "docs: align subagent model override references"
```

若没有修改，不创建空提交。

## Phase 5：最终交付

### Task 9：最终状态与提交边界

- [ ] **Step 1：检查工作区**

```bash
git status --short
```

预期：只出现本功能相关改动；不要 revert 用户已有无关改动。

- [ ] **Step 2：最终门禁**

```bash
pnpm typecheck
pnpm lint
```

预期：全部通过。

- [ ] **Step 3：最终说明模板**

交付时使用：

```markdown
已实现内置 subagent 模型覆盖。

- `general-purpose` 可配置具体模型；未配置时继承 main model。
- `Explore` 可配置具体模型；未配置时继承 main model。
- 内置 agent 仍只读，只开放模型选择。
- `Explore` allowed tools 已按 effective child model 计算。

验证：
- `pnpm --filter @zcode/services test -- --run test/subagentsService.test.ts`
- `pnpm --filter @zcode/bootstrap test -- --run tests/subagents.test.ts`
- `pnpm --filter @zcode/core test -- --run tests/subagent-profile.test.ts tests/subagent-explore.test.ts`
- `pnpm --filter @zcode/ui test -- --run test/subagentsSection.test.ts`
- `pnpm typecheck`
- `pnpm lint`
```

## 风险与护栏

- 不要移除 built-in agent 的 `readOnly: true`。
- 不要允许 `createAgent` / `updateAgent` 写出名为 `general-purpose` 或 `Explore` 的 user markdown。
- 不要让 `Explore` allowed tools 继续按旧 lite model 判断。
- 不要在本计划中新增 workspace-specific built-in override；若未来要做，身份隔离 key 使用 `workspaceIdentity?.trim() || workspacePath`。
- 不要改 remote/mobile shared-host 远控边界。
- 不要改 provider-visible `Agent.model` schema，除非同 phase 更新 tool spec、contract、adapter 测试。

## 建议提交顺序

1. `docs: specify built-in subagent model overrides`
2. `feat(subagents): persist built-in model overrides`
3. `feat(agent): apply built-in subagent model overrides`
4. `feat(ui): configure built-in subagent models`
5. `docs: align subagent model override references`

## 自检清单

- [ ] 已先写 docs spec。
- [ ] `general-purpose` 覆盖已覆盖。
- [ ] `Explore` 覆盖已覆盖。
- [ ] custom subagent 模型行为未改变。
- [ ] built-in agent 除模型外仍只读。
- [ ] service state 读写有测试。
- [ ] bootstrap 加载 overrides 有测试。
- [ ] child provider-visible model 有断言。
- [ ] `Explore` allowed tools 与 effective model 对齐。
- [ ] UI 有 i18n 文案。
- [ ] targeted tests、`pnpm typecheck`、`pnpm lint` 都在计划中。
