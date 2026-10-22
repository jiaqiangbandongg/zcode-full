import { describe, expect, it, vi } from "vitest";
import { createSourceServerWorkspaceService } from "#src/source-server-workspace/sourceServerWorkspaceService.js";

describe("createSourceServerWorkspaceService", () => {
  it("publishes a resolved canonical mapping before returning it to the caller", async () => {
    const order: string[] = [];
    const onResolved = vi.fn(() => {
      order.push("registered");
    });
    const service = createSourceServerWorkspaceService(
      {
        resolveCanonicalWorkspaceKey: vi.fn(async () => ({
          canonicalKey: "remote:ssh:host:22:user:/workspace",
          mergedKeys: [],
        })),
        getFailedPathCount: vi.fn(async () => 0),
        getAbandonedPathCount: vi.fn(async () => 0),
      },
      { onResolved },
    );

    const result = await service.resolveWorkspace({
      workspacePath: "/workspace",
      legacyRouteHint: "remote:ssh:host:22:user:/workspace",
    });
    order.push("returned");

    expect(onResolved).toHaveBeenCalledWith({
      workspacePath: "/workspace",
      canonicalWorkspaceKey: "remote:ssh:host:22:user:/workspace",
    });
    expect(order).toEqual(["registered", "returned"]);
    expect(result.canonicalWorkspaceKey).toBe("remote:ssh:host:22:user:/workspace");
  });
});
