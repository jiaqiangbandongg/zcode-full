import { describe, expect, it } from "vitest";
import { createSessionId } from "@zcode/contracts";
import { createTestAgentRuntime } from "./test-agent-runtime.js";
import { createTestSessionEventStore } from "./test-event-store.js";
import { createTestModelFactory } from "./test-runtime-model.js";

describe("main agent tool pool", () => {
  it("does not expose subagent tools when subagents are disabled", () => {
    const runtime = createTestAgentRuntime(
      createSessionId("runtime-without-model-factory"),
      {
        mode: "build",
        subagents: { enabled: false },
        workingDirectory: "/workspace/project",
      },
      { eventStore: createTestSessionEventStore() },
    );

    expect(runtime.getToolRegistry().has("Agent")).toBe(false);
    expect(runtime.getToolRegistry().has("Task")).toBe(false);
  });

  it("registers the embedded-search Explore tool pool with read-only behavior enforced by prompt", () => {
    const defaultRuntime = createTestAgentRuntime(
      createSessionId("runtime-explore-toolset-default"),
      {
        toolset: "explore",
      },
      {
        eventStore: createTestSessionEventStore(),
      },
    );
    const runtime = createTestAgentRuntime(
      createSessionId("runtime-explore-toolset"),
      {
        toolset: "explore",
        toolAllowlist: ["Read", "Glob", "Bash", "Write"],
      },
      {
        eventStore: createTestSessionEventStore(),
      },
    );

    // 无 skillPort 故不含 Skill；WebSearch 是普通 client-side wrapper。
    // 顺序按 builtInTools 注册顺序。
    expect(defaultRuntime.getToolRegistry().list()).toEqual([
      "Read",
      "Bash",
      "WebFetch",
      "WebSearch",
      "TodoWrite",
    ]);
    // allowlist ["Read","Glob","Bash","Write"] 与 Explore 白名单求交后，
    // 默认 embedded branch 隐藏 Glob/Grep，Write 被 Explore 白名单排除。
    expect(runtime.getToolRegistry().list()).toEqual(["Read", "Bash"]);
  });

  it("keeps Glob/Grep hidden when main toolAllowlist includes them", () => {
    const runtime = createTestAgentRuntime(
      createSessionId("runtime-main-allowlist-search-tools"),
      {
        mode: "build",
        toolAllowlist: ["Read", "Glob", "Grep", "Bash"],
        workingDirectory: "/workspace/project",
      },
      {
        eventStore: createTestSessionEventStore(),
      },
    );

    expect(runtime.getToolRegistry().list()).toEqual(["Read", "Bash"]);
  });

  it("does not expose node_repl just because a browser control port exists", () => {
    const runtimeWithoutFeature = createTestAgentRuntime(
      createSessionId("runtime-browser-port-without-feature"),
      {
        mode: "build",
        workingDirectory: "/workspace/project",
      },
      {
        browserControlPort: {
          list: async () => [],
          execute: async () => ({ ok: true, elapsedMs: 0 }),
        },
        eventStore: createTestSessionEventStore(),
      },
    );
    const runtimeWithFeature = createTestAgentRuntime(
      createSessionId("runtime-browser-port-with-feature"),
      {
        mode: "build",
        runtimeFeatures: { browserUse: true, nodeRepl: true },
        workingDirectory: "/workspace/project",
      },
      {
        browserControlPort: {
          list: async () => [],
          execute: async () => ({ ok: true, elapsedMs: 0 }),
        },
        eventStore: createTestSessionEventStore(),
      },
    );

    expect(runtimeWithoutFeature.getToolRegistry().has("js")).toBe(false);
    expect(runtimeWithFeature.getToolRegistry().has("js")).toBe(true);
  });

  it("removes disallowed built-in tools from the main runtime registry", () => {
    const runtime = createTestAgentRuntime(
      createSessionId("runtime-main-disallowed-tools"),
      {
        mode: "build",
        toolDisallowlist: ["Bash(git *)", "web_search"],
        workingDirectory: "/workspace/project",
      },
      {
        eventStore: createTestSessionEventStore(),
      },
    );

    expect(runtime.getToolRegistry().has("Bash")).toBe(false);
    expect(runtime.getToolRegistry().has("WebSearch")).toBe(false);
    expect(runtime.getToolRegistry().has("Read")).toBe(true);
  });

  it("keeps disallowed built-in tools out of provider-visible requests", async () => {
    const requests: any[] = [];
    const runtime = createTestAgentRuntime(
      createSessionId("runtime-main-disallowed-provider-tools"),
      {
        mode: "build",
        toolAllowlist: ["Read", "Edit", "Bash", "WebSearch"],
        toolDisallowlist: ["Bash(git *)", "WebSearch"],
        workingDirectory: "/workspace/project",
      },
      {
        eventStore: createTestSessionEventStore(),
        modelFactory: createTestModelFactory({
          properties: { supportsNativeWebSearch: true },
          async generateText(request: any) {
            requests.push(request);
            return {
              finishReason: "stop",
              providerMetadata: undefined,
              text: "done",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            };
          },
        } as never),
      },
    );

    await runtime.executeTurn("Use selected tools");

    expect(requests[0].tools.map((tool: any) => tool.name)).toEqual(["Edit", "Read"]);
  });

  it("hides automation mutation tools only for an automation turn and restores them next turn", async () => {
    const requests: any[] = [];
    const runtime = createTestAgentRuntime(
      createSessionId("runtime-main-turn-disallowed-provider-tools"),
      {
        mode: "build",
        toolAllowlist: ["CronCreate", "CronList", "CronUpdate", "CronDelete"],
        workingDirectory: "/workspace/project",
      },
      {
        automationPort: {
          create: async () => {
            throw new Error("not called");
          },
          update: async () => {
            throw new Error("not called");
          },
          delete: async () => undefined,
          list: async () => [],
        },
        eventStore: createTestSessionEventStore(),
        modelFactory: createTestModelFactory({
          properties: { supportsNativeWebSearch: true },
          async generateText(request: any) {
            requests.push(request);
            return {
              finishReason: "stop",
              providerMetadata: undefined,
              text: "done",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            };
          },
        } as never),
      },
    );

    await runtime.executeTurn("Automation turn", undefined, {
      toolDisallowlist: ["CronCreate", "CronUpdate", "CronDelete"],
    });
    await runtime.executeTurn("Normal user turn");

    const automationTurnTools = requests[0].tools.map((tool: any) => tool.name);
    const normalTurnTools = requests[1].tools.map((tool: any) => tool.name);
    expect(automationTurnTools).toEqual(["CronList"]);
    expect(normalTurnTools).toEqual(
      expect.arrayContaining(["CronCreate", "CronList", "CronUpdate", "CronDelete"]),
    );
  });

  it("hides automation mutation tools when automation queryId reaches provider", async () => {
    const requests: any[] = [];
    const runtime = createTestAgentRuntime(
      createSessionId("runtime-main-automation-query-provider-tools"),
      {
        mode: "build",
        toolAllowlist: ["CronCreate", "CronList", "CronUpdate", "CronDelete"],
        workingDirectory: "/workspace/project",
      },
      {
        automationPort: {
          create: async () => {
            throw new Error("not called");
          },
          update: async () => {
            throw new Error("not called");
          },
          delete: async () => undefined,
          list: async () => [],
        },
        eventStore: createTestSessionEventStore(),
        modelFactory: createTestModelFactory({
          properties: { supportsNativeWebSearch: true },
          async generateText(request: any) {
            requests.push(request);
            return {
              finishReason: "stop",
              providerMetadata: undefined,
              text: "done",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            };
          },
        } as never),
      },
    );

    await runtime.executeTurn("Automation turn", undefined, {
      queryId: "automation-parent:1784199000000" as never,
    });

    const automationTurnTools = requests[0].tools.map((tool: any) => tool.name);
    expect(automationTurnTools).toEqual(["CronList"]);
  });

  it("keeps provider-visible order for allowlisted main tool requests", async () => {
    const requests: any[] = [];
    const runtime = createTestAgentRuntime(
      createSessionId("runtime-main-allowlist-provider-order"),
      {
        mode: "build",
        toolAllowlist: ["Read", "Edit", "Bash"],
        workingDirectory: "/workspace/project",
      },
      {
        eventStore: createTestSessionEventStore(),
        modelFactory: createTestModelFactory({
          properties: { supportsNativeWebSearch: true },
          async generateText(request: any) {
            requests.push(request);
            return {
              finishReason: "stop",
              providerMetadata: undefined,
              text: "done",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            };
          },
        } as never),
      },
    );

    await runtime.executeTurn("Use selected tools");

    expect(requests[0].tools.map((tool: any) => tool.name)).toEqual(["Bash", "Edit", "Read"]);
  });

  it("orders provider-visible explore allowlists before appending local-only tools", async () => {
    const requests: any[] = [];
    const runtime = createTestAgentRuntime(
      createSessionId("runtime-explore-allowlist-provider-order"),
      {
        mode: "build",
        toolset: "explore",
        toolAllowlist: ["TodoWrite", "WebFetch", "Read", "Bash"],
        workingDirectory: "/workspace/project",
      },
      {
        eventStore: createTestSessionEventStore(),
        modelFactory: createTestModelFactory({
          properties: { supportsNativeWebSearch: true },
          async generateText(request: any) {
            requests.push(request);
            return {
              finishReason: "stop",
              providerMetadata: undefined,
              text: "done",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            };
          },
        } as never),
      },
    );

    await runtime.executeTurn("Use selected tools");

    expect(requests[0].tools.map((tool: any) => tool.name)).toEqual([
      "Bash",
      "Read",
      "TodoWrite",
      "WebFetch",
    ]);
  });

  it("keeps the provider-visible embedded branch when the session shell is CMD", () => {
    const runtime = createTestAgentRuntime(
      createSessionId("runtime-main-cmd-direct-search-tools"),
      {
        mode: "build",
        workingDirectory: "/workspace/project",
      },
      {
        eventStore: createTestSessionEventStore(),
      },
    );

    expect(runtime.getToolRegistry().has("Glob")).toBe(false);
    expect(runtime.getToolRegistry().has("Grep")).toBe(false);

    runtime.initializeSessionShellEnvironmentIfNeeded({
      dialect: "cmd",
      display: { name: "CMD" },
      id: "cmd",
      label: "CMD",
      path: "cmd.exe",
      source: "user-config",
    });

    const byName = new Map(runtime.getTools().map((tool) => [tool.name, tool]));

    expect(byName.has("Glob")).toBe(false);
    expect(byName.has("Grep")).toBe(false);
    expect(byName.get("Bash")?.description ?? "").toContain(
      "Avoid using this tool to run `cat`, `head`, `tail`, `sed`, `awk`, or `echo` commands",
    );
    expect(byName.get("EnterPlanMode")?.description ?? "").toContain(
      "using `find`/Glob, `grep`/Grep, and Read",
    );
  });

  it("does not let updateConfig overwrite the session shell snapshot", () => {
    const runtime = createTestAgentRuntime(
      createSessionId("runtime-main-shell-snapshot-immutable"),
      {
        bashShellSelection: {
          dialect: "cmd",
          display: { name: "CMD" },
          id: "cmd",
          label: "CMD",
          path: "cmd.exe",
          source: "user-config",
        },
        mode: "build",
        workingDirectory: "/workspace/project",
      },
      {
        eventStore: createTestSessionEventStore(),
      },
    );

    (runtime.updateConfig as (patch: unknown) => void)({
      bashShellSelection: {
        dialect: "git-bash",
        display: { name: "Git Bash" },
        id: "auto:git-bash",
        label: "Git Bash",
        path: "C:\\Program Files\\Git\\bin\\bash.exe",
        source: "auto-detected",
      },
    });

    const byName = new Map(runtime.getTools().map((tool) => [tool.name, tool]));

    expect(byName.has("Glob")).toBe(false);
    expect(byName.has("Grep")).toBe(false);
    expect(byName.get("Bash")?.description ?? "").toContain(
      "Avoid using this tool to run `cat`, `head`, `tail`, `sed`, `awk`, or `echo` commands",
    );
  });
});
