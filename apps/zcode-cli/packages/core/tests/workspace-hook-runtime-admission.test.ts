import { describe, expect, it, vi } from "vitest";
import {
  HookEventName,
  HookOutcome,
  SessionEventType,
  createWorkspaceHookBundleSnapshot,
  type ExecutionPort,
  type HookInput,
  type SessionEvent,
  type WorkspaceHookBundleSnapshot,
} from "@zcode/contracts";
import {
  InMemoryWorkspaceHookPolicyProvider,
  WorkspaceHookTrustCoordinator,
  createConfiguredHookRunner,
  createWorkspaceHookRuntimeAdmission,
  createWorkspaceHookTrustRecords,
} from "../src/hooks/index.js";
import { runSessionStartHooks } from "../src/runtime/methods/hooks.js";

const WORKSPACE = "local:/workspace";
const BUNDLE = "c".repeat(64);
const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);

function snapshot(
  input: {
    event?: (typeof HookEventName)[keyof typeof HookEventName];
    matcher?: string | null;
    async?: boolean;
    command?: string;
    digest?: string;
    bundleDigest?: string;
    configuredEnabled?: boolean;
  } = {},
): WorkspaceHookBundleSnapshot {
  return createWorkspaceHookBundleSnapshot({
    schemaVersion: 1,
    workspaceIdentity: WORKSPACE,
    discoveredAt: "2026-08-06T00:00:00.000Z",
    sourceFiles: [
      {
        canonicalPath: "/workspace/.zcode/config.json",
        baseDir: "/workspace",
        discoveryOrder: 0,
        configFileKind: ".zcode/config.json",
        explicitProjectConfig: false,
        editable: true,
        hooksRoot: { enabled: true },
      },
    ],
    hooks: [
      {
        reviewItemId: "item-0",
        event: input.event ?? HookEventName.SessionStart,
        matcherIndex: 0,
        hookIndex: 0,
        sourceFileIndex: 0,
        sourceRelativePath: ".zcode/config.json",
        matcher: input.matcher === undefined ? "startup" : input.matcher,
        type: "command",
        command: input.command ?? "echo project",
        ...(input.async ? { async: true } : {}),
        resolvedTimeoutMs: 60_000,
        resolvedMaxOutputBytes: 32_768,
        sourceRootEnabled: input.configuredEnabled ?? true,
        declarationEnabled: input.configuredEnabled ?? true,
        runtimeHooksEnabled: true,
        configuredEnabled: input.configuredEnabled ?? true,
        editable: true,
        declarationDigestAlgorithm: "sha256",
        hookDeclarationDigest: input.digest ?? DIGEST_A,
      },
    ],
    digestAlgorithm: "sha256",
    bundleDigest: input.bundleDigest ?? BUNDLE,
  });
}

function createCoordinator(
  input: {
    trusted?: boolean;
    policy?: InMemoryWorkspaceHookPolicyProvider;
  } = {},
) {
  const coordinator = new WorkspaceHookTrustCoordinator({
    coordinatorEpoch: "epoch-runtime",
    policyProvider: input.policy,
  });
  if (input.trusted) {
    coordinator.replacePersistentTrustRecords(
      createWorkspaceHookTrustRecords({
        snapshot: snapshot(),
        reviewItemIds: ["item-0"],
        grantedAt: "2026-08-06T00:00:00.000Z",
      }),
      { status: "ok" },
    );
  } else {
    coordinator.replacePersistentTrustRecords([], { status: "missing" });
  }
  return coordinator;
}

function sessionStartInput(): HookInput {
  return {
    cwd: "/workspace",
    hookEventName: HookEventName.SessionStart,
    mode: "build",
    sessionId: "session-1" as never,
    source: "startup",
    timestamp: "2026-08-06T00:00:00.000Z",
    traceId: "trace-1" as never,
  };
}

