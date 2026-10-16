import { afterEach, describe, expect, it, vi } from "vitest";
import { PluginUiPageManager, type ManagedPluginPage } from "./pluginUiPageManager.js";
const make = (key: string, task = key) => {
  let running = true,
    busy = false;
  return {
    key,
    task,
    visible: false,
    busy: () => busy,
    running: () => running,
    suspend: vi.fn(() => {
      running = false;
    }),
    destroy: vi.fn(),
    setBusy: (value: boolean) => {
      busy = value;
    },
  };
};
const pool = () =>
  new PluginUiPageManager<ManagedPluginPage>(
    (run, ms) => {
      const id = setTimeout(run, ms);
      return () => clearTimeout(id);
    },
    () => {},
  );
afterEach(() => vi.useRealTimers());
describe("MCP App page ownership", () => {
  it("keeps a visible sidebar and recycles only after continuous five-minute absence", async () => {
    vi.useFakeTimers();
    const owner = pool();
    const page = make("page");
    await owner.add(page);
    owner.visibility(page, false);
    vi.advanceTimersByTime(299_999);
    expect(page.suspend).not.toHaveBeenCalled();
    owner.visibility(page, true);
    vi.advanceTimersByTime(600_000);
    expect(page.suspend).not.toHaveBeenCalled();
    owner.visibility(page, false);
    vi.advanceTimersByTime(300_000);
    expect(page.suspend).toHaveBeenCalledOnce();
  });
  it("pins approvals and calls, then releases immediately when the deadline has passed", async () => {
    vi.useFakeTimers();
    const owner = pool();
    const page = make("page");
    await owner.add(page);
    page.setBusy(true);
    owner.visibility(page, false);
    vi.advanceTimersByTime(300_000);
    expect(page.suspend).not.toHaveBeenCalled();
    page.setBusy(false);
    owner.settled(page);
    expect(page.suspend).toHaveBeenCalledOnce();
  });
  it("evicts the least recently used eligible task and retains at most thirty tasks", async () => {
    const owner = pool();
    const first = make("first");
    await owner.add(first);
    for (let n = 1; n < 31; n++) await owner.add(make(String(n)));
    expect(first.destroy).toHaveBeenCalledOnce();
    expect(owner.get("first")).toBeUndefined();
  });
  it("rejects overflow when all 64 pages are visible or busy", async () => {
    const owner = pool();
    for (let n = 0; n < 64; n++) {
      const p = make(String(n), "task");
      p.visible = true;
      await owner.add(p);
      await owner.reserve(p);
    }
    const next = make("next", "task");
    next.suspend();
    await owner.add(next);
    await expect(owner.reserve(next)).rejects.toThrow("capacity");
  });
  it("does not allow stale visibility cleanup to mutate a replacement", async () => {
    const owner = pool();
    const a = make("same");
    await owner.add(a);
    owner.removeTask(a.task);
    const b = make("same");
    await owner.add(b);
    owner.visibility(b, true);
    owner.visibility(a, false);
    expect(b.visible).toBe(true);
  });
  it("serializes concurrent capacity reservations without exceeding 64", async () => {
    const owner = pool();
    const pages = Array.from({ length: 65 }, (_, i) => make(String(i), "task"));
    for (const page of pages) {
      page.visible = true;
      await owner.add(page);
    }
    const results = await Promise.allSettled(pages.map((page) => owner.reserve(page)));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(64);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
  });
  it("does not evict an instance when the Agent reports a newly admitted approval", async () => {
    const owner = pool();
    const first = { ...make("first"), suspend: vi.fn(async () => false) };
    await owner.add(first);
    for (let n = 1; n < 30; n++) {
      const page = make(String(n));
      page.visible = true;
      await owner.add(page);
    }
    await expect(owner.add(make("overflow"))).rejects.toThrow("capacity");
    expect(first.destroy).not.toHaveBeenCalled();
    expect(owner.get("first")).toBe(first);
  });
  it("cancels queued admission when its task is removed", async () => {
    const owner = pool();
    const page = make("late");
    const pending = owner.add(page);
    owner.removeTask(page.task);
    await expect(pending).rejects.toThrow("removed");
    expect(owner.get(page.key)).toBeUndefined();
  });
  it("does not reserve a deleted page after asynchronous recycling", async () => {
    const owner = pool();
    const entered = Promise.withResolvers<void>(),
      recycled = Promise.withResolvers<boolean>();
    const first = {
      ...make("first", "task"),
      suspend: vi.fn(() => {
        entered.resolve();
        return recycled.promise;
      }),
    };
    await owner.add(first);
    await owner.reserve(first);
    for (let n = 1; n < 64; n++) {
      const page = make(String(n), "task");
      page.visible = true;
      await owner.add(page);
      await owner.reserve(page);
    }
    const next = make("next");
    await owner.add(next);
    const pending = owner.reserve(next);
    await entered.promise;
    owner.removeTask(next.task);
    recycled.resolve(true);
    await expect(pending).rejects.toThrow("removed");
  });
});
