import { describe, expect, it } from "vitest";
import { createSessionId, SessionEventType } from "@zcode/contracts";
import type { PermissionDecisionResult } from "../src/permission/service.js";
import { createInMemoryHookRunner } from "../src/hooks/index.js";
import { resolveProjectMemoryRoot } from "../src/memory/project-root.js";
import { createTestAgentRuntime } from "./test-agent-runtime.js";
import { applyMemoryFilePermission } from "../src/tool/executor/memory-file-permission.js";
import { createTestSessionEventStore } from "./test-event-store.js";
import { MemoryFileSystem } from "./memory-test-utils.js";
import { createTestModelFactory } from "./test-runtime-model.js";

const MEMORY_ROOT = "/storage/memories/projects/project-0123456789abcdef/memory";

describe("project Memory foreground permission", () => {
  it("allows only contained lowercase Markdown Write/Edit after generic policy", () => {
    expect(apply({ file_path: `${MEMORY_ROOT}/user-preference.md` }).decision).toBe("allow");
    expect(
      apply({ file_path: `${MEMORY_ROOT}/nested/project-context.md` }, { toolName: "Edit" })
        .decision,
    ).toBe("allow");

    expect(apply({ file_path: `${MEMORY_ROOT}/user-preference.MD` })).toMatchObject({
      decision: "ask",
      ruleId: "mode.build.sideEffect",
    });
    expect(apply({ file_path: `${MEMORY_ROOT}-other/user-preference.md` })).toMatchObject({
      decision: "ask",
      ruleId: "mode.build.sideEffect",
    });
  });

  it.each([
    ".git",
    "hooks",
    ".husky",
    ".githooks",
    "node_modules",
    ".vscode",
    ".idea",
    "head",
    "config",
    "objects",
    "refs",
    ".claude",
    "skills",
    "commands",
    "agents",
    ".cargo",
    ".devcontainer",
    ".yarn",
    ".mvn",
  ])("does not auto-allow the sensitive %s path segment", (segment) => {
    expect(apply({ file_path: `${MEMORY_ROOT}/${segment}/fact.md` })).toMatchObject({
      decision: "ask",
      ruleId: "mode.build.sideEffect",
    });
  });

  it("normalizes only the baseline-sensitive segment disguises", () => {
    for (const segment of [".GIT", ".git.", ".git ", ".g\u200cit", ".git:stream"]) {
      expect(apply({ file_path: `${MEMORY_ROOT}/${segment}/fact.md` }).decision).toBe("ask");
    }
    expect(apply({ file_path: `${MEMORY_ROOT}/.git-notes/fact.md` }).decision).toBe("allow");
  });

  it("preserves explicit ask/deny while overriding only generic and plan policy", () => {
    expect(
      apply({ file_path: `${MEMORY_ROOT}/fact.md` }, { decision: askDecision("rule.project.ask") }),
    ).toMatchObject({ decision: "ask", ruleId: "rule.project.ask" });
    expect(
      apply(
        { file_path: `${MEMORY_ROOT}/fact.md` },
        { decision: denyDecision("rule.project.deny") },
      ),
    ).toMatchObject({ decision: "deny", ruleId: "rule.project.deny" });
    expect(
      apply(
        { file_path: `${MEMORY_ROOT}/fact.md` },
        { decision: denyDecision("mode.plan.nonReadOnly") },
      ),
    ).toMatchObject({ decision: "allow", ruleId: "memory.file.markdown" });
  });

  it("applies the same file permission to a custom user root outside the workspace", () => {
    const userRoot = "/storage/agent-memory/reviewer";
    expect(apply({ file_path: `${userRoot}/preference.md` }, { rootDir: userRoot })).toMatchObject({
      decision: "allow",
      ruleId: "memory.file.markdown",
    });
  });

  it("applies the permission at the real Write execution boundary", async () => {
    const fileSystemPort = new MemoryFileSystem({});
    const workspaceIdentity = "project-boundary";
    const sessionId = createSessionId("memory-permission-write-boundary");
    const target = `${resolveProjectMemoryRoot({
      cliStorageRoot: "/storage",
      workspaceIdentity,
      workspacePath: "/workspace",
    })}/runtime-boundary.md`;
    const requestedContent = [
      "---",
      "name: runtime-boundary",
      "description: Durable fact written through the runtime boundary",
      "metadata:",
      "  type: project",
      "---",
      "",
      "Durable fact.",
    ].join("\n");
    let modelCallCount = 0;
    let secondRequest = "";
    const runtime = createTestAgentRuntime(
      sessionId,
      {
        memory: {
          cliStorageRoot: "/storage",
          enabled: true,
          use: true,
          workspaceIdentity,
        },
        workingDirectory: "/workspace",
      },
      {
        eventStore: createTestSessionEventStore(),
        fileSystemPort,
        permissionBroker: {
          requestPermission() {
            throw new Error("Memory boundary unexpectedly requested permission");
          },
        },
        modelFactory: createTestModelFactory({
          async generateText(request) {
            modelCallCount++;
            if (modelCallCount === 1) {
              return {
                finishReason: "tool-calls",
                text: "",
                toolCalls: [
                  {
                    id: "write-memory",
                    name: "Write",
                    input: { content: requestedContent, file_path: target },
                  },
                ],
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              };
            }
            secondRequest = JSON.stringify(request.messages);
            return {
              finishReason: "stop",
              text: "done",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            };
          },
        } as never),
      },
    );

    await runtime.executeTurn("save the durable fact");

    expect(fileSystemPort.files[target]).toBe(
      requestedContent.replace(
        "  type: project",
        `  node_type: memory\n  type: project\n  originSessionId: ${sessionId}`,
      ),
    );
    expect(secondRequest).not.toContain("requires approval");
  });

  it.each([
    {
      brokerCalls: 0,
      caseName: "allows a safe Memory target",
      expectedContent: "hook-updated content",
      sessionName: "memory-permission-hook-safe-write",
      targetSuffix: "hook-updated.md",
    },
    {
      brokerCalls: 1,
      caseName: "reprompts for a sensitive Memory target",
      expectedContent: "hook-updated content",
      sessionName: "memory-permission-hook-sensitive-write",
      targetSuffix: "skills/hook-updated.md",
    },
  ])(
    "rechecks modified PermissionRequest input and $caseName",
    async ({ brokerCalls, expectedContent, sessionName, targetSuffix }) => {
      const sessionId = createSessionId(sessionName);
      const eventStore = createTestSessionEventStore();
      const fileSystemPort = new MemoryFileSystem({});
      const target = `${resolveProjectMemoryRoot({
        cliStorageRoot: "/storage",
        workspacePath: "/workspace",
      })}/${targetSuffix}`;
      let brokerCallCount = 0;
      let brokerAnswerCount = 0;
      let hookCallCount = 0;
      let modelCallCount = 0;
      const hookRunner = createInMemoryHookRunner({
        hooks: [
          {
            event: "PermissionRequest",
            matcher: "Write",
            callback: async (input) => {
              hookCallCount += 1;
              return {
                hookSpecificOutput: {
                  decision: {
                    behavior: "allow",
                    updatedInput: { content: "hook-updated content", file_path: target },
                  },
                  hookEventName: input.hookEventName,
                },
              };
            },
          },
        ],
      });
      const runtime = createTestAgentRuntime(
        sessionId,
        {
          memory: {
            cliStorageRoot: "/storage",
            enabled: true,
            use: true,
          },
          workingDirectory: "/workspace",
        },
        {
          eventStore,
          fileSystemPort,
          hookRunner,
          permissionBroker: {
            requestPermission(_request, requestOptions) {
              brokerCallCount += 1;
              // 契约更新（docs/design/v2/permission-responder-race.md）：初始 ask 总会
              // 并发武装 broker（第 1 次调用），hook 决定胜出后它被 abort、不产生应答；
              // 只有敏感目标 recheck 的重新提问（第 2 次调用）才真正消费用户应答。
              if (brokerCallCount === 1) {
                return new Promise((_, reject) => {
                  requestOptions?.signal?.addEventListener(
                    "abort",
                    () => reject(new Error("aborted by race")),
                    { once: true },
                  );
                });
              }
              brokerAnswerCount += 1;
              return Promise.resolve({ decision: "allow" as const });
            },
          },
          modelFactory: createTestModelFactory({
            async generateText(request) {
              modelCallCount += 1;
              if (modelCallCount === 1) {
                return {
                  finishReason: "tool-calls",
                  text: "",
                  toolCalls: [
                    {
                      id: "write-hook-updated-memory",
                      name: "Write",
                      input: { content: "ordinary write", file_path: "/workspace/ordinary.md" },
                    },
                  ],
                  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
                };
              }
              return {
                finishReason: "stop",
                text: "done",
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              };
            },
          } as never),
        },
      );

      await runtime.executeTurn("write an ordinary project note");

      const events = await eventStore.getEvents(sessionId);
      expect(
        events.filter((event) => event.type === SessionEventType.PermissionRequested),
      ).toHaveLength(1 + brokerCalls);
      expect(hookCallCount).toBe(1);
      expect(brokerAnswerCount).toBe(brokerCalls);
      expect(fileSystemPort.files[target]).toBe(expectedContent);
    },
  );
});

