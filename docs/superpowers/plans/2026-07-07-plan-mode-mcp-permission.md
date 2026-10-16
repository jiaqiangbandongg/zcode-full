# Plan Mode MCP Permission Boundary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Plan mode 下的 MCP 工具跳过普通 readonly 判定，但仍保留 MCP 身份识别、显式 destructive 拦截、项目 deny/ask 规则和现有非 MCP 写保护。

**Architecture:** 不改 MCP registry、metadata、protocol 或 UI。MCP 工具继续由 `apps/zcode-cli/packages/core/src/mcp/index.ts` 注册，权限层通过 `permission.permission === "mcp"` 形成的 `capability.permissionName` 识别 MCP；Plan mode 只新增一个 MCP 专用 permission 分支，避免把普通 unknown tool 或伪 `mcp__` 名称一起放过。

**Tech Stack:** TypeScript, Vitest, `@zcode/core` permission service, MCP bridge, ZCode runtime tool loop.

## Global Constraints

- 先更新 docs spec，再改测试和代码。
- 不修改 `packages/shared/src/zcode-protocol/index.ts`，因为本次不新增协议字段。
- 不修改 MCP registry / metadata / model-visible tool contract。
- 不修改 UI，不涉及 `packages/ui` 和 `DESIGN.md`。
- 不靠 `toolName.startsWith("mcp__")` 作为主判断；MCP 身份以 `permission.permission === "mcp"` 为准。
- Plan mode 下 project deny / project ask 仍优先于 MCP 专用 allow。
- Plan mode 下显式 `destructiveHint: true` 的 MCP 仍拒绝。
- Plan mode 下 `permission.permission === "mcp"` 且 `destructive !== true` 的 MCP 允许执行，即使 `readOnlyHint` 缺失或为 `false`。
- 保持 `ExitPlanMode` / `EnterPlanMode` 现有专用规则不变。
- 不自动提交 commit，除非用户后续明确要求。

---

## Phase 0: 文件与职责地图

**计划改动文件：**

- Modify: `docs/plan-mode-approval-boundary.md`
  - 记录 Plan mode 的 MCP 例外语义，明确“跳过 readonly 判定”不等于“跳过 destructive / project rules”。
- Modify: `apps/zcode-cli/packages/core/src/permission/service.ts`
  - 在 `PermissionService.checkPlanMode()` 中增加 MCP 专用分支。
  - 新增私有 helper，集中判断 `capability.permissionName === "mcp"`。
- Modify: `apps/zcode-cli/packages/core/tests/permission-service.test.ts`
  - 覆盖 permission service 层的 MCP plan-mode 策略。
- Modify: `apps/zcode-cli/packages/core/tests/mcp-runtime.test.ts`
  - 覆盖真实 runtime 中 MCP tool 在 Plan mode 下能被执行，且不走 permission broker。

**不改文件：**

- `apps/zcode-cli/packages/core/src/mcp/index.ts`
  - MCP 仍按 descriptor annotation 映射 `readOnly` / `destructive`。
- `apps/zcode-cli/packages/core/src/tool/executor/permission-flow.ts`
  - 已经会把 `entry.permission.permission` 合并为 `PermissionToolCapability.permission.permission`。
- `packages/shared/src/zcode-protocol/index.ts`
  - 没有协议变更。
- `packages/ui/**`
  - 没有 UI 交互变更。

---

## Phase 1: 先更新行为 spec

### Task 1: 更新 Plan mode MCP 权限边界文档

**Files:**

- Modify: `docs/plan-mode-approval-boundary.md`

**Interfaces:**

- Consumes: 当前 Plan mode 文档中的 `ExitPlanMode` 审批语义。
- Produces: 后续实现与测试共同遵守的 MCP 例外语义。

- [ ] **Step 1: 在文档 “语义” 段落后加入 MCP 例外说明**

在 `docs/plan-mode-approval-boundary.md` 的 `## 语义` 列表后追加：

