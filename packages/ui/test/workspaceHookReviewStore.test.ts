import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  findWorkspaceHookCommandBinding,
  findWorkspaceHookReviewBinding,
  useWorkspaceHookReviewStore,
  type WorkspaceHookCommandBinding,
  type WorkspaceHookReviewBinding,
} from "../src/store/workspaceHookReviewStore.js";

function binding(
  overrides: Partial<WorkspaceHookReviewBinding["request"]> = {},
): WorkspaceHookReviewBinding {
  return {
    workspacePath: "/repo",
    sendCommand: vi.fn(),
    request: {
      kind: "workspaceHookReview",
      reviewFlowId: "flow",
      generation: 1,
      interactionId: "interaction",
      sessionId: "session",
      taskId: "task",
      runId: "run",
      workspaceIdentity: "workspace:repo",
      workspaceLabel: "repo",
      bundleDigest: "a".repeat(64),
      createdAt: 1,
      deadlineAt: 2,
      sourceFiles: [],
      summary: { eventCount: 0, hookCount: 0, pendingCount: 0 },
      items: [],
      warningCode: "workspace_hooks_execute_code",
      ...overrides,
    },
  };
}

beforeEach(() => useWorkspaceHookReviewStore.setState({ bindings: {}, commandBindings: {} }));

