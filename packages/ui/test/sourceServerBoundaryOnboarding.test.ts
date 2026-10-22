import { describe, expect, it, vi } from "vitest";
import { ensureSourceServerBoundaryAcknowledged } from "@/lib/sourceServerBoundaryOnboarding.js";

describe("Source Server boundary onboarding", () => {
  it("does not mark read after the originating intent expires during acknowledgement", async () => {
    let current = true;
    const persistVersion = vi.fn();
    await ensureSourceServerBoundaryAcknowledged({
      currentVersion: undefined,
      targetVersion: 1,
      isCurrent: () => current,
      requestAcknowledgement: async () => {
        current = false;
        return true;
      },
      persistVersion,
    });
    expect(persistVersion).not.toHaveBeenCalled();
  });
  it("persists the version only after the user acknowledges the boundary", async () => {
    const update = vi.fn(async () => undefined);

    await expect(
      ensureSourceServerBoundaryAcknowledged({
        currentVersion: undefined,
        targetVersion: 1,
        requestAcknowledgement: async () => false,
        persistVersion: update,
      }),
    ).resolves.toBe(false);
    expect(update).not.toHaveBeenCalled();

    await expect(
      ensureSourceServerBoundaryAcknowledged({
        currentVersion: undefined,
        targetVersion: 1,
        requestAcknowledgement: async () => true,
        persistVersion: update,
      }),
    ).resolves.toBe(true);
    expect(update).toHaveBeenCalledWith(1);
  });

  it("does not ask again after the same version was acknowledged", async () => {
    const requestAcknowledgement = vi.fn(async () => true);
    const persistVersion = vi.fn(async () => undefined);

    await expect(
      ensureSourceServerBoundaryAcknowledged({
        currentVersion: 1,
        targetVersion: 1,
        requestAcknowledgement,
        persistVersion,
      }),
    ).resolves.toBe(false);
    expect(requestAcknowledgement).not.toHaveBeenCalled();
    expect(persistVersion).not.toHaveBeenCalled();
  });
});