```md

## MCP 工具例外

Plan mode 默认只允许只读、非 destructive 的工具执行。MCP 工具是外部 server 动态暴露的能力，部分工具不会声明 `readOnlyHint`，但仍需要在计划阶段用于读取外部上下文、设备状态或远端资料。

因此 Plan mode 对 MCP 工具使用独立权限边界：

- MCP 身份由工具权限声明 `permission.permission === "mcp"` 识别，不靠 `mcp__` 名称前缀推断。
- 项目级 `deny` / `ask` 规则仍优先生效，不能被 MCP 例外绕过。
- 显式声明 `destructiveHint: true` 的 MCP 工具仍在 Plan mode 下拒绝执行。
- 未显式 destructive 的 MCP 工具允许在 Plan mode 下执行，即使该工具没有声明 `readOnlyHint: true`。
- 该例外只跳过 Plan mode 的 readonly 判定，不改变 MCP 工具注册、模型可见 schema、输出预算、timeout、取消、日志或 UI 权限展示协议。
```

- [ ] **Step 2: 自检文档边界**

检查文档中同时说明了：

- MCP 识别来源是 permission 声明。
- destructive MCP 仍拒绝。
- project deny / ask 仍优先。
- 不改 UI / protocol。

Run:

```sh
rg -n "MCP 工具例外|permission.permission|destructiveHint|项目级" docs/plan-mode-approval-boundary.md
```

Expected:

```text
docs/plan-mode-approval-boundary.md:<line>:## MCP 工具例外
docs/plan-mode-approval-boundary.md:<line>:- MCP 身份由工具权限声明 `permission.permission === "mcp"` 识别，不靠 `mcp__` 名称前缀推断。
docs/plan-mode-approval-boundary.md:<line>:- 项目级 `deny` / `ask` 规则仍优先生效，不能被 MCP 例外绕过。
docs/plan-mode-approval-boundary.md:<line>:- 显式声明 `destructiveHint: true` 的 MCP 工具仍在 Plan mode 下拒绝执行。
```

---

## Phase 2: 先补 PermissionService 层失败测试

### Task 2: 覆盖 MCP Plan mode 策略

**Files:**

- Modify: `apps/zcode-cli/packages/core/tests/permission-service.test.ts`

**Interfaces:**

- Consumes: `PermissionService.checkPermission(context, capability, projectRules?)`
- Produces: 新的 expected behavior，供实现 `checkPlanMode()` 时驱动。

- [ ] **Step 1: 增加 MCP capability fixtures**

在 `permission-service.test.ts` 顶部现有 fixture 后加入：

```ts
const mcpCapability: PermissionToolCapability = {
  destructive: false,
  needsApproval: true,
  permission: {
    denyPriority: "beforeAsk",
    needsApproval: true,
    permission: "mcp",
    reason: "MCP tool executes through an external server",
    riskLevel: "medium",
    sideEffectScope: "network",
  },
  readOnly: false,
  riskLevel: "medium",
  sideEffectScope: "network",
};

const destructiveMcpCapability: PermissionToolCapability = {
  ...mcpCapability,
  destructive: true,
  permission: {
    ...mcpCapability.permission!,
    riskLevel: "high",
  },
  riskLevel: "high",
};

const fakeMcpNameCapability: PermissionToolCapability = {
  destructive: false,
  needsApproval: true,
  readOnly: false,
  riskLevel: "medium",
  sideEffectScope: "network",
};
```

- [ ] **Step 2: 写 MCP 非 readonly 但非 destructive 可通过的失败测试**

在 `describe("PermissionService mode policy", () => {` 内、Plan mode 相关测试附近加入：

