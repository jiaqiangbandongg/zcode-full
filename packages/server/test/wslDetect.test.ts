import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  WSL_DISCOVERY_CACHE_TTL_MS,
  invalidateWSLDiscoveryCache,
  isWSLAvailable,
  listWSLDistros,
} from "../src/remote/wsl-detect.js";

describe("WSL discovery cache", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    invalidateWSLDiscoveryCache();
  });

  afterEach(() => {
    invalidateWSLDiscoveryCache();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("single-flights status discovery and refreshes after five seconds", async () => {
    const executor = vi.fn(async () => Buffer.from("ok"));

    const first = isWSLAvailable(executor);
    const second = isWSLAvailable(executor);
    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    expect(executor).toHaveBeenCalledOnce();

    vi.advanceTimersByTime(WSL_DISCOVERY_CACHE_TTL_MS - 1);
    await expect(isWSLAvailable(executor)).resolves.toBe(true);
    expect(executor).toHaveBeenCalledOnce();

    vi.advanceTimersByTime(1);
    await expect(isWSLAvailable(executor)).resolves.toBe(true);
    expect(executor).toHaveBeenCalledTimes(2);
  });

  it("does not retain a rejected distro-list promise", async () => {
    const executor = vi
      .fn<() => Promise<Buffer>>()
      .mockRejectedValueOnce(new Error("temporary failure"))
      .mockResolvedValueOnce(Buffer.from("  NAME      STATE      VERSION\n* Ubuntu   Running    2\n"));

    await expect(listWSLDistros(executor)).rejects.toThrow("temporary failure");
    await expect(listWSLDistros(executor)).resolves.toEqual([
      { name: "Ubuntu", isDefault: true, state: "Running", version: 2 },
    ]);
    expect(executor).toHaveBeenCalledTimes(2);
  });
});
