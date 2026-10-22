import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function readSource(path: string) {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("persistentKey 路径输入链路保活契约", () => {
  // 回归守卫：side pane terminal 切 workspace 后必须能继续输入。
  // Bug 原因：term.onData（键盘输入→PTY）曾误挂 localDisposers，cleanup(detach) 时被取消，
  // 而复用路径不重绑 → 切回 workspace 后 scrollback 在但输入失效。
  // 输入订阅生命周期必须 = entry 生命周期（registryDisposers，随 term 常驻，detach 不取消）。
  it("persistent 路径的 term.onData 挂在 registryDisposers 而非 localDisposers", () => {
    const source = readSource("packages/ui/src/terminal/TerminalSession.tsx");
    const onDataIdx = source.indexOf("term.onData(");
    expect(onDataIdx).toBeGreaterThanOrEqual(0);
    // onData 前面最近的 XxxDisposers.push( 必须是 registryDisposers，不能是 localDisposers。
    const beforeOnData = source.slice(0, onDataIdx);
    expect(beforeOnData.lastIndexOf("registryDisposers.push(")).toBeGreaterThan(
      beforeOnData.lastIndexOf("localDisposers.push("),
    );
  });

  it("persistent 路径的 Windows 输入法 textarea 兜底也挂在 registryDisposers", () => {
    const source = readSource("packages/ui/src/terminal/TerminalSession.tsx");
    // textarea 兜底的 disposer（removeEventListener）前面最近的 push 必须是 registryDisposers。
    const removeIdx = source.indexOf('removeEventListener("input", handleInput, true)');
    expect(removeIdx).toBeGreaterThanOrEqual(0);
    const beforeRemove = source.slice(0, removeIdx);
    expect(beforeRemove.lastIndexOf("registryDisposers.push(")).toBeGreaterThan(
      beforeRemove.lastIndexOf("localDisposers.push("),
    );
  });
});