```ts
  it("allows non-destructive MCP tools in plan mode without requiring readOnly metadata", () => {
    const service = new PermissionService();

    const decision = service.checkPermission(
      {
        input: { query: "current simulator state" },
        mode: "plan",
        riskLevel: "medium",
        toolName: "mcp__ios_simulator__status",
      },
      mcpCapability,
    );

    expect(decision).toMatchObject({
      allowed: true,
      decision: "allow",
      ruleId: "mode.plan.mcp",
      sideEffectScope: "network",
    });
  });
```

- [ ] **Step 3: 写 destructive MCP 仍拒绝的失败测试**

同一 describe 内继续加入：

```ts
  it("denies destructive MCP tools in plan mode", () => {
    const service = new PermissionService();

    const decision = service.checkPermission(
      {
        input: { target: "device" },
        mode: "plan",
        riskLevel: "high",
        toolName: "mcp__device__reset",
      },
      destructiveMcpCapability,
    );

    expect(decision).toMatchObject({
      allowed: false,
      decision: "deny",
      ruleId: "mode.plan.nonReadOnly",
    });
  });
```

- [ ] **Step 4: 写伪 MCP 名称不通过的失败测试**

同一 describe 内继续加入：

```ts
  it("does not treat an mcp-prefixed tool name as MCP without the mcp permission declaration", () => {
    const service = new PermissionService();

    const decision = service.checkPermission(
      {
        input: {},
        mode: "plan",
        riskLevel: "medium",
        toolName: "mcp__fake__write",
      },
      fakeMcpNameCapability,
    );

    expect(decision).toMatchObject({
      allowed: false,
      decision: "deny",
      ruleId: "mode.plan.nonReadOnly",
    });
  });
```

- [ ] **Step 5: 写 project deny / ask 优先于 MCP 例外的失败测试**

同一 describe 内继续加入：

```ts
  it("lets project deny rules override the plan-mode MCP exception", () => {
    const service = new PermissionService();

    const decision = service.checkPermission(
      {
        input: { query: "secret" },
        mode: "plan",
        riskLevel: "medium",
        toolName: "mcp__external__search",
      },
      mcpCapability,
      {
        version: 1,
        deny: [{ toolName: "mcp__external__search" }],
      },
    );

    expect(decision).toMatchObject({
      allowed: false,
      decision: "deny",
      ruleId: "rule.project.deny",
    });
  });

  it("lets project ask rules override the plan-mode MCP exception", () => {
    const service = new PermissionService();

    const decision = service.checkPermission(
      {
        input: { query: "maybe external" },
        mode: "plan",
        riskLevel: "medium",
        toolName: "mcp__external__search",
      },
      mcpCapability,
      {
        version: 1,
        ask: [{ toolName: "mcp__external__search" }],
      },
    );

    expect(decision).toMatchObject({
      allowed: false,
      decision: "ask",
      ruleId: "rule.project.ask",
    });
  });
```

- [ ] **Step 6: 运行测试确认失败**

Run:

```sh
pnpm --filter @zcode/core exec vitest run tests/permission-service.test.ts
```

Expected before implementation:

```text
FAIL  tests/permission-service.test.ts
...
expected ... ruleId ... "mode.plan.mcp"
```

---

## Phase 3: 实现 Plan mode MCP 专用分支

### Task 3: 在 PermissionService 中增加 MCP 例外

**Files:**

- Modify: `apps/zcode-cli/packages/core/src/permission/service.ts`

**Interfaces:**

- Consumes:
  - `ResolvedPermissionCapability.permissionName?: string`
  - `ResolvedPermissionCapability.destructive: boolean`
- Produces:
  - `mode.plan.mcp` allow rule
  - 集中的 MCP 判断 helper

- [ ] **Step 1: 修改 `checkPlanMode()`**

把当前 `checkPlanMode()` 替换为：