describe("project Memory permission vs alwaysAsk", () => {
  it("keeps an alwaysAsk decision even for a contained Markdown memory file", () => {
    // memory 放行是"降级到 allow"的分支；alwaysAsk 的确认不能被它抹掉。
    // 今天 Write/Edit 都没声明 alwaysAsk，所以这是防回归而不是修现网 bug。
    expect(
      apply(
        { file_path: `${MEMORY_ROOT}/user-preference.md` },
        { decision: { ...askDecision("tool.alwaysAsk"), alwaysAsk: true } },
      ),
    ).toMatchObject({ decision: "ask", ruleId: "tool.alwaysAsk" });
  });
});

function apply(
  executionInput: unknown,
  options: {
    decision?: PermissionDecisionResult;
    rootDir?: string;
    toolName?: string;
  } = {},
): PermissionDecisionResult {
  return applyMemoryFilePermission({
    decision: options.decision ?? askDecision("mode.build.sideEffect"),
    executionInput,
    memoryRoot: options.rootDir ?? MEMORY_ROOT,
    toolName: options.toolName ?? "Write",
    workingDirectory: "/workspace",
    workspaceRoot: "/workspace",
  });
}

function allowDecision(ruleId: string): PermissionDecisionResult {
  return decision("allow", ruleId);
}

function askDecision(ruleId: string): PermissionDecisionResult {
  return decision("ask", ruleId);
}

function denyDecision(ruleId: string): PermissionDecisionResult {
  return decision("deny", ruleId);
}

function decision(
  value: PermissionDecisionResult["decision"],
  ruleId: string,
): PermissionDecisionResult {
  return {
    allowed: value === "allow",
    decision: value,
    escalated: value === "ask",
    mode: "build",
    riskLevel: "medium",
    ruleId,
    sideEffectScope: "workspace",
  };
}
