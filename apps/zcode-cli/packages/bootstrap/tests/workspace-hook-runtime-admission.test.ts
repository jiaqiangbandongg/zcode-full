import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createConfig } from "@zcode/adapters/config";
import {
  createDefaultFileWorkspaceHookTrustStore,
  createInMemorySessionEventStore,
  createSqliteSessionStore,
} from "@zcode/adapters/storage";
import { createWorkspaceHookTrustRecords } from "@zcode/core";
import { SessionEventType, type ExecutionPort } from "@zcode/contracts";
import { createRegistryBackedTestApp as createZCodeApp } from "./helpers/registry-backed-test-app.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("createZCodeApp workspace Hook admission", () => {
  it("首次 activation 等待 Trust store load；pending blocked，exact pretrust 后执行同一 snapshot", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-workspace-hook-runtime-"));
    roots.push(root);
    const workspace = join(root, "workspace");
    const userConfigPath = join(root, "home", "config.json");
    const storageRoot = join(root, "storage");
    await mkdir(join(workspace, ".git"), { recursive: true });
    await mkdir(join(workspace, ".zcode"), { recursive: true });
    await mkdir(join(root, "home"), { recursive: true });
    await writeFile(userConfigPath, JSON.stringify({ storage: { dir: storageRoot } }));
    await writeFile(
      join(workspace, ".zcode", "config.json"),
      JSON.stringify({
        hooks: {
          enabled: true,
          events: {
            SessionStart: [
              {
                matcher: "startup",
                hooks: [{ type: "command", command: "echo trusted-project-hook" }],
              },
            ],
          },
        },
      }),
    );

    const blockedCommands: string[] = [];
    const blockedEvents = createInMemorySessionEventStore();
    const blockedSessionStore = createSqliteSessionStore({
      dbPath: ":memory:",
    });
    const blockedApp = await createZCodeApp({
      env: {},
      eventStore: blockedEvents,
      executionPort: executionPort(blockedCommands),
      modelExecutor: stopModelExecutor(),
      runtimeConfig: {
        mcp: { enabled: false, servers: {} },
        workingDirectory: workspace,
      },
      sessionStore: blockedSessionStore,
      userConfigPath,
      workspaceHookTrustEnabled: true,
    });
    try {
      await blockedApp.submitPrompt("hello");
      expect(blockedCommands).toEqual([]);
      const events = await blockedEvents.getEvents(blockedApp.sessionId);
      expect(events).toContainEqual(
        expect.objectContaining({
          type: SessionEventType.HookRunBlocked,
          payload: expect.objectContaining({
            descriptor: expect.objectContaining({ sourceKind: "project" }),
            errorCode: "workspace_hooks_pending_trust",
          }),
        }),
      );
    } finally {
      await blockedApp.close();
      blockedSessionStore.close();
    }

    const configResult = createConfig({
      env: {},
      userConfigPath,
      workingDirectory: workspace,
    });
    const snapshot = configResult.sources.project.workspaceHookSnapshot;
    if (!snapshot) throw new Error("expected workspace Hook snapshot");
    const trustStore = await createDefaultFileWorkspaceHookTrustStore({
      userConfigPath,
    });
    await trustStore.grant(
      createWorkspaceHookTrustRecords({
        snapshot,
        reviewItemIds: snapshot.hooks.map((entry) => entry.reviewItemId),
        grantedAt: "2026-08-06T00:00:00.000Z",
      }),
    );

    const trustedCommands: string[] = [];
    const trustedEvents = createInMemorySessionEventStore();
    const trustedSessionStore = createSqliteSessionStore({
      dbPath: ":memory:",
    });
    const trustedApp = await createZCodeApp({
      env: {},
      eventStore: trustedEvents,
      executionPort: executionPort(trustedCommands),
      modelExecutor: stopModelExecutor(),
      runtimeConfig: {
        mcp: { enabled: false, servers: {} },
        workingDirectory: workspace,
      },
      sessionStore: trustedSessionStore,
      userConfigPath,
      workspaceHookTrustEnabled: true,
    });
    try {
      await trustedApp.submitPrompt("hello");
      expect(trustedCommands).toEqual(["echo trusted-project-hook"]);
      const events = await trustedEvents.getEvents(trustedApp.sessionId);
      expect(
        events.some(
          (event) =>
            event.type === SessionEventType.HookRunStarted &&
            event.payload.descriptor?.sourceKind === "project",
        ),
      ).toBe(true);
    } finally {
      await trustedApp.close();
      trustedSessionStore.close();
    }
  });

  it("feature flag 关闭时即使已有 persistent Trust 也不执行且不发 review", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-workspace-hook-rollout-off-"));
    roots.push(root);
    const workspace = join(root, "workspace");
    const userConfigPath = join(root, "home", "config.json");
    const storageRoot = join(root, "storage");
    await mkdir(join(workspace, ".git"), { recursive: true });
    await mkdir(join(workspace, ".zcode"), { recursive: true });
    await mkdir(join(root, "home"), { recursive: true });
    await writeFile(userConfigPath, JSON.stringify({ storage: { dir: storageRoot } }));
    await writeFile(
      join(workspace, ".zcode", "config.json"),
      JSON.stringify({
        hooks: {
          enabled: true,
          events: {
            SessionStart: [{ hooks: [{ type: "command", command: "echo rollout-off" }] }],
          },
        },
      }),
    );

    const configResult = createConfig({
      env: {},
      userConfigPath,
      workingDirectory: workspace,
    });
    const snapshot = configResult.sources.project.workspaceHookSnapshot;
    if (!snapshot) throw new Error("expected workspace Hook snapshot");
    const trustStore = await createDefaultFileWorkspaceHookTrustStore({
      userConfigPath,
    });
    await trustStore.grant(
      createWorkspaceHookTrustRecords({
        snapshot,
        reviewItemIds: snapshot.hooks.map((entry) => entry.reviewItemId),
        grantedAt: "2026-08-06T00:00:00.000Z",
      }),
    );

    const commands: string[] = [];
    const events = createInMemorySessionEventStore();
    const sessionStore = createSqliteSessionStore({ dbPath: ":memory:" });
    const app = await createZCodeApp({
      env: {},
      eventStore: events,
      executionPort: executionPort(commands),
      modelExecutor: stopModelExecutor(),
      runtimeConfig: {
        mcp: { enabled: false, servers: {} },
        workingDirectory: workspace,
      },
      sessionStore,
      userConfigPath,
      workspaceHookTrustEnabled: false,
      workspaceHookReviewHost: {
        taskId: "task-rollout-off",
        runId: "run-rollout-off",
        workspaceLabel: "Rollout off",
      },
    });
    try {
      await app.submitPrompt("hello");
      expect(commands).toEqual([]);
      const recorded = await events.getEvents(app.sessionId);
      expect(recorded).toContainEqual(
        expect.objectContaining({
          type: SessionEventType.HookRunBlocked,
          payload: expect.objectContaining({
            errorCode: "workspace_hooks_feature_disabled",
          }),
        }),
      );
      expect(
        recorded.some((event) => event.type === SessionEventType.WorkspaceHookReviewRequested),
      ).toBe(false);
    } finally {
      await app.close();
      sessionStore.close();
    }
  });

  it("软门禁：activation 跳过 pending hooks，信任选中项后只更新后续准入", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-workspace-hook-review-runtime-"));
    roots.push(root);
    const workspace = join(root, "workspace");
    const userConfigPath = join(root, "home", "config.json");
    const storageRoot = join(root, "storage");
    await mkdir(join(workspace, ".git"), { recursive: true });
    await mkdir(join(workspace, ".zcode"), { recursive: true });
    await mkdir(join(root, "home"), { recursive: true });
    await writeFile(userConfigPath, JSON.stringify({ storage: { dir: storageRoot } }));
    await writeFile(
      join(workspace, ".zcode", "config.json"),
      JSON.stringify({
        hooks: {
          enabled: true,
          events: {
            SessionStart: [{ hooks: [{ type: "command", command: "echo reviewed-once" }] }],
          },
        },
      }),
    );

    const commands: string[] = [];
    const eventStore = createInMemorySessionEventStore();
    const sessionStore = createSqliteSessionStore({ dbPath: ":memory:" });
    const app = await createZCodeApp({
      env: {},
      eventStore,
      executionPort: executionPort(commands),
      modelExecutor: stopModelExecutor(),
      runtimeConfig: {
        mcp: { enabled: false, servers: {} },
        workingDirectory: workspace,
      },
      sessionStore,
      userConfigPath,
      workspaceHookTrustEnabled: true,
      workspaceHookReviewHost: {
        taskId: "task-review",
        runId: "run-review",
        workspaceLabel: "Review workspace",
      },
    });
    try {
      // 软门禁:prompt 触发 activation,pending hooks 直接跳过,turn 照常执行
      const prompt = app.submitPrompt("hello");
      await prompt;

      // pending hooks 被跳过,命令未执行
      expect(commands).toEqual([]);

      // admission updated 事件已发出(pendingCount > 0)
      const admissionEvent = await waitForEvent(
        eventStore,
        app.sessionId,
        SessionEventType.WorkspaceHookAdmissionUpdated,
      );
      expect(admissionEvent.payload).toMatchObject({ pendingCount: 1 });

      // 用户点击「去审核」→ 开 review flow
      const admissionSnapshot = admissionEvent.payload as {
        bundleDigest: string;
        workspaceIdentity?: string;
      };
      await app.requestWorkspaceHookReview({
        workspaceIdentity: admissionSnapshot.workspaceIdentity!,
        bundleDigest: admissionSnapshot.bundleDigest,
      });

      const requestEvent = await waitForEvent(
        eventStore,
        app.sessionId,
        SessionEventType.WorkspaceHookReviewRequested,
      );
      const request = (requestEvent.payload as { request: any }).request;

      // 持久信任选中项；已错过的 SessionStart 不会在当前任务追补。
      await expect(
        app.respondWorkspaceHookReview({
          sessionId: app.sessionId,
          taskId: request.taskId,
          runId: request.runId,
          ...(request.remoteSessionId ? { remoteSessionId: request.remoteSessionId } : {}),
          workspaceIdentity: request.workspaceIdentity,
          bundleDigest: request.bundleDigest,
          reviewFlowId: request.reviewFlowId,
          generation: request.generation,
          interactionId: request.interactionId,
          decision: {
            action: "trust_selected",
            reviewItemIds: [request.items[0].reviewItemId],
          },
        }),
      ).resolves.toMatchObject({ accepted: true });

      const events = await eventStore.getEvents(app.sessionId);
      expect(events).toContainEqual(
        expect.objectContaining({
          type: SessionEventType.WorkspaceHookReviewSettled,
          payload: expect.objectContaining({
            interactionId: request.interactionId,
            state: "resolved",
          }),
        }),
      );
      expect(commands).toEqual([]);
      // 软门禁(D2):settle 后 admission updated 重算 pendingCount=0
      expect(events).toContainEqual(
        expect.objectContaining({
          type: SessionEventType.WorkspaceHookAdmissionUpdated,
          payload: expect.objectContaining({ pendingCount: 0 }),
        }),
      );
    } finally {
      await app.close();
      sessionStore.close();
    }
  });

  // Bug 回归（H1 症状 1+2）：两个 SessionStart 声明，一个 configured-disabled
  // （admission skipLifecycle），一个 pending（admission blocked 但参与生命周期）。
  // 修复前：clientVisibleHookCount=2，skipLifecycle 的 hook 不发事件 → 投影层
  // executions.length(1) < hookCount(2) → 行永久 running，UI 计时器走秒不终止。
  // 修复后：skipLifecycle 的 hook 从参与列表剔除 → hookCount=1，1 条 blocked
  // execution，state 终态。
  it("H1 场景 A:configured-disabled + pending SessionStart → hookCount=1、1 blocked、state 终态", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-hook-h1-scenario-a-"));
    roots.push(root);
    const workspace = join(root, "workspace");
    const userConfigPath = join(root, "home", "config.json");
    const storageRoot = join(root, "storage");
    await mkdir(join(workspace, ".git"), { recursive: true });
    await mkdir(join(workspace, ".zcode"), { recursive: true });
    await mkdir(join(root, "home"), { recursive: true });
    await writeFile(userConfigPath, JSON.stringify({ storage: { dir: storageRoot } }));
    await writeFile(
      join(workspace, ".zcode", "config.json"),
      JSON.stringify({
        hooks: {
          enabled: true,
          events: {
            SessionStart: [
              {
                hooks: [
                  {
                    type: "command",
                    command: "echo session-start-a",
                    enabled: false,
                  },
                ],
              },
              {
                hooks: [{ type: "command", command: "echo session-start-b" }],
              },
            ],
          },
        },
      }),
    );

    const commands: string[] = [];
    const eventStore = createInMemorySessionEventStore();
    const sessionStore = createSqliteSessionStore({ dbPath: ":memory:" });
    const app = await createZCodeApp({
      env: {},
      eventStore,
      executionPort: executionPort(commands),
      modelExecutor: stopModelExecutor(),
      runtimeConfig: {
        mcp: { enabled: false, servers: {} },
        workingDirectory: workspace,
      },
      sessionStore,
      userConfigPath,
      workspaceHookTrustEnabled: true,
    });
    try {
      await app.submitPrompt("hello");

      // configured-disabled 的 hook 不执行命令
      // pending 的 hook 也被 blocked → 无命令执行
      expect(commands).toEqual([]);

      const events = await eventStore.getEvents(app.sessionId);
      const hookLifecycleEvents = events.filter(
        (event) =>
          event.type === SessionEventType.HookRunBlocked ||
          event.type === SessionEventType.HookRunStarted ||
          event.type === SessionEventType.HookRunCompleted ||
          event.type === SessionEventType.HookRunFailed,
      );

      // 只有 1 条 blocked execution（pending 的 B），configured-disabled 的 A 完全不可见
      expect(hookLifecycleEvents).toHaveLength(1);
      expect(hookLifecycleEvents[0]?.type).toBe(SessionEventType.HookRunBlocked);

      const payload = hookLifecycleEvents[0]?.payload as Record<string, unknown>;
      // hookCount 必须是 1，否则投影层会等一个永远不来的 execution（H1 核心断言）
      expect(payload.hookCount).toBe(1);
      expect(payload.errorCode).toBe("workspace_hooks_pending_trust");
      expect(payload.descriptor).toMatchObject({
        commandDisplay: "echo session-start-b",
      });

      // 所有事件的 hookInvocationId 一致
      const invocationIds = new Set(
        hookLifecycleEvents.map(
          (event) => (event.payload as Record<string, unknown>).hookInvocationId,
        ),
      );
      expect(invocationIds.size).toBe(1);
    } finally {
      await app.close();
      sessionStore.close();
    }
  });

  // 持久信任只影响之后自然发生的生命周期事件；SessionStart 不做 catch-up。
  it("两个 pending SessionStart 信任后，当前任务后续 turn 不补跑", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-hook-h2-scenario-b-"));
    roots.push(root);
    const workspace = join(root, "workspace");
    const userConfigPath = join(root, "home", "config.json");
    const storageRoot = join(root, "storage");
    await mkdir(join(workspace, ".git"), { recursive: true });
    await mkdir(join(workspace, ".zcode"), { recursive: true });
    await mkdir(join(root, "home"), { recursive: true });
    await writeFile(userConfigPath, JSON.stringify({ storage: { dir: storageRoot } }));
    await writeFile(
      join(workspace, ".zcode", "config.json"),
      JSON.stringify({
        hooks: {
          enabled: true,
          events: {
            SessionStart: [
              { hooks: [{ type: "command", command: "echo session-start-a" }] },
              { hooks: [{ type: "command", command: "echo session-start-b" }] },
            ],
          },
        },
      }),
    );

    const commands: string[] = [];
    const eventStore = createInMemorySessionEventStore();
    const sessionStore = createSqliteSessionStore({ dbPath: ":memory:" });
    const app = await createZCodeApp({
      env: {},
      eventStore,
      executionPort: executionPort(commands),
      modelExecutor: stopModelExecutor(),
      runtimeConfig: {
        mcp: { enabled: false, servers: {} },
        workingDirectory: workspace,
      },
      sessionStore,
      userConfigPath,
      workspaceHookTrustEnabled: true,
      workspaceHookReviewHost: {
        taskId: "task-review",
        runId: "run-review",
        workspaceLabel: "Review workspace",
      },
    });
    try {
      // ── 第一 turn:两个 SessionStart 都 pending → 全部 blocked ──
      await app.submitPrompt("turn-1");
      expect(commands).toEqual([]);

      const turn1Events = await eventStore.getEvents(app.sessionId);
      const turn1Blocked = turn1Events.filter(
        (event) => event.type === SessionEventType.HookRunBlocked,
      );
      // 2 条 blocked execution
      expect(turn1Blocked).toHaveLength(2);
      // hookCount=2
      const turn1Payload = turn1Blocked[0]?.payload as Record<string, unknown>;
      expect(turn1Payload.hookCount).toBe(2);

      // ── 持久信任当前快照中的全部声明 ──
      const admissionEvent = await waitForEvent(
        eventStore,
        app.sessionId,
        SessionEventType.WorkspaceHookAdmissionUpdated,
      );
      const admissionSnapshot = admissionEvent.payload as {
        bundleDigest: string;
        workspaceIdentity?: string;
      };
      await app.requestWorkspaceHookReview({
        workspaceIdentity: admissionSnapshot.workspaceIdentity!,
        bundleDigest: admissionSnapshot.bundleDigest,
      });
      const requestEvent = await waitForEvent(
        eventStore,
        app.sessionId,
        SessionEventType.WorkspaceHookReviewRequested,
      );
      const request = (requestEvent.payload as { request: any }).request;
      await expect(
        app.respondWorkspaceHookReview({
          sessionId: app.sessionId,
          taskId: request.taskId,
          runId: request.runId,
          ...(request.remoteSessionId ? { remoteSessionId: request.remoteSessionId } : {}),
          workspaceIdentity: request.workspaceIdentity,
          bundleDigest: request.bundleDigest,
          reviewFlowId: request.reviewFlowId,
          generation: request.generation,
          interactionId: request.interactionId,
          decision: {
            action: "trust_selected",
            reviewItemIds: request.items.map((item: { reviewItemId: string }) => item.reviewItemId),
          },
        }),
      ).resolves.toMatchObject({ accepted: true });

      // ── 第二 turn：SessionStart 不补跑 ──
      await app.submitPrompt("turn-2");
      expect(commands).toEqual([]);

      // ── 第三 turn：仍不补跑 ──
      await app.submitPrompt("turn-3");
      expect(commands).toEqual([]);
    } finally {
      await app.close();
      sessionStore.close();
    }
  });
});

async function waitForEvent(
  store: ReturnType<typeof createInMemorySessionEventStore>,
  sessionId: Parameters<typeof store.getEvents>[0],
  type: string,
) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const event = (await store.getEvents(sessionId)).find((candidate) => candidate.type === type);
    if (event) return event;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${type}`);
}

function executionPort(commands: string[]): ExecutionPort {
  return {
    async run(request) {
      commands.push(
        request.command.mode === "shell" ? request.command.command : request.command.file,
      );
      const now = new Date("2026-08-06T00:00:00.000Z");
      return {
        status: "completed",
        exitCode: 0,
        stdout: { text: "", bytes: 0, truncated: false },
        stderr: { text: "", bytes: 0, truncated: false },
        durationMs: 1,
        timedOut: false,
        cancelled: false,
        startedAt: now,
        completedAt: now,
      };
    },
  };
}

function stopModelExecutor() {
  return {
    async generateText() {
      return {
        finishReason: "stop",
        text: "ok",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      };
    },
    async *streamText() {
      yield {
        finishReason: "stop",
        type: "finish",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      };
    },
  } as never;
}