```ts
  private checkPlanMode(
    context: PermissionContext,
    capability: ResolvedPermissionCapability,
  ): PermissionDecisionResult {
    if (capability.readOnly && !capability.destructive) {
      return this.allow(
        context,
        capability,
        "mode.plan.readOnly",
        "Plan mode allows read-only tool execution",
      );
    }

    if (this.isMcpToolCapability(capability) && !capability.destructive) {
      return this.allow(
        context,
        capability,
        "mode.plan.mcp",
        "Plan mode allows non-destructive MCP tool execution",
      );
    }

    return this.deny(
      context,
      capability,
      "mode.plan.nonReadOnly",
      "Plan mode only allows read-only, non-destructive tools",
    );
  }
```

- [ ] **Step 2: 增加 MCP 身份 helper**

在 `checkPlanMode()` 附近加入私有方法：

```ts
  private isMcpToolCapability(capability: ResolvedPermissionCapability): boolean {
    return capability.permissionName === "mcp";
  }
```

- [ ] **Step 3: 保持 `resolveCapability()` 不变**

确认 `resolveCapability()` 仍保留：

```ts
      permissionName: toolCapability?.permission?.permission,
```

不要新增 `toolName.startsWith("mcp__")` 判断。

- [ ] **Step 4: 运行 PermissionService 测试确认通过**

Run:

```sh
pnpm --filter @zcode/core exec vitest run tests/permission-service.test.ts
```

Expected:

```text
Test Files  1 passed (1)
```

---

## Phase 4: 补 MCP bridge 与 runtime 级回归

### Task 4: 覆盖 MCP descriptor 到 destructive metadata 的映射

**Files:**

- Modify: `apps/zcode-cli/packages/core/tests/mcp-tool-bridge.test.ts`

**Interfaces:**

- Consumes: `registerMcpTools(registry, mcpPort, descriptors)`
- Produces: 测试证明 `destructiveHint: true` 会变成 `entry.metadata.destructive === true` 和 high risk。

- [ ] **Step 1: 增加 destructiveHint 映射测试**

在 `describe("MCP tool bridge", () => {` 内加入：

```ts
  it("maps destructive MCP annotations into tool metadata", () => {
    const registry = createToolRegistry();
    const mcpPort = createMockMcpPort();

    registerMcpTools(registry, mcpPort, [
      {
        serverName: "device",
        toolName: "reset",
        description: "Reset a device",
        inputSchema: { type: "object" },
        annotations: {
          destructiveHint: true,
        },
      },
    ]);

    const entry = registry.get("mcp__device__reset");

    expect(entry?.metadata).toMatchObject({
      destructive: true,
      readOnly: false,
      riskLevel: "high",
      sideEffectScope: "network",
    });
    expect(entry?.permission).toMatchObject({
      permission: "mcp",
      riskLevel: "high",
      sideEffectScope: "network",
    });
  });
```

- [ ] **Step 2: 运行 MCP bridge 测试**

Run:

```sh
pnpm --filter @zcode/core exec vitest run tests/mcp-tool-bridge.test.ts
```

Expected:

```text
Test Files  1 passed (1)
```

### Task 5: 覆盖 Plan mode 下 MCP tool 真实执行

**Files:**

- Modify: `apps/zcode-cli/packages/core/tests/mcp-runtime.test.ts`

**Interfaces:**

- Consumes:
  - `AgentRuntime`
  - `createMockMcpPort(...)`
  - runtime MCP startup registration
- Produces: 真实 runtime 回归：Plan mode 下没有 `readOnlyHint` 的 MCP tool 不被 `mode.plan.nonReadOnly` 拦截。

- [ ] **Step 1: 在 import 中加入 `type PermissionBrokerPort`**

把当前 imports 调整为包含：

```ts
  type PermissionBrokerPort,
```

即：

```ts
import {
  SessionEventType,
  createSessionId,
  type McpConnectionSnapshot,
  type McpPort,
  type PermissionBrokerPort,
  type SessionEventStorePort,
  type SessionId,
} from "@zcode/contracts";
```

- [ ] **Step 2: 增加 Plan mode MCP 执行测试**

