import { describe, expect, it, vi } from "vitest";
import type { WorkspaceHookReviewRequestPayload } from "@zcode/shared/zcode-protocol-v4";
import {
  WorkspaceHookReviewFlowRegistry,
  type WorkspaceHookReviewTarget,
} from "../src/hooks/index.js";

function request(generation = 1): WorkspaceHookReviewRequestPayload {
  return {
    kind: "workspaceHookReview",
    reviewFlowId: "flow-1",
    generation,
    interactionId: `interaction-${generation}`,
    sessionId: "session-1",
    taskId: "session-1",
    runId: "run-1",
    workspaceIdentity: "local:/workspace",
    workspaceLabel: "workspace",
    bundleDigest: generation === 1 ? "a".repeat(64) : "b".repeat(64),
    createdAt: generation * 1_000,
    deadlineAt: generation * 1_000 + 10_000,
    sourceFiles: [
      {
        path: "/workspace/.zcode/config.json",
        displayPath: ".zcode/config.json",
        editable: true,
      },
    ],
    summary: { eventCount: 1, hookCount: 1, pendingCount: 1 },
    items: [
      {
        reviewItemId: "item-0",
        event: "SessionStart",
        matcher: "startup",
        type: "command",
        displayName: "SessionStart · startup",
        displayCommand: "echo project",
        sourcePath: ".zcode/config.json",
        resolvedTimeoutMs: 60_000,
        resolvedMaxOutputBytes: 32_768,
        executionMode: "foreground",
        configuredEnabled: true,
        editable: true,
        trustState: "pending_trust",
      },
    ],
    warningCode: "workspace_hooks_execute_code",
  };
}

function target(value: WorkspaceHookReviewRequestPayload): WorkspaceHookReviewTarget {
  return {
    sessionId: value.sessionId,
    taskId: value.taskId,
    runId: value.runId,
    ...(value.remoteSessionId ? { remoteSessionId: value.remoteSessionId } : {}),
    workspaceIdentity: value.workspaceIdentity,
    bundleDigest: value.bundleDigest,
    reviewFlowId: value.reviewFlowId,
    generation: value.generation,
    interactionId: value.interactionId,
  };
}

describe("WorkspaceHookReviewFlowRegistry", () => {
  it("复用相同 bundle 的 pending generation，关闭呈现不会隐式 resolve", async () => {
    const registry = new WorkspaceHookReviewFlowRegistry();
    const first = registry.open(request());
    const second = registry.open(request());

    expect(second).toBe(first);
    expect(registry.getCurrent("session-1")?.state).toBe("pending");

    const pending = Promise.race([
      first.result.then(() => "resolved"),
      Promise.resolve("still-pending"),
    ]);
    await expect(pending).resolves.toBe("still-pending");
  });

  it("只接受 current generation 的第一份有效 decision", async () => {
    const registry = new WorkspaceHookReviewFlowRegistry();
    const flow = registry.open(request());

    expect(
      registry.resolve(target(flow.request), {
        action: "trust_selected",
        reviewItemIds: ["item-0"],
      }),
    ).toEqual({ accepted: true, reviewItemIds: ["item-0"] });
    expect(
      registry.resolve(target(flow.request), {
        action: "trust_selected",
        reviewItemIds: ["item-0"],
      }),
    ).toEqual({
      accepted: false,
      reasonCode: "workspace_hooks_review_superseded",
    });
    await expect(flow.result).resolves.toEqual({
      action: "trust_selected",
      reviewItemIds: ["item-0"],
      reasonCode: undefined,
    });
  });

  it("supersede 后旧 generation 永不再接受 response", () => {
    const registry = new WorkspaceHookReviewFlowRegistry();
    const first = registry.open(request());
    const second = registry.supersede(target(first.request), request(2));

    expect(first.state.state).toBe("superseded");
    expect(first.state.supersededByInteractionId).toBe(second.request.interactionId);
    expect(
      registry.resolve(target(first.request), {
        action: "trust_selected",
        reviewItemIds: ["item-0"],
      }),
    ).toEqual({
      accepted: false,
      reasonCode: "workspace_hooks_review_superseded",
    });
    expect(registry.getCurrent("session-1")?.interactionId).toBe("interaction-2");
  });

  it("独立 deadline 到期只使快照过期，不产生任何用户 Trust decision", async () => {
    vi.useFakeTimers();
    try {
      const registry = new WorkspaceHookReviewFlowRegistry();
      const flow = registry.open(request());
      await vi.advanceTimersByTimeAsync(10_001);

      await expect(flow.result).resolves.toEqual({
        action: "no_change",
        reviewItemIds: [],
        reasonCode: "workspace_hooks_interaction_timeout",
      });
      expect(registry.getCurrent("session-1")?.state).toBe("timed_out");
    } finally {
      vi.useRealTimers();
    }
  });

  it("workspace/bundle/interaction target 任一不匹配均 fail closed", () => {
    const registry = new WorkspaceHookReviewFlowRegistry();
    const flow = registry.open(request());

    expect(
      registry.resolve(
        { ...target(flow.request), bundleDigest: "f".repeat(64) },
        {
          action: "trust_selected",
          reviewItemIds: ["item-0"],
        },
      ),
    ).toEqual({
      accepted: false,
      reasonCode: "workspace_hooks_snapshot_mismatch",
    });
    expect(registry.getCurrent("session-1")?.state).toBe("pending");
  });
  it("拒绝 wrong task、stale run 与 remoteSession route mismatch", () => {
    const registry = new WorkspaceHookReviewFlowRegistry();
    const remoteRequest = { ...request(), remoteSessionId: "remote-1" };
    const flow = registry.open(remoteRequest);
    const decision = { action: "trust_selected", reviewItemIds: ["item-0"] } as const;

    expect(registry.resolve({ ...target(flow.request), taskId: "wrong-task" }, decision)).toEqual({
      accepted: false,
      reasonCode: "workspace_hooks_snapshot_mismatch",
    });
    expect(registry.resolve({ ...target(flow.request), runId: "stale-run" }, decision)).toEqual({
      accepted: false,
      reasonCode: "workspace_hooks_snapshot_mismatch",
    });
    expect(
      registry.resolve({ ...target(flow.request), remoteSessionId: "remote-2" }, decision),
    ).toEqual({
      accepted: false,
      reasonCode: "workspace_hooks_snapshot_mismatch",
    });
    expect(registry.getCurrent("session-1")?.state).toBe("pending");
  });

});
