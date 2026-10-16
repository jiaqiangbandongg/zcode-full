import { describe, expect, it } from "vitest";
import { BrowserTabRestoreScopeRegistry } from "@/lib/browserTabRestoreScopeRegistry.js";

describe("BrowserTabRestoreScopeRegistry", () => {
  it("BTL17: cleanup 取消 in-flight attempt 后，同 scope 可以立即重试", () => {
    const registry = new BrowserTabRestoreScopeRegistry();
    const first = registry.begin("workspace-a");

    expect(first).not.toBeNull();
    expect(registry.begin("workspace-a")).toBeNull();
    registry.cancel("workspace-a", first!);

    const second = registry.begin("workspace-a");
    expect(second).not.toBeNull();
    expect(second).not.toBe(first);
  });

  it("BTL17: 旧 promise 的完成或失败不能覆盖当前 attempt", () => {
    const registry = new BrowserTabRestoreScopeRegistry();
    const first = registry.begin("workspace-a")!;
    registry.cancel("workspace-a", first);
    const second = registry.begin("workspace-a")!;

    expect(registry.complete("workspace-a", first)).toBe(false);
    registry.fail("workspace-a", first);
    expect(registry.begin("workspace-a")).toBeNull();

    expect(registry.complete("workspace-a", second)).toBe(true);
    expect(registry.begin("workspace-a")).toBeNull();
  });

  it("失败的当前 attempt 会释放 scope，completed scope 保持去重", () => {
    const registry = new BrowserTabRestoreScopeRegistry();
    const failed = registry.begin("workspace-a")!;
    registry.fail("workspace-a", failed);
    const retry = registry.begin("workspace-a")!;

    expect(registry.complete("workspace-a", retry)).toBe(true);
    expect(registry.begin("workspace-a")).toBeNull();
  });
});