在 `describe("AgentRuntime MCP integration", () => {` 内加入：

```ts
  it("executes non-destructive MCP tools in plan mode without readOnlyHint", async () => {
    const sessionId = createSessionId("runtime-mcp-plan-mode");
    const eventStore = createTestSessionEventStore();
    let modelCallCount = 0;
    let mcpCallCount = 0;
    let permissionRequestCount = 0;

    const permissionBroker: PermissionBrokerPort = {
      async requestPermission() {
        permissionRequestCount++;
        return {
          decision: "deny",
          reason: "permission broker should not be called for plan-mode MCP allow",
        };
      },
    };

    const mcpPort = createMockMcpPort({
      connectConfiguredServers: async () => ({
        statuses: {
          local: {
            status: "connected",
            transport: "stdio",
            toolCount: 1,
            updatedAt: "now",
          },
        },
        tools: [
          {
            serverName: "local",
            toolName: "lookup",
            inputSchema: {
              type: "object",
              properties: {
                query: { type: "string" },
              },
            },
          },
        ],
      }),
      callTool: async (request) => {
        mcpCallCount++;
        return {
          content: [{ type: "text", text: `lookup:${request.arguments?.query}` }],
        };
      },
    });

    const runtime = new AgentRuntime(
      sessionId,
      {
        mode: "plan",
        mcp: {
          enabled: true,
          servers: {
            local: {
              type: "stdio",
              command: "node",
              args: ["server.js"],
            },
          },
        },
      },
      {
        eventStore,
        mcpPort,
        permissionBroker,
        modelAdapter: {
          async generateText(request: any) {
            modelCallCount++;
            if (modelCallCount === 1) {
              expect(request.tools.map((tool: { name: string }) => tool.name)).toContain(
                "mcp__local__lookup",
              );
              return {
                finishReason: "tool-calls",
                model: request.model,
                providerMetadata: undefined,
                text: "I will look this up.",
                toolCalls: [
                  {
                    id: "mcp-lookup",
                    name: "mcp__local__lookup",
                    input: { query: "plan context" },
                  },
                ],
                usage: {
                  inputTokens: 1,
                  outputTokens: 1,
                  totalTokens: 2,
                },
              };
            }

            expect(request.messages.some((message: any) => {
              return message.role === "tool" && String(message.content).includes("lookup:plan context");
            })).toBe(true);

            return {
              finishReason: "stop",
              model: request.model,
              providerMetadata: undefined,
              text: "done",
              usage: {
                inputTokens: 1,
                outputTokens: 1,
                totalTokens: 2,
              },
            };
          },
        } as never,
      },
    );

    const result = await runtime.executeTurn("use mcp while planning");

    expect(result.response).toBe("done");
    expect(mcpCallCount).toBe(1);
    expect(permissionRequestCount).toBe(0);
  });
```

- [ ] **Step 3: 增加 Plan mode destructive MCP 不执行测试**

同一 describe 内加入：

