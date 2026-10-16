import type { CommandAck, CommandEnvelope } from "@zcode/shared/zcode-protocol-v4";
import type { Hook } from "@zcode/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { trustWorkspaceHookWithReview } from "@/settings/workspaceHookReviewCommands.js";
import {
  useWorkspaceHookReviewStore,
  type WorkspaceHookReviewBinding,
} from "@/store/workspaceHookReviewStore.js";

const BUNDLE = "b".repeat(64);

function workspaceHook(): Hook {
  return {
    id: "workspace-hook-row",
    event: "SessionStart",
    type: "command",
    command: "echo project",
    enabled: false,
    workspaceHook: {
      reviewItemId: "item-0",
      workspaceIdentity: "workspace:repo",
      bundleDigest: BUNDLE,
      hookDeclarationDigest: "a".repeat(64),
      sourceFileIndex: 0,
      sourceRootEnabled: true,
      declarationEnabled: false,
      runtimeHooksEnabled: true,
      configuredEnabled: false,
      sourcePath: ".zcode/config.json",
      trustState: "pending_trust",
    },
  };
}

function reviewBinding(
  sendCommand: (envelope: CommandEnvelope) => Promise<CommandAck>,
): WorkspaceHookReviewBinding {
  return {
    workspacePath: "/repo",
    sendCommand,
    request: {
      kind: "workspaceHookReview",
      reviewFlowId: "flow-1",
      generation: 1,
      interactionId: "interaction-1",
      sessionId: "session-1",
      taskId: "task-1",
      runId: "run-1",
      workspaceIdentity: "workspace:repo",
      workspaceLabel: "repo",
      bundleDigest: BUNDLE,
      createdAt: 1,
      deadlineAt: Date.now() + 60_000,
      sourceFiles: [],
      summary: { eventCount: 1, hookCount: 1, pendingCount: 1 },
      items: [
        {
          reviewItemId: "item-0",
          event: "SessionStart",
          type: "command",
          displayName: "SessionStart",
          displayCommand: "echo project",
          sourcePath: ".zcode/config.json",
          resolvedTimeoutMs: 60_000,
          resolvedMaxOutputBytes: 32_768,
          executionMode: "foreground",
          configuredEnabled: false,
          editable: true,
          trustState: "pending_trust",
        },
      ],
      warningCode: "workspace_hooks_execute_code",
    },
  };
}

function accepted(envelope: CommandEnvelope): CommandAck {
  return {
    commandId: envelope.commandId,
    status: "accepted",
    revisionAtDecision: 1,
  };
}

function failed(envelope: CommandEnvelope, reasonCode: string): CommandAck {
  return {
    commandId: envelope.commandId,
    status: "failed",
    reasonCode,
    revisionAtDecision: 1,
  };
}

beforeEach(() => {
  useWorkspaceHookReviewStore.setState({ bindings: {}, commandBindings: {} });
});

