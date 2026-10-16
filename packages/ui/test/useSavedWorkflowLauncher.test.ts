// @vitest-environment jsdom
// 中枢直接启动器（docs/dynamic-workflow/launch.md「The launcher」）：createSession → startSavedWorkflow
// 顺序与 payload；accepted → 导航；rejected → deleteSession 回收 + 结构化错误；createSession 失败不发 start。
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CommandAck, CommandEnvelope } from "@zcode/shared/zcode-protocol-v4";

const sendCommand = vi.fn<[CommandEnvelope], Promise<CommandAck>>();
const release = vi.fn();
const acquireWorkspaceConnection = vi.fn(() => ({
  transport: { sendCommand },
  layer: {},
  activateRemoteService: () => {},
  release,
}));
vi.mock("@/v4/workspaceConnectionRegistry.js", () => ({
  acquireWorkspaceConnection: (...args: unknown[]) =>
    (acquireWorkspaceConnection as (...a: unknown[]) => unknown)(...args),
  LOCAL_WORKSPACE_CONNECTION_ENDPOINT: "__base__",
}));

const { useSavedWorkflowLauncher } =
  await import("@/settings/saved-workflows/useSavedWorkflowLauncher.js");

function ack(partial: Partial<CommandAck>): CommandAck {
  return { commandId: "c", status: "accepted", revisionAtDecision: 0, ...partial };
}

const agentService = {} as never;

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("useSavedWorkflowLauncher", () => {
  it("accepted：先 createSession 后 startSavedWorkflow，payload 正确，导航到新会话并返回 ok", async () => {
    sendCommand
      .mockResolvedValueOnce(ack({ result: { type: "createSession", sessionId: "s-1" } as never }))
      .mockResolvedValueOnce(
        ack({
          result: { type: "startSavedWorkflow", runId: "r-1", toolCallId: "launch-1" } as never,
        }),
      );
    const onNavigate = vi.fn();
    const { result } = renderHook(() => useSavedWorkflowLauncher({ agentService, onNavigate }));

    let launched: Awaited<ReturnType<typeof result.current.launch>> | undefined;
    await act(async () => {
      launched = await result.current.launch(
        { workspacePath: "/beta" },
        { name: "wf", scope: "project", args: { a: 1 } },
      );
    });

    expect(sendCommand).toHaveBeenCalledTimes(2);
    const createEnvelope = sendCommand.mock.calls[0]![0];
    expect(createEnvelope.type).toBe("createSession");
    expect(createEnvelope.sessionId).toBeNull();
    expect(createEnvelope.payload).toEqual({ workspaceId: "/beta" });
    const startEnvelope = sendCommand.mock.calls[1]![0];
    expect(startEnvelope.type).toBe("startSavedWorkflow");
    expect(startEnvelope.sessionId).toBe("s-1");
    expect(startEnvelope.payload).toEqual({ name: "wf", scope: "project", args: { a: 1 } });

    expect(onNavigate).toHaveBeenCalledWith({ workspacePath: "/beta" }, "s-1");
    expect(launched).toEqual({ ok: true, sessionId: "s-1", runId: "r-1", toolCallId: "launch-1" });
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("无实参不带 args 键；workspaceId 取 identity 优先", async () => {
    sendCommand
      .mockResolvedValueOnce(ack({ result: { type: "createSession", sessionId: "s-2" } as never }))
      .mockResolvedValueOnce(
        ack({
          result: { type: "startSavedWorkflow", runId: "r-2", toolCallId: "launch-2" } as never,
        }),
      );
    const { result } = renderHook(() =>
      useSavedWorkflowLauncher({ agentService, onNavigate: vi.fn() }),
    );
    await act(async () => {
      await result.current.launch(
        { workspacePath: "/beta", workspaceIdentity: "remote:dev:/beta" },
        { name: "wf", scope: "global", args: {} },
      );
    });
    expect(sendCommand.mock.calls[0]![0].payload).toEqual({ workspaceId: "remote:dev:/beta" });
    expect(sendCommand.mock.calls[1]![0].payload).toEqual({ name: "wf", scope: "global" });
  });

  it("startSavedWorkflow 被拒：deleteSession 回收空会话，返回映射后的错误，不导航", async () => {
    sendCommand
      .mockResolvedValueOnce(ack({ result: { type: "createSession", sessionId: "s-3" } as never }))
      .mockResolvedValueOnce(
        ack({
          status: "rejected",
          reasonCode: "fault.command.savedWorkflowStartRejected.compile_failed",
          message: "line 3: boom",
        }),
      )
      .mockResolvedValueOnce(ack({ status: "noop" }));
    const onNavigate = vi.fn();
    const { result } = renderHook(() => useSavedWorkflowLauncher({ agentService, onNavigate }));

    let launched: Awaited<ReturnType<typeof result.current.launch>> | undefined;
    await act(async () => {
      launched = await result.current.launch(
        { workspacePath: "/beta" },
        { name: "wf", scope: "project", args: {} },
      );
    });

    expect(sendCommand).toHaveBeenCalledTimes(3);
    const deleteEnvelope = sendCommand.mock.calls[2]![0];
    expect(deleteEnvelope.type).toBe("deleteSession");
    expect(deleteEnvelope.sessionId).toBe("s-3");
    expect(onNavigate).not.toHaveBeenCalled();
    expect(launched).toEqual({
      ok: false,
      error: {
        reason: "compile_failed",
        code: "fault.command.savedWorkflowStartRejected.compile_failed",
        message: "line 3: boom",
      },
    });
  });

  it("能力缺席 → unsupported 错误", async () => {
    sendCommand
      .mockResolvedValueOnce(ack({ result: { type: "createSession", sessionId: "s-4" } as never }))
      .mockResolvedValueOnce(
        ack({ status: "rejected", reasonCode: "fault.command.capabilityUnsupported" }),
      )
      .mockResolvedValueOnce(ack({ status: "noop" }));
    const { result } = renderHook(() =>
      useSavedWorkflowLauncher({ agentService, onNavigate: vi.fn() }),
    );
    let launched: Awaited<ReturnType<typeof result.current.launch>> | undefined;
    await act(async () => {
      launched = await result.current.launch(
        { workspacePath: "/beta" },
        { name: "wf", scope: "project", args: {} },
      );
    });
    expect(launched?.ok).toBe(false);
    expect(launched && !launched.ok && launched.error.reason).toBe("unsupported");
  });

  it("createSession 失败：不发 start、不回收，返回 generic 错误", async () => {
    sendCommand.mockResolvedValueOnce(ack({ status: "rejected", reasonCode: "boom" }));
    const onNavigate = vi.fn();
    const { result } = renderHook(() => useSavedWorkflowLauncher({ agentService, onNavigate }));

    let launched: Awaited<ReturnType<typeof result.current.launch>> | undefined;
    await act(async () => {
      launched = await result.current.launch(
        { workspacePath: "/beta" },
        { name: "wf", scope: "project", args: {} },
      );
    });

    expect(sendCommand).toHaveBeenCalledTimes(1);
    expect(onNavigate).not.toHaveBeenCalled();
    expect(launched?.ok).toBe(false);
    expect(launched && !launched.ok && launched.error.reason).toBe("generic");
    expect(release).toHaveBeenCalledTimes(1);
  });
});
