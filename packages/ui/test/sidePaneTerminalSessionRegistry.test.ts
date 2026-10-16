// @vitest-environment jsdom
import type { FitAddon } from "@xterm/addon-fit";
import type { Terminal as XTerm } from "@xterm/xterm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  sidePaneTerminalSessionRegistry as registry,
  type SidePaneTerminalSessionEntry,
} from "@/terminal/sidePaneTerminalSessionRegistry.js";

/**
 * side pane terminal 跨 workspace 保活的核心契约：
 * - registry 是模块级单例，跨 workspace 常驻；
 * - attachDom/detachDom 只移动 hostEl，绝不 dispose（切换保活）；
 * - release 才真 dispose（显式关 tab 回收）；
 * - detach 后 entry 仍在，重挂可复用同一 entry（历史不丢）。
 */
function createMockEntry(
  key: string,
  cwd = "/test",
  workspaceKey = cwd,
): SidePaneTerminalSessionEntry {
  return {
    key,
    term: { dispose: vi.fn() } as unknown as XTerm,
    fitAddon: { fit: vi.fn() } as unknown as FitAddon,
    terminalId: `pty-${key}`,
    cwd,
    // workspaceKey 用于 workspace tab 关闭时按 workspace 批量回收（对称下侧 openWorkspaceKeys）。
    workspaceKey,
    hostEl: document.createElement("div"),
    dispose: vi.fn(),
  };
}

describe("sidePaneTerminalSessionRegistry", () => {
  beforeEach(() => {
    registry.clearForTest();
  });

  it("register 后可 get/has 命中", () => {
    const entry = createMockEntry("t1");
    registry.register("t1", entry);
    expect(registry.has("t1")).toBe(true);
    expect(registry.get("t1")?.term).toBe(entry.term);
  });

  it("未注册时 get/has miss", () => {
    expect(registry.has("missing")).toBe(false);
    expect(registry.get("missing")).toBeUndefined();
  });

  it("attachDom 把 hostEl 移入 host 容器", () => {
    const entry = createMockEntry("t1");
    registry.register("t1", entry);
    const host = document.createElement("div");
    registry.attachDom("t1", host);
    expect(entry.hostEl.parentElement).toBe(host);
  });

  it("attachDom 幂等：已在 host 不重复追加", () => {
    const entry = createMockEntry("t1");
    registry.register("t1", entry);
    const host = document.createElement("div");
    registry.attachDom("t1", host);
    registry.attachDom("t1", host);
    expect(host.children.length).toBe(1);
  });

  it("attachDom miss 不抛（key 未注册）", () => {
    const host = document.createElement("div");
    expect(() => registry.attachDom("missing", host)).not.toThrow();
  });

  it("detachDom 把 hostEl 移回 stashDiv", () => {
    const entry = createMockEntry("t1");
    registry.register("t1", entry);
    const host = document.createElement("div");
    registry.attachDom("t1", host);
    registry.detachDom("t1");
    expect(entry.hostEl.parentElement).not.toBe(host);
    // hostEl 应回到隐藏暂存容器
    expect(
      entry.hostEl.parentElement?.getAttribute("data-side-pane-terminal-stash"),
    ).toBe("");
  });

  it("detachDom 不删 entry —— 跨 workspace 切换保活的核心", () => {
    const entry = createMockEntry("t1");
    registry.register("t1", entry);
    registry.detachDom("t1");
    expect(registry.has("t1")).toBe(true);
    expect(registry.get("t1")?.term).toBe(entry.term);
  });

  it("detach 不 dispose（资源留存供重挂复用）", () => {
    const entry = createMockEntry("t1");
    registry.register("t1", entry);
    registry.detachDom("t1");
    expect(entry.dispose).not.toHaveBeenCalled();
  });

  it("detach 后 attach 复用同一 entry/hostEl（模拟切回 workspace）", () => {
    const entry = createMockEntry("t1");
    registry.register("t1", entry);
    const host1 = document.createElement("div");
    registry.attachDom("t1", host1);
    registry.detachDom("t1");
    const host2 = document.createElement("div");
    registry.attachDom("t1", host2);
    expect(registry.get("t1")?.hostEl).toBe(entry.hostEl);
    expect(entry.hostEl.parentElement).toBe(host2);
  });

  it("release 调 dispose + 删除 entry（显式关 tab 回收）", () => {
    const entry = createMockEntry("t1");
    registry.register("t1", entry);
    registry.release("t1");
    expect(registry.has("t1")).toBe(false);
    expect(entry.dispose).toHaveBeenCalledTimes(1);
  });

  it("release 后 hostEl 从 DOM 移除", () => {
    const entry = createMockEntry("t1");
    registry.register("t1", entry);
    const host = document.createElement("div");
    registry.attachDom("t1", host);
    registry.release("t1");
    expect(entry.hostEl.parentElement).toBeNull();
  });

  it("release 未注册的 key 安全（不抛）", () => {
    expect(() => registry.release("missing")).not.toThrow();
  });

  it("releaseByPredicate 批量回收命中的 entry（workspace 关闭回收）", () => {
    // 对称 WorkspaceShellLayout 的 openWorkspaceKeys 回收：entry 带 workspaceKey，
    // workspace 关闭时按 workspaceKey 过滤回收，其它 workspace 的 session 保留保活。
    const e1 = createMockEntry("t1", "/ws-a", "ws-a");
    const e2 = createMockEntry("t2", "/ws-b", "ws-b");
    const e3 = createMockEntry("t3", "/ws-a", "ws-a");
    registry.register("t1", e1);
    registry.register("t2", e2);
    registry.register("t3", e3);
    // 模拟关闭 workspace A：只保留 ws-b
    const retained = new Set(["ws-b"]);
    registry.releaseByPredicate(
      (entry) => Boolean(entry.workspaceKey) && !retained.has(entry.workspaceKey),
    );
    expect(registry.has("t1")).toBe(false);
    expect(registry.has("t3")).toBe(false);
    expect(registry.has("t2")).toBe(true);
    expect(e1.dispose).toHaveBeenCalledTimes(1);
    expect(e3.dispose).toHaveBeenCalledTimes(1);
    expect(e2.dispose).not.toHaveBeenCalled();
  });

  it("clearForTest 清空所有 session", () => {
    registry.register("t1", createMockEntry("t1"));
    registry.register("t2", createMockEntry("t2"));
    registry.clearForTest();
    expect(registry.has("t1")).toBe(false);
    expect(registry.has("t2")).toBe(false);
  });
});
