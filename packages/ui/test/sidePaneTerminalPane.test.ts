import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function readSource(path: string) {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("SidePaneTerminalPane", () => {
  it("uses a single terminal session without nesting terminal tabs", () => {
    const source = readSource("packages/ui/src/SidePaneTerminalPane.tsx");

    expect(source).toContain('from "@/terminal/TerminalSession.js"');
    expect(source).toContain("<TerminalSession");
    expect(source).not.toContain('from "@/Terminal.js"');
    expect(source).not.toContain("<Terminal ");
  });

  it("sessionId 走 prop（= tab.id）并透传 persistentKey，不再 useState(createUuid)", () => {
    // 保活契约：sessionId 必须复用 tab.id（跨 workspace 稳定），并作为 TerminalSession 的 persistentKey，
    // 让 xterm+PTY 所有权进 sidePaneTerminalSessionRegistry。详见 docs/side-pane-terminal-session-keepalive.md。
    // 回归守卫：禁止重新引入 useState(() => createUuid())——那会让每次重挂生成新 sessionId、新 PTY，历史全丢。
    const source = readSource("packages/ui/src/SidePaneTerminalPane.tsx");

    // sessionId 必须是 prop，不能组件内部随机生成
    expect(source).not.toContain("createUuid");
    expect(source).not.toContain("useState");
    // 透传 persistentKey={sessionId}，触发 TerminalSession 的 registry 保活路径
    expect(source).toContain("persistentKey={sessionId}");
  });
});