describe("workspace Hook Settings inline trust", () => {
  it("没有活跃 review 时先 request，再等待同 bundle/item 的 request 后 respond", async () => {
    const commandTypes: string[] = [];
    const sendCommand = vi.fn(async (envelope: CommandEnvelope) => {
      commandTypes.push(envelope.type);
      if (envelope.type === "requestWorkspaceHookReview") {
        queueMicrotask(() => {
          useWorkspaceHookReviewStore.getState().upsert("session-1", reviewBinding(sendCommand));
        });
      }
      return accepted(envelope);
    });
    useWorkspaceHookReviewStore.getState().connect("session-1", {
      sessionId: "session-1",
      workspacePath: "/repo",
      workspaceIdentity: "workspace:repo",
      sendCommand,
    });

    await expect(
      trustWorkspaceHookWithReview({
        hook: workspaceHook(),
        workspacePath: "/repo",
        workspaceIdentity: "workspace:repo",
        reviewWaitTimeoutMs: 100,
      }),
    ).resolves.toEqual({ accepted: true });

    expect(commandTypes).toEqual(["requestWorkspaceHookReview", "respondWorkspaceHookReview"]);
    expect(sendCommand.mock.calls[0]?.[0].payload).toEqual({
      sessionId: "session-1",
      workspaceIdentity: "workspace:repo",
      bundleDigest: BUNDLE,
    });
    expect(sendCommand.mock.calls[1]?.[0].payload).toEqual(
      expect.objectContaining({
        interactionId: "interaction-1",
        decision: { action: "trust_selected", reviewItemIds: ["item-0"] },
      }),
    );
  });

  it("已有精确 review 时直接 respond，不重复 request", async () => {
    const commandTypes: string[] = [];
    const sendCommand = vi.fn(async (envelope: CommandEnvelope) => {
      commandTypes.push(envelope.type);
      return accepted(envelope);
    });
    useWorkspaceHookReviewStore.getState().upsert("session-1", reviewBinding(sendCommand));

    const grantWithoutSession = vi.fn();
    await expect(
      trustWorkspaceHookWithReview({
        hook: workspaceHook(),
        workspacePath: "/repo",
        workspaceIdentity: "workspace:repo",
        grantWithoutSession,
      }),
    ).resolves.toEqual({ accepted: true });

    expect(commandTypes).toEqual(["respondWorkspaceHookReview"]);
    expect(grantWithoutSession).not.toHaveBeenCalled();
  });

  it("等待期间只有错误 bundle 的 review 时有界失败，绝不跨 bundle respond", async () => {
    const commandTypes: string[] = [];
    const sendCommand = vi.fn(async (envelope: CommandEnvelope) => {
      commandTypes.push(envelope.type);
      if (envelope.type === "requestWorkspaceHookReview") {
        const stale = reviewBinding(sendCommand);
        stale.request = { ...stale.request, bundleDigest: "c".repeat(64) };
        queueMicrotask(() => {
          useWorkspaceHookReviewStore.getState().upsert("session-1", stale);
        });
      }
      return accepted(envelope);
    });
    useWorkspaceHookReviewStore.getState().connect("session-1", {
      sessionId: "session-1",
      workspacePath: "/repo",
      workspaceIdentity: "workspace:repo",
      sendCommand,
    });

    await expect(
      trustWorkspaceHookWithReview({
        hook: workspaceHook(),
        workspacePath: "/repo",
        workspaceIdentity: "workspace:repo",
        reviewWaitTimeoutMs: 10,
      }),
    ).resolves.toEqual({
      accepted: false,
      reasonCode: "workspace_hooks_interaction_timeout",
    });
    expect(commandTypes).toEqual(["requestWorkspaceHookReview"]);
  });

  it.each([
    "workspace_hooks_require_trust_capable_host",
    "workspace_hooks_snapshot_mismatch",
    "workspace_hooks_bundle_changed",
  ])("当前 session 无法审核 Settings bundle（%s）时转入 workspace grant", async (reasonCode) => {
    const commandTypes: string[] = [];
    const sendCommand = vi.fn(async (envelope: CommandEnvelope) => {
      commandTypes.push(envelope.type);
      return failed(envelope, reasonCode);
    });
    useWorkspaceHookReviewStore.getState().connect("session-1", {
      sessionId: "session-1",
      workspacePath: "/repo",
      workspaceIdentity: "workspace:repo",
      sendCommand,
    });
    const grantWithoutSession = vi.fn(async () => ({ accepted: true }));

    await expect(
      trustWorkspaceHookWithReview({
        hook: workspaceHook(),
        workspacePath: "/repo",
        workspaceIdentity: "workspace:repo",
        grantWithoutSession,
      }),
    ).resolves.toEqual({ accepted: true });

    expect(commandTypes).toEqual(["requestWorkspaceHookReview"]);
    expect(grantWithoutSession).toHaveBeenCalledWith({
      workspacePath: "/repo",
      workspaceIdentity: "workspace:repo",
      bundleDigest: BUNDLE,
      hookDeclarationDigest: "a".repeat(64),
    });
  });

  it("当前 session 的其他拒绝不绕过 Runtime authority", async () => {
    const sendCommand = vi.fn(async (envelope: CommandEnvelope) =>
      failed(envelope, "workspace_hooks_blocked_by_policy"),
    );
    useWorkspaceHookReviewStore.getState().connect("session-1", {
      sessionId: "session-1",
      workspacePath: "/repo",
      workspaceIdentity: "workspace:repo",
      sendCommand,
    });
    const grantWithoutSession = vi.fn(async () => ({ accepted: true }));

    await expect(
      trustWorkspaceHookWithReview({
        hook: workspaceHook(),
        workspacePath: "/repo",
        workspaceIdentity: "workspace:repo",
        grantWithoutSession,
      }),
    ).resolves.toEqual({
      accepted: false,
      reasonCode: "workspace_hooks_blocked_by_policy",
    });
    expect(grantWithoutSession).not.toHaveBeenCalled();
  });

  it("当前 session 无法审核且没有 workspace grant authority 时保留原拒绝", async () => {
    const sendCommand = vi.fn(async (envelope: CommandEnvelope) =>
      failed(envelope, "workspace_hooks_require_trust_capable_host"),
    );
    useWorkspaceHookReviewStore.getState().connect("session-1", {
      sessionId: "session-1",
      workspacePath: "/repo",
      workspaceIdentity: "workspace:repo",
      sendCommand,
    });

    await expect(
      trustWorkspaceHookWithReview({
        hook: workspaceHook(),
        workspacePath: "/repo",
        workspaceIdentity: "workspace:repo",
      }),
    ).resolves.toEqual({
      accepted: false,
      reasonCode: "workspace_hooks_require_trust_capable_host",
    });
  });

  it("没有 task/session 时转入 workspace grant，并携带精确 bundle/declaration digest", async () => {
    const grantWithoutSession = vi.fn(async () => ({ accepted: true }));
    await expect(
      trustWorkspaceHookWithReview({
        hook: workspaceHook(),
        workspacePath: "/repo",
        workspaceIdentity: "workspace:repo",
        grantWithoutSession,
      }),
    ).resolves.toEqual({ accepted: true });
    expect(grantWithoutSession).toHaveBeenCalledWith({
      workspacePath: "/repo",
      workspaceIdentity: "workspace:repo",
      bundleDigest: BUNDLE,
      hookDeclarationDigest: "a".repeat(64),
    });
  });

  it("既无 session binding 又无 workspace grant authority 时仍 fail closed", async () => {
    await expect(
      trustWorkspaceHookWithReview({
        hook: workspaceHook(),
        workspacePath: "/repo",
        workspaceIdentity: "workspace:repo",
      }),
    ).resolves.toEqual({
      accepted: false,
      reasonCode: "workspace_hooks_require_trust_capable_host",
    });
  });
});
