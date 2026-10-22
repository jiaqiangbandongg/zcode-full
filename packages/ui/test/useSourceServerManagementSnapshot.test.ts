// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { Emitter } from "@zcode/rpc";
import type { SourceServerManagementSnapshot } from "@zcode/shared";
import { describe, expect, it, vi } from "vitest";
import { useSourceServerManagementSnapshot } from "@/hooks/useSourceServerManagementSnapshot.js";

function snapshot(
  generation: number,
  displayName: string,
): SourceServerManagementSnapshot {
  return {
    generation,
    profiles: [],
    servers: [
      {
        sourceServerId: "3cd4f9da-cd79-426c-9d70-75f36e9f6a87",
        displayName,
        declaredWorkspaces: [],
      },
    ],
    workspaceHistory: [],
    states: [],
    failedPathCount: 0,
    abandonedPathCount: 0,
    migrationCounts: [],
  };
}

describe("useSourceServerManagementSnapshot", () => {
  it("在途期间的显式刷新不会被目录事件覆盖成仅缓存读取", async () => {
    const stateEmitter = new Emitter<{ generation: number; state: never }>();
    const directoryEmitter = new Emitter<{ generation: number }>();
    let complete!: (value: SourceServerManagementSnapshot) => void;
    const getSnapshot = vi.fn()
      .mockImplementationOnce(() => new Promise<SourceServerManagementSnapshot>((resolve) => { complete = resolve; }))
      .mockResolvedValue(snapshot(2, "fresh"));
    const management = {
      getSnapshot, onDidChangeState: stateEmitter.event, onDidChangeDirectory: directoryEmitter.event,
    } as never;
    const { result, unmount } = renderHook(() => useSourceServerManagementSnapshot(management));
    act(() => { result.current.refresh(); directoryEmitter.fire({ generation: 1 }); });
    expect(getSnapshot).toHaveBeenCalledOnce();
    await act(async () => complete(snapshot(1, "initial")));
    await waitFor(() => expect(result.current.snapshot?.generation).toBe(2));
    expect(getSnapshot).toHaveBeenNthCalledWith(2, { refreshMigrationCounts: true });
    act(() => directoryEmitter.fire({ generation: 2 }));
    await waitFor(() => expect(getSnapshot).toHaveBeenCalledTimes(3));
    expect(getSnapshot).toHaveBeenLastCalledWith({ refreshMigrationCounts: false });
    unmount();
  });

  it("refreshes from both state and directory deltas and drops stale generations", async () => {
    const stateEmitter = new Emitter<{ generation: number; state: never }>();
    const directoryEmitter = new Emitter<{ generation: number }>();
    const getSnapshot = vi
      .fn()
      .mockResolvedValueOnce(snapshot(1, "A"))
      .mockResolvedValueOnce(snapshot(2, "B"))
      .mockResolvedValueOnce(snapshot(1, "stale"));
    const management = {
      getSnapshot,
      onDidChangeState: stateEmitter.event,
      onDidChangeDirectory: directoryEmitter.event,
    } as never;

    const { result } = renderHook(() =>
      useSourceServerManagementSnapshot(management),
    );
    await waitFor(() =>
      expect(result.current.snapshot?.servers[0]?.displayName).toBe("A"),
    );
    expect(getSnapshot).toHaveBeenNthCalledWith(1, { refreshMigrationCounts: true });

    act(() => directoryEmitter.fire({ generation: 2 }));
    await waitFor(() =>
      expect(result.current.snapshot?.servers[0]?.displayName).toBe("B"),
    );

    act(() => stateEmitter.fire({ generation: 3, state: {} as never }));
    await waitFor(() => expect(getSnapshot).toHaveBeenCalledTimes(3));
    expect(result.current.snapshot?.servers[0]?.displayName).toBe("B");
    expect(getSnapshot).toHaveBeenNthCalledWith(2, { refreshMigrationCounts: false });
    expect(getSnapshot).toHaveBeenNthCalledWith(3, { refreshMigrationCounts: false });
    getSnapshot.mockResolvedValue(snapshot(4, "fresh"));
    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.snapshot?.servers[0]?.displayName).toBe("fresh"));
    expect(getSnapshot).toHaveBeenLastCalledWith({ refreshMigrationCounts: true });
  });
});
