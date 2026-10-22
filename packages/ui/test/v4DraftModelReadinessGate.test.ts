// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { Emitter } from "@zcode/rpc";
import type { IModelSelectionService, ModelSelectionView } from "@zcode/services";
import { describe, expect, it, vi } from "vitest";
import { useDraftModelReadinessGate } from "@/v4/composer/useDraftModelReadinessGate.js";

function selectionView(revision: number, withModel: boolean): ModelSelectionView {
  return {
    revision,
    providers: withModel
      ? [
          {
            providerId: "provider-a",
            config: { kind: "api" },
            models: [{ modelId: "model-a", config: {} }],
          },
        ]
      : [],
  };
}

function selectionService(params: {
  getView: () => Promise<ModelSelectionView>;
  emitter?: Emitter<ModelSelectionView>;
}): Pick<IModelSelectionService, "getView" | "onDidChange"> {
  const emitter = params.emitter ?? new Emitter<ModelSelectionView>();
  return {
    getView: params.getView,
    onDidChange: emitter.event,
  };
}

describe("draft model readiness gate", () => {
  it("进入新草稿的每一帧都先检查模型，不继承正式会话的 ready", async () => {
    const pending: Array<(view: ModelSelectionView) => void> = [];
    const service = selectionService({
      getView: () => new Promise((resolve) => pending.push(resolve)),
    });
    const observations: boolean[] = [];
    const { result, rerender } = renderHook(
      ({ sessionId }: { sessionId: string | null }) => {
        const gate = useDraftModelReadinessGate({
          workspacePath: "/workspace/app",
          sessionId,
          modelSelectionService: service,
        });
        if (sessionId === null) observations.push(gate.agentStartupAllowed);
        return gate;
      },
      { initialProps: { sessionId: "active" as string | null } },
    );

    rerender({ sessionId: null });
    expect(observations.length).toBeGreaterThan(0);
    expect(observations.every((allowed) => !allowed)).toBe(true);
    await act(async () => pending[0]!(selectionView(1, true)));
    expect(result.current.agentStartupAllowed).toBe(true);
    rerender({ sessionId: "active-again" });
    observations.length = 0;
    rerender({ sessionId: null });
    expect(observations.every((allowed) => !allowed)).toBe(true);
    await act(async () => pending[1]!(selectionView(2, true)));
    expect(result.current.agentStartupAllowed).toBe(true);
  });

  it("旧草稿发送复查的迟到结果不覆盖新草稿的 ready", async () => {
    let resolveOld!: (view: ModelSelectionView) => void;
    const getView = vi.fn(async () => selectionView(1, true));
    const service = selectionService({ getView });
    const { result, rerender } = renderHook(
      ({ sessionId }: { sessionId: string | null }) =>
        useDraftModelReadinessGate({
          workspacePath: "/workspace/app",
          sessionId,
          modelSelectionService: service,
        }),
      { initialProps: { sessionId: null as string | null } },
    );
    await waitFor(() => expect(result.current.agentStartupAllowed).toBe(true));
    getView.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve;
        }),
    );
    const oldSend = result.current.ensureReadyForSend();
    rerender({ sessionId: "active" });
    rerender({ sessionId: null });
    await waitFor(() => expect(result.current.agentStartupAllowed).toBe(true));
    await act(async () => {
      resolveOld(selectionView(2, false));
      await oldSend;
    });
    expect(result.current.agentStartupAllowed).toBe(true);
    expect(result.current.error).toBeNull();
  });

  it("blocks a new draft when the Selection View confirms there are no models", async () => {
    const service = selectionService({ getView: vi.fn(async () => selectionView(1, false)) });
    const { result } = renderHook(() =>
      useDraftModelReadinessGate({
        workspacePath: "/workspace/app",
        sessionId: null,
        modelSelectionService: service,
      }),
    );

    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.agentStartupAllowed).toBe(false);
    await expect(result.current.ensureReadyForSend()).resolves.toBe(false);
  });

  it("does not let a stale initial read overwrite a newer Selection event", async () => {
    const emitter = new Emitter<ModelSelectionView>();
    let resolveInitial!: (view: ModelSelectionView) => void;
    const initial = new Promise<ModelSelectionView>((resolve) => {
      resolveInitial = resolve;
    });
    const service = selectionService({ getView: vi.fn(() => initial), emitter });
    const { result } = renderHook(() =>
      useDraftModelReadinessGate({
        workspacePath: "/workspace/app",
        sessionId: null,
        modelSelectionService: service,
      }),
    );

    act(() => emitter.fire(selectionView(2, true)));
    await waitFor(() => expect(result.current.agentStartupAllowed).toBe(true));
    await act(async () => resolveInitial(selectionView(1, false)));
    expect(result.current.agentStartupAllowed).toBe(true);
    expect(result.current.error).toBeNull();
  });

  it("leaves the Host admission gate in charge when Selection View reading fails", async () => {
    const service = selectionService({
      getView: vi.fn(async () => {
        throw new Error("registry unavailable");
      }),
    });
    const { result } = renderHook(() =>
      useDraftModelReadinessGate({
        workspacePath: "/workspace/app",
        sessionId: null,
        modelSelectionService: service,
      }),
    );

    await waitFor(() => expect(result.current.agentStartupAllowed).toBe(true));
    expect(result.current.error).toBeNull();
  });
});