function completedExecutionPort(onRun?: (command: string) => void): ExecutionPort {
  return {
    async run(request) {
      const command =
        request.command.mode === "shell" ? request.command.command : request.command.file;
      onRun?.(command);
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

function configuredRunner(input: {
  coordinator: WorkspaceHookTrustCoordinator;
  hookSnapshot?: WorkspaceHookBundleSnapshot;
  events?: SessionEvent[];
  commands?: string[];
  onAdmissionStateChanged?: (state: { pendingCount: number; bundleDigest: string }) => void;
}) {
  const hookSnapshot = input.hookSnapshot ?? snapshot();
  const admission = createWorkspaceHookRuntimeAdmission({
    coordinator: input.coordinator,
    ready: Promise.resolve(),
    snapshot: hookSnapshot,
    ...(input.onAdmissionStateChanged
      ? { onAdmissionStateChanged: input.onAdmissionStateChanged }
      : {}),
  });
  const runner = createConfiguredHookRunner({
    config: {
      enabled: true,
      events: {},
      maxOutputBytes: 32_768,
      timeoutMs: 60_000,
    },
    emitEvent: async (event) => input.events?.push(event),
    executionPort: completedExecutionPort((command) => input.commands?.push(command)),
    getWorkingDirectory: () => "/workspace",
    workspaceHookAdmission: admission,
    workspaceHookSnapshot: hookSnapshot,
  });
  if (!runner) throw new Error("expected configured runner");
  return { admission, runner };
}

describe("Workspace Hook Runtime admission", () => {
  it("feature flag 关闭时不读取 Trust store,上报 pendingCount=0,并保持 hard block", async () => {
    const ready = new Promise<void>(() => {
      // disabled rollout must not await this bootstrap promise
    });
    const stateCallback = vi.fn();
    const admission = createWorkspaceHookRuntimeAdmission({
      coordinator: createCoordinator({ trusted: true }),
      enabled: false,
      ready,
      onAdmissionStateChanged: stateCallback,
      snapshot: snapshot(),
    });

    await admission.activate("startup");

    // 软门禁(D1):功能关闭时上报 pendingCount=0
    expect(stateCallback).toHaveBeenCalledWith(expect.objectContaining({ pendingCount: 0 }));
    expect(
      admission.evaluateDispatch({
        hookDeclarationDigest: DIGEST_A,
        reviewItemId: "item-0",
      }),
    ).toEqual({
      allowed: false,
      reasonCode: "workspace_hooks_feature_disabled",
    });
  });

  it("未 Trust 的 startup project Hook 在 HookRunStarted 和 ExecutionPort 前 blocked", async () => {
    const events: SessionEvent[] = [];
    const commands: string[] = [];
    const { admission, runner } = configuredRunner({
      coordinator: createCoordinator(),
      events,
      commands,
    });

    await admission.activate("startup");
    await runner.run(sessionStartInput(), { matchValue: "startup" });

    expect(commands).toEqual([]);
    expect(events.map((event) => event.type)).toEqual([SessionEventType.HookRunBlocked]);
    expect(events[0]?.payload).toMatchObject({
      descriptor: { sourceKind: "project", clientVisible: true },
      errorCode: "workspace_hooks_pending_trust",
      outcome: HookOutcome.Blocked,
    });
  });

  it("只执行 immutable snapshot 中 exact persistent digest", async () => {
    const commands: string[] = [];
    const { admission, runner } = configuredRunner({
      coordinator: createCoordinator({ trusted: true }),
      commands,
    });

    await admission.activate("startup");
    await runner.run(sessionStartInput(), { matchValue: "startup" });

    expect(commands).toEqual(["echo project"]);
  });

  it("revoke 与 policy hot deny 使旧 revision 的后续 dispatch 立即 blocked", async () => {
    const policy = new InMemoryWorkspaceHookPolicyProvider();
    const coordinator = createCoordinator({ trusted: true, policy });
    const events: SessionEvent[] = [];
    const commands: string[] = [];
    const { admission, runner } = configuredRunner({
      coordinator,
      events,
      commands,
    });
    await admission.activate("startup");

    await runner.run(sessionStartInput(), { matchValue: "startup" });
    coordinator.revoke({
      workspaceIdentity: WORKSPACE,
      hookDeclarationDigests: [DIGEST_A],
    });
    await runner.run(sessionStartInput(), { matchValue: "startup" });

    coordinator.replacePersistentTrustRecords(
      createWorkspaceHookTrustRecords({
        snapshot: snapshot(),
        reviewItemIds: ["item-0"],
        grantedAt: "2026-08-06T00:00:01.000Z",
      }),
      { status: "ok" },
    );
    policy.setWorkspacePolicy(WORKSPACE, {
      mode: "deny",
      reason: "managed policy denied workspace hooks",
      policyRevision: "managed:deny:1",
    });
    await runner.run(sessionStartInput(), { matchValue: "startup" });

    expect(commands).toEqual(["echo project"]);
    expect(
      events
        .filter((event) => event.type === SessionEventType.HookRunBlocked)
        .map((event) => ({
          code: event.payload.errorCode,
          source: event.payload.descriptor?.sourceKind,
        })),
    ).toEqual([
      { code: "workspace_hooks_revoked", source: "project" },
      { code: "workspace_hooks_blocked_by_policy", source: "project" },
    ]);
  });

  it("blocked async project Hook 不创建 callback/background Promise", async () => {
    const events: SessionEvent[] = [];
    const commands: string[] = [];
    const hookSnapshot = snapshot({ async: true });
    const { admission, runner } = configuredRunner({
      coordinator: createCoordinator(),
      events,
      commands,
      hookSnapshot,
    });

    await admission.activate("startup");
    await runner.run(sessionStartInput(), { matchValue: "startup" });
    await Promise.resolve();

    expect(commands).toEqual([]);
    expect(events.map((event) => event.type)).toEqual([SessionEventType.HookRunBlocked]);
  });

  it("snapshot/bundle/item mismatch fail closed", async () => {
    const hookSnapshot = snapshot();
    const admission = createWorkspaceHookRuntimeAdmission({
      coordinator: createCoordinator({ trusted: true }),
      ready: Promise.resolve(),
      snapshot: hookSnapshot,
    });
    await admission.activate("startup");

    expect(
      admission.evaluateDispatch({
        bundleDigest: "d".repeat(64),
        hookDeclarationDigest: DIGEST_A,
        reviewItemId: "item-0",
      }),
    ).toEqual({
      allowed: false,
      reasonCode: "workspace_hooks_snapshot_mismatch",
    });
    expect(
      admission.evaluateDispatch({
        bundleDigest: BUNDLE,
        hookDeclarationDigest: "e".repeat(64),
        reviewItemId: "item-0",
      }),
    ).toEqual({
      allowed: false,
      reasonCode: "workspace_hooks_snapshot_mismatch",
    });
  });

  it("按 user -> project -> internal 保持 mixed-source lifecycle 顺序", async () => {
    const events: SessionEvent[] = [];
    const coordinator = createCoordinator();
    const hookSnapshot = snapshot({
      event: HookEventName.UserPromptSubmit,
      matcher: null,
    });
    const admission = createWorkspaceHookRuntimeAdmission({
      coordinator,
      ready: Promise.resolve(),
      snapshot: hookSnapshot,
    });
    const runner = createConfiguredHookRunner({
      config: {
        enabled: true,
        events: {
          UserPromptSubmit: [
            {
              hooks: [
                {
                  type: "command",
                  command: "echo user",
                  source: { kind: "user", path: "/home/user/config.json" },
                },
                {
                  type: "command",
                  command: "echo internal",
                  source: { kind: "internal" },
                },
              ],
            },
          ],
        },
        maxOutputBytes: 32_768,
        timeoutMs: 60_000,
      },
      emitEvent: async (event) => events.push(event),
      executionPort: completedExecutionPort(),
      getWorkingDirectory: () => "/workspace",
      workspaceHookAdmission: admission,
      workspaceHookSnapshot: hookSnapshot,
    });
    if (!runner) throw new Error("expected configured runner");
    await admission.activate("startup");

    await runner.run({
      cwd: "/workspace",
      hookEventName: HookEventName.UserPromptSubmit,
      mode: "build",
      prompt: "hello",
      sessionId: "session-1" as never,
      timestamp: "2026-08-06T00:00:00.000Z",
      traceId: "trace-1" as never,
    });

    expect(events.map((event) => `${event.type}:${event.payload.descriptor?.sourceKind}`)).toEqual([
      "hook_run_started:user",
      "hook_run_completed:user",
      "hook_run_blocked:project",
      "hook_run_started:internal",
      "hook_run_completed:internal",
    ]);
  });

  it("toggle rebuild 可替换 immutable snapshot;disabled 旧 callback 不能执行", async () => {
    const coordinator = createCoordinator({ trusted: true });
    const enabledSnapshot = snapshot();
    const commands: string[] = [];
    const { admission, runner } = configuredRunner({
      coordinator,
      commands,
      hookSnapshot: enabledSnapshot,
    });
    await admission.activate("startup");
    admission.replaceSnapshot(snapshot({ bundleDigest: "d".repeat(64), configuredEnabled: false }));

    await runner.run(sessionStartInput(), { matchValue: "startup" });

    expect(commands).toEqual([]);
  });

  it("初始 disabled declaration 也可持久信任，enable rebuild 后由 exact digest 放行", async () => {
    const coordinator = createCoordinator();
    const disabledSnapshot = snapshot({ configuredEnabled: false });
    const commands: string[] = [];
    const { admission, runner } = configuredRunner({
      coordinator,
      commands,
      hookSnapshot: disabledSnapshot,
    });
    await admission.activate("startup");
    coordinator.replacePersistentTrustRecords(
      createWorkspaceHookTrustRecords({
        snapshot: disabledSnapshot,
        reviewItemIds: ["item-0"],
        grantedAt: "2026-08-06T00:00:01.000Z",
      }),
      { status: "ok" },
    );
    const enabledSnapshot = snapshot({ bundleDigest: "d".repeat(64) });
    admission.replaceSnapshot(enabledSnapshot);

    await runner.run(sessionStartInput(), { matchValue: "startup" });

    expect(commands).toEqual(["echo project"]);
  });

  it("手工改写 declaration 后旧 callback 即使 reviewItemId 相同也 snapshot mismatch", async () => {
    const coordinator = createCoordinator({ trusted: true });
    const events: SessionEvent[] = [];
    const { admission, runner } = configuredRunner({ coordinator, events });
    await admission.activate("startup");
    admission.replaceSnapshot(
      snapshot({
        bundleDigest: "d".repeat(64),
        command: "echo changed",
        digest: "e".repeat(64),
      }),
    );

    await runner.run(sessionStartInput(), { matchValue: "startup" });

    expect(events.at(-1)).toEqual(
      expect.objectContaining({
        type: SessionEventType.HookRunBlocked,
        payload: expect.objectContaining({
          errorCode: "workspace_hooks_snapshot_mismatch",
        }),
      }),
    );
  });

  it("shared SessionStart guard 在 startup/resume dispatch 之前 activate,且无 runner 也执行", async () => {
    const order: string[] = [];
    const fakeRuntime = {
      config: {},
      getSessionModelSelection: () => ({ providerId: "openai", modelId: "gpt-test" }),
      getMode: () => "build",
      hookRunner: {
        run: vi.fn(async () => {
          order.push("run");
          return { additionalContexts: [] };
        }),
      },
      sessionId: "session-1",
      sessionStartHookRan: false,
      workingDirectory: "/workspace",
      workspaceHookAdmission: {
        activate: vi.fn(async (source: string) => {
          order.push(`activate:${source}`);
        }),
      },
    } as never;

    await runSessionStartHooks.call(fakeRuntime, "startup", {
      traceId: "trace-1",
    } as never);
    expect(order).toEqual(["activate:startup", "run"]);

    order.length = 0;
    const withoutRunner = {
      ...fakeRuntime,
      hookRunner: undefined,
      sessionStartHookRan: false,
    } as never;
    await runSessionStartHooks.call(withoutRunner, "resume", {
      traceId: "trace-1",
    } as never);
    expect(order).toEqual(["activate:resume"]);
  });

  it("跨 workspaceIdentity 的 replaceSnapshot 必须抛错(fail-loud 不变式)", () => {
    const admission = createWorkspaceHookRuntimeAdmission({
      coordinator: createCoordinator({ trusted: true }),
      ready: Promise.resolve(),
      snapshot: snapshot(),
    });

    const crossIdentitySnapshot = createWorkspaceHookBundleSnapshot({
      schemaVersion: 1,
      workspaceIdentity: "local:/other-workspace",
      discoveredAt: "2026-08-06T00:00:00.000Z",
      sourceFiles: [],
      hooks: [],
      digestAlgorithm: "sha256",
      bundleDigest: "f".repeat(64),
    });

    expect(() => admission.replaceSnapshot(crossIdentitySnapshot)).toThrow(
      /across workspace identities/u,
    );

    expect(admission.getCurrentSnapshot().workspaceIdentity).toBe(WORKSPACE);
    expect(admission.getCurrentSnapshot().bundleDigest).toBe(BUNDLE);
  });

  it("同 workspaceIdentity 的 replaceSnapshot 成功替换快照", () => {
    const admission = createWorkspaceHookRuntimeAdmission({
      coordinator: createCoordinator({ trusted: true }),
      ready: Promise.resolve(),
      snapshot: snapshot(),
    });

    const newBundle = "d".repeat(64);
    admission.replaceSnapshot(snapshot({ bundleDigest: newBundle }));

    expect(admission.getCurrentSnapshot().bundleDigest).toBe(newBundle);
  });

  it("activate 中 evaluateSnapshot 抛错不冒泡,workspace Hook 保持 fail-closed", async () => {
    const coordinator = createCoordinator({ trusted: true });
    const admission = createWorkspaceHookRuntimeAdmission({
      coordinator,
      ready: Promise.resolve(),
      snapshot: snapshot(),
    });

    const spy = vi.spyOn(coordinator, "evaluateSnapshot").mockImplementationOnce(() => {
      throw new Error("zod parse failed on malformed state");
    });

    await expect(admission.activate("startup")).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalledTimes(1);

    expect(
      admission.evaluateDispatch({
        hookDeclarationDigest: DIGEST_A,
        reviewItemId: "item-0",
      }),
    ).toEqual({
      allowed: false,
      reasonCode: "workspace_hooks_trust_store_corrupt",
    });
  });

  // —— 软门禁(D1) 软门禁语义测试 ——

  it("D1: activate 不等待 review,pending hooks 的 dispatch 仍 blocked", async () => {
    const events: SessionEvent[] = [];
    const commands: string[] = [];
    const { admission, runner } = configuredRunner({
      coordinator: createCoordinator(), // 未 trust
      events,
      commands,
    });

    // activate 应立即返回(不等 review)
    const start = Date.now();
    await admission.activate("startup");
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(100); // 不阻塞

    // dispatch 仍然 blocked
    expect(
      admission.evaluateDispatch({
        hookDeclarationDigest: DIGEST_A,
        reviewItemId: "item-0",
      }),
    ).toEqual({
      allowed: false,
      reasonCode: "workspace_hooks_pending_trust",
    });
  });

  it("D1: onAdmissionStateChanged 上报 pendingCount > 0(未 trust)", async () => {
    const states: Array<{ pendingCount: number; bundleDigest: string }> = [];
    const { admission } = configuredRunner({
      coordinator: createCoordinator(), // 未 trust → pending
      onAdmissionStateChanged: (s) => states.push(s),
    });

    await admission.activate("startup");

    expect(states).toHaveLength(1);
    expect(states[0]!.pendingCount).toBe(1);
    expect(states[0]!.bundleDigest).toBe(BUNDLE);
  });

  it("D1: onAdmissionStateChanged 上报 pendingCount = 0(已 trust)", async () => {
    const states: Array<{ pendingCount: number; bundleDigest: string }> = [];
    const { admission } = configuredRunner({
      coordinator: createCoordinator({ trusted: true }),
      onAdmissionStateChanged: (s) => states.push(s),
    });

    await admission.activate("startup");

    expect(states).toHaveLength(1);
    expect(states[0]!.pendingCount).toBe(0);
  });

  it("D1: feature disabled 时 onAdmissionStateChanged 上报 pendingCount = 0", async () => {
    const states: Array<{ pendingCount: number; bundleDigest: string }> = [];
    const admission = createWorkspaceHookRuntimeAdmission({
      coordinator: createCoordinator(),
      enabled: false,
      ready: Promise.resolve(),
      onAdmissionStateChanged: (s) => states.push(s),
      snapshot: snapshot(),
    });

    await admission.activate("startup");

    expect(states).toHaveLength(1);
    expect(states[0]!.pendingCount).toBe(0);
  });

  // SessionStart 是自然生命周期事件：首次因未信任被跳过后，本任务内不会追补。
  it("首次 SessionStart 未信任被跳过，之后持久信任也不在下一轮补跑", async () => {
    const coordinator = createCoordinator();
    const commands: string[] = [];
    const hookSnapshot = snapshot();
    const { admission, runner } = configuredRunner({
      coordinator,
      commands,
      hookSnapshot,
    });
    const runtime = {
      config: {},
      getSessionModelSelection: () => ({ providerId: "openai", modelId: "gpt-test" }),
      getMode: () => "build",
      hookRunner: runner,
      sessionId: "session-1",
      sessionStartHookRan: false,
      workingDirectory: "/workspace",
      workspaceHookAdmission: admission,
    } as never;

    await runSessionStartHooks.call(runtime, "startup", {
      traceId: "trace-1",
    } as never);
    expect(commands).toEqual([]);

    coordinator.replacePersistentTrustRecords(
      createWorkspaceHookTrustRecords({
        snapshot: hookSnapshot,
        reviewItemIds: ["item-0"],
        grantedAt: "2026-08-06T00:00:01.000Z",
      }),
      { status: "ok" },
    );
    await runSessionStartHooks.call(runtime, "resume", {
      traceId: "trace-2",
    } as never);

    expect(commands).toEqual([]);
  });
});
