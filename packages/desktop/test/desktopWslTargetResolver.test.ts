import { describe, expect, it, vi } from "vitest";
import { createCanonicalWslTargetResolver } from "../src/main/desktopWslTargetResolver.js";

describe("desktopWslTargetResolver", () => {
  it("shares concurrent provisional resolution and returns the backend identity", async () => {
    const resolveIdentity = vi.fn(async () => ({ distro: "Ubuntu", user: "dev" }));
    const dispose = vi.fn();
    const createBackend = vi.fn(() => ({ resolveIdentity, dispose }));
    const resolveTarget = createCanonicalWslTargetResolver({ createBackend, ttlMs: 5_000 });
    const requested = { kind: "wsl" as const, distro: " ubuntu " };

    const [first, second] = await Promise.all([
      resolveTarget(requested),
      resolveTarget(requested),
    ]);

    expect(first).toEqual({ kind: "wsl", distro: "Ubuntu", user: "dev" });
    expect(second).toEqual(first);
    expect(createBackend).toHaveBeenCalledOnce();
    expect(resolveIdentity).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("does not retain a rejected identity resolution", async () => {
    const createBackend = vi
      .fn()
      .mockReturnValueOnce({
        resolveIdentity: vi.fn(async () => Promise.reject(new Error("temporary discovery error"))),
        dispose: vi.fn(),
      })
      .mockReturnValueOnce({
        resolveIdentity: vi.fn(async () => ({ distro: "Ubuntu", user: "dev" })),
        dispose: vi.fn(),
      });
    const resolveTarget = createCanonicalWslTargetResolver({ createBackend, ttlMs: 5_000 });

    await expect(resolveTarget({ kind: "wsl" })).rejects.toThrow("temporary discovery error");
    await expect(resolveTarget({ kind: "wsl" })).resolves.toEqual({
      kind: "wsl",
      distro: "Ubuntu",
      user: "dev",
    });
    expect(createBackend).toHaveBeenCalledTimes(2);
  });
});