```ts
  it("denies destructive MCP tools in plan mode before calling the MCP server", async () => {
    const sessionId = createSessionId("runtime-mcp-plan-destructive");
    const eventStore = createTestSessionEventStore();
    let modelCallCount = 0;
    let mcpCallCount = 0;
    let secondRequest: any;

    const mcpPort = createMockMcpPort({
      connectConfiguredServers: async () => ({
        statuses: {
          device: {
            status: "connected",
            transport: "stdio",
            toolCount: 1,
            updatedAt: "now",
          },
        },
        tools: [
          {
            serverName: "device",
            toolName: "reset",
            inputSchema: {
              type: "object",
              properties: {},
            },
            annotations: {
              destructiveHint: true,
            },
          },
        ],
      }),
      callTool: async () => {
        mcpCallCount++;
        return { content: [{ type: "text", text: "should-not-run" }] };
      },
    });

    const runtime = new AgentRuntime(
      sessionId,
      {
        mode: "plan",
        mcp: {
          enabled: true,
          servers: {
            device: {
              type: "stdio",
              command: "node",
              args: ["server.js"],
            },
          },
        },
      },
      {
        eventStore,
        mcpPort,
        modelAdapter: {
          async generateText(request: any) {
            modelCallCount++;
            if (modelCallCount === 1) {
              return {
                finishReason: "tool-calls",
                model: request.model,
                providerMetadata: undefined,
                text: "I will reset the device.",
                toolCalls: [
                  {
                    id: "mcp-reset",
                    name: "mcp__device__reset",
                    input: {},
                  },
                ],
                usage: {
                  inputTokens: 1,
                  outputTokens: 1,
                  totalTokens: 2,
                },
              };
            }

            secondRequest = request;
            return {
              finishReason: "stop",
              model: request.model,
              providerMetadata: undefined,
              text: "done",
              usage: {
                inputTokens: 1,
                outputTokens: 1,
                totalTokens: 2,
              },
            };
          },
        } as never,
      },
    );

    const result = await runtime.executeTurn("do not mutate while planning");
    const toolMessage = secondRequest.messages.find((message: any) => message.role === "tool");

    expect(result.response).toBe("done");
    expect(mcpCallCount).toBe(0);
    expect(toolMessage?.content).toContain("Plan mode only allows read-only, non-destructive tools");
  });
```

- [ ] **Step 4: 运行 MCP runtime 测试**

Run:

```sh
pnpm --filter @zcode/core exec vitest run tests/mcp-runtime.test.ts
```

Expected:

```text
Test Files  1 passed (1)
```

---

## Phase 5: 回归验证与审查

### Task 6: 聚合验证

**Files:**

- Test only, no source changes expected.

**Interfaces:**

- Consumes: Phase 1-4 的全部改动。
- Produces: 可交付验证结论。

- [ ] **Step 1: 跑 permission + MCP focused tests**

Run:

```sh
pnpm --filter @zcode/core exec vitest run \
  tests/permission-service.test.ts \
  tests/mcp-tool-bridge.test.ts \
  tests/mcp-runtime.test.ts
```

Expected:

```text
Test Files  3 passed (3)
```

- [ ] **Step 2: 跑相关 runtime tool loop 回归**

Run:

```sh
pnpm --filter @zcode/core exec vitest run tests/runtime-tool-loop.test.ts -t "continues later tool calls after a blocking permission denial"
```

Expected:

```text
Test Files  1 passed (1)
```

Purpose:

- 确认 Plan mode 下非 MCP 写工具仍会被拦截。
- 确认拦截后后续只读工具仍能继续执行。

- [ ] **Step 3: 跑 core typecheck**

Run:

```sh
pnpm --filter @zcode/core typecheck
```

Expected:

```text
No TypeScript errors from @zcode/core
```

- [ ] **Step 4: 跑根 lint**

Run:

```sh
pnpm lint
```

Expected:

```text
Lint passes, or only reports pre-existing unrelated warnings/errors.
```

If root lint reports unrelated existing failures, record exact file and message in final report. Do not fix unrelated files in this task.

- [ ] **Step 5: 跑根 typecheck**

Run:

```sh
pnpm typecheck
```

Expected:

```text
Typecheck passes, or only reports pre-existing unrelated failures.
```

If root typecheck still fails on known unrelated desktop e2e Istanbul declarations, record the exact failure and keep this task scoped.

---

## Phase 6: 最终人工审查清单

### Task 7: 变更审查与交付说明

**Files:**

- Review:
  - `docs/plan-mode-approval-boundary.md`
  - `apps/zcode-cli/packages/core/src/permission/service.ts`
  - `apps/zcode-cli/packages/core/tests/permission-service.test.ts`
  - `apps/zcode-cli/packages/core/tests/mcp-tool-bridge.test.ts`
  - `apps/zcode-cli/packages/core/tests/mcp-runtime.test.ts`

