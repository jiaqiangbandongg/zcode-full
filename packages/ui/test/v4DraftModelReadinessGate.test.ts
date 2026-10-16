// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { Emitter } from "@zcode/rpc";
import type { IModelSelectionService, ModelSelectionView } from "@zcode/services";
import { describe, expect, it, vi } from "vitest";
import {
  resolveModelSelectionReadinessStatus,
  useDraftModelReadinessGate,
} from "@/v4/composer/useDraftModelReadinessGate.js";

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
  it("uses published Model Selection candidates as the only readiness fact", () => {
    expect(resolveModelSelectionReadinessStatus(selectionView(1, false))).toBe("missing");
    expect(resolveModelSelectionReadinessStatus(selectionView(2, true))).toBe("ready");
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