describe("workspace Hook review renderer store", () => {
  it("rehydrates the same generation and keeps only the newest binding for a session", () => {
    const first = binding();
    const second = binding({
      generation: 2,
      interactionId: "interaction-2",
      createdAt: 2,
    });
    useWorkspaceHookReviewStore.getState().upsert("session", first);
    useWorkspaceHookReviewStore.getState().upsert("session", second);
    expect(useWorkspaceHookReviewStore.getState().bindings.session?.request.generation).toBe(2);
    expect(
      findWorkspaceHookReviewBinding(
        useWorkspaceHookReviewStore.getState().bindings,
        "/repo",
        "workspace:repo",
      )?.request.interactionId,
    ).toBe("interaction-2");
  });

  it("lets a new runtime flow replace a higher generation from the previous runtime", () => {
    useWorkspaceHookReviewStore.getState().upsert(
      "session",
      binding({
        reviewFlowId: "old-runtime-flow",
        generation: 7,
        interactionId: "old-runtime-interaction",
      }),
    );
    useWorkspaceHookReviewStore.getState().upsert(
      "session",
      binding({
        reviewFlowId: "new-runtime-flow",
        generation: 1,
        interactionId: "new-runtime-interaction",
      }),
    );

    expect(useWorkspaceHookReviewStore.getState().bindings.session?.request).toMatchObject({
      reviewFlowId: "new-runtime-flow",
      generation: 1,
      interactionId: "new-runtime-interaction",
    });
  });

  it("rejects a lower generation only within the same runtime flow", () => {
    useWorkspaceHookReviewStore
      .getState()
      .upsert("session", binding({ generation: 2, interactionId: "interaction-2" }));
    useWorkspaceHookReviewStore
      .getState()
      .upsert("session", binding({ generation: 1, interactionId: "interaction-1" }));

    expect(useWorkspaceHookReviewStore.getState().bindings.session?.request.interactionId).toBe(
      "interaction-2",
    );
  });

  it("rejects a conflicting interaction at the same generation within one runtime flow", () => {
    useWorkspaceHookReviewStore
      .getState()
      .upsert("session", binding({ generation: 2, interactionId: "interaction-authority" }));
    useWorkspaceHookReviewStore
      .getState()
      .upsert("session", binding({ generation: 2, interactionId: "interaction-conflict" }));

    expect(useWorkspaceHookReviewStore.getState().bindings.session?.request.interactionId).toBe(
      "interaction-authority",
    );
  });

  it("keeps a workspace command channel even when there is no pending review", () => {
    const firstSend = vi.fn();
    const secondSend = vi.fn();
    const first: WorkspaceHookCommandBinding = {
      sessionId: "session",
      workspacePath: "/repo",
      workspaceIdentity: "workspace:repo",
      sendCommand: firstSend,
    };
    const second = { ...first, sendCommand: secondSend };

    useWorkspaceHookReviewStore.getState().connect("session", first);
    useWorkspaceHookReviewStore.getState().connect("session", second);
    useWorkspaceHookReviewStore.getState().disconnect("session", firstSend);

    expect(
      findWorkspaceHookCommandBinding(
        useWorkspaceHookReviewStore.getState().commandBindings,
        "/repo",
        "workspace:repo",
      )?.sendCommand,
    ).toBe(secondSend);
    useWorkspaceHookReviewStore.getState().disconnect("session", secondSend);
    expect(useWorkspaceHookReviewStore.getState().commandBindings.session).toBeUndefined();
  });

  it("只允许自身无 identity 的本地 binding 使用 path fallback", () => {
    const localReview = binding({
      interactionId: "local-review",
      workspaceIdentity: "/repo",
      createdAt: 1,
    });
    const remoteReview = {
      ...binding({
        interactionId: "remote-review",
        workspaceIdentity: "remote:ssh:host-a:/repo",
        createdAt: 2,
      }),
      workspacePath: "/repo",
    };
    const reviews = { local: localReview, remote: remoteReview };

    // 本地查询没有显式 identity，仍应命中以本地 path 作为 workspaceKey 的 binding。
    expect(findWorkspaceHookReviewBinding(reviews, "/repo")?.request.interactionId).toBe(
      "local-review",
    );
    // Bug 回归：相同 path 的远程 binding 自带 identity，不能通过 path OR fallback
    // 被另一个远程 identity 或本地 Settings 误选中，否则“信任”会跨 workspace 提交。
    expect(
      findWorkspaceHookReviewBinding(reviews, "/repo", "remote:ssh:host-b:/repo"),
    ).toBeUndefined();

    const localSend = vi.fn();
    const remoteSend = vi.fn();
    const commands: Record<string, WorkspaceHookCommandBinding> = {
      local: {
        sessionId: "local",
        workspacePath: "/repo",
        sendCommand: localSend,
      },
      remote: {
        sessionId: "remote",
        workspacePath: "/repo",
        workspaceIdentity: "remote:ssh:host-a:/repo",
        sendCommand: remoteSend,
      },
    };
    expect(findWorkspaceHookCommandBinding(commands, "/repo")?.sendCommand).toBe(localSend);
    expect(
      findWorkspaceHookCommandBinding(commands, "/repo", "remote:ssh:host-b:/repo"),
    ).toBeUndefined();
  });

  it("disconnect clears only the review binding owned by the disconnected command client", () => {
    const firstSend = vi.fn();
    const secondSend = vi.fn();
    const commandBase = {
      sessionId: "session",
      workspacePath: "/repo",
      workspaceIdentity: "workspace:repo",
    };

    useWorkspaceHookReviewStore
      .getState()
      .connect("session", { ...commandBase, sendCommand: firstSend });
    useWorkspaceHookReviewStore.getState().upsert("session", {
      ...binding({ reviewFlowId: "first-flow" }),
      sendCommand: firstSend,
    });
    useWorkspaceHookReviewStore
      .getState()
      .connect("session", { ...commandBase, sendCommand: secondSend });
    useWorkspaceHookReviewStore.getState().upsert("session", {
      ...binding({ reviewFlowId: "second-flow" }),
      sendCommand: secondSend,
    });

    useWorkspaceHookReviewStore.getState().disconnect("session", firstSend);
    expect(useWorkspaceHookReviewStore.getState().bindings.session?.sendCommand).toBe(secondSend);

    useWorkspaceHookReviewStore.getState().disconnect("session", secondSend);
    expect(useWorkspaceHookReviewStore.getState().commandBindings.session).toBeUndefined();
    expect(useWorkspaceHookReviewStore.getState().bindings.session).toBeUndefined();
  });

  it("rejects a stale review effect that tries to restore a disposed command client", () => {
    const staleSend = vi.fn();
    const currentSend = vi.fn();
    useWorkspaceHookReviewStore.getState().connect("session", {
      sessionId: "session",
      workspacePath: "/repo",
      workspaceIdentity: "workspace:repo",
      sendCommand: currentSend,
    });
    useWorkspaceHookReviewStore.getState().upsert("session", {
      ...binding({ reviewFlowId: "current-flow" }),
      sendCommand: currentSend,
    });
    useWorkspaceHookReviewStore.getState().upsert("session", {
      ...binding({ reviewFlowId: "stale-flow", createdAt: 2 }),
      sendCommand: staleSend,
    });

    expect(useWorkspaceHookReviewStore.getState().bindings.session).toMatchObject({
      sendCommand: currentSend,
      request: { reviewFlowId: "current-flow" },
    });
  });

  it("stale settlement cannot clear a newer generation", () => {
    useWorkspaceHookReviewStore
      .getState()
      .upsert("session", binding({ generation: 2, interactionId: "interaction-2" }));
    useWorkspaceHookReviewStore.getState().clear("session", "interaction-1");
    expect(useWorkspaceHookReviewStore.getState().bindings.session).toBeDefined();
    useWorkspaceHookReviewStore.getState().clear("session", "interaction-2");
    expect(useWorkspaceHookReviewStore.getState().bindings.session).toBeUndefined();
  });
});