**Interfaces:**

- Consumes: 全部实现与验证结果。
- Produces: 用户可 review 的最终说明。

- [ ] **Step 1: 检查没有误改 UI/protocol/registry**

Run:

```sh
git diff --name-only
```

Expected files only:

```text
docs/plan-mode-approval-boundary.md
apps/zcode-cli/packages/core/src/permission/service.ts
apps/zcode-cli/packages/core/tests/permission-service.test.ts
apps/zcode-cli/packages/core/tests/mcp-tool-bridge.test.ts
apps/zcode-cli/packages/core/tests/mcp-runtime.test.ts
docs/superpowers/plans/2026-07-07-plan-mode-mcp-permission.md
```

- [ ] **Step 2: 检查没有 toolName 前缀主判断**

Run:

```sh
rg -n "startsWith\\(\\\"mcp__\\\"\\)|mode\\.plan\\.mcp|permissionName === \\\"mcp\\\"" apps/zcode-cli/packages/core/src/permission apps/zcode-cli/packages/core/tests
```

Expected:

- `permissionName === "mcp"` 只出现在 helper 或测试断言相关语义里。
- `mode.plan.mcp` 出现在实现和测试中。
- 不新增以 `startsWith("mcp__")` 作为 permission 主判断的代码。

- [ ] **Step 3: 检查 destructive 语义没有被覆盖**

Run:

```sh
rg -n "destructive MCP|destructiveHint|mode.plan.nonReadOnly|mode.plan.mcp" apps/zcode-cli/packages/core/tests docs/plan-mode-approval-boundary.md
```

Expected:

- 文档包含 destructive MCP 仍拒绝。
- `permission-service.test.ts` 包含 destructive MCP 拒绝。
- `mcp-runtime.test.ts` 包含 destructive MCP 不调用 server。

- [ ] **Step 4: 准备最终说明**

最终说明必须包含：

- 本次实际改动文件。
- Plan mode MCP 新语义。
- 验证命令和结果。
- 是否存在未能完整验证的命令。
- 未提交 commit，等待用户明确要求。

---

## Commit Plan

仅当用户明确说“帮我提交吧”时提交。

建议 commit message:

```text
fix(zcode-cli): allow non-destructive mcp tools in plan mode
```

提交前必须重新运行：

```sh
pnpm --filter @zcode/core exec vitest run \
  tests/permission-service.test.ts \
  tests/mcp-tool-bridge.test.ts \
  tests/mcp-runtime.test.ts
pnpm --filter @zcode/core typecheck
pnpm lint
```

提交命令：

```sh
git add \
  docs/plan-mode-approval-boundary.md \
  apps/zcode-cli/packages/core/src/permission/service.ts \
  apps/zcode-cli/packages/core/tests/permission-service.test.ts \
  apps/zcode-cli/packages/core/tests/mcp-tool-bridge.test.ts \
  apps/zcode-cli/packages/core/tests/mcp-runtime.test.ts \
  docs/superpowers/plans/2026-07-07-plan-mode-mcp-permission.md
git commit -m "fix(zcode-cli): allow non-destructive mcp tools in plan mode"
```

---

## Self-Review

- Spec coverage: Phase 1 写入 Plan mode MCP 例外 spec；Phase 2-5 覆盖 permission、MCP bridge、runtime 和验证。
- Placeholder scan: 无 TBD / TODO / implement later。
- Type consistency: 使用现有 `PermissionToolCapability`、`ResolvedPermissionCapability.permissionName`、`PermissionService.checkPermission()`、`registerMcpTools()`、`AgentRuntime`。
- Scope check: 不修改 UI、protocol、MCP registry 或 model-visible contract。
- Risk note: `destructiveHint` 来自 MCP server annotation，当前实现只能识别显式 `destructiveHint: true`；缺失 annotation 的 MCP 会按非 destructive 处理，这是本计划明确接受的产品边界。
