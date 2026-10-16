import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function readSource(path: string) {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

/**
 * side pane terminal 的 Windows IME 兜底契约。
 *
 * Bug 原因（2026-08-12 定位）：
 *   WorkspaceShellLayout 渲染 AnimatedSidePanePanel 时漏传 isWindowsDesktop，
 *   链路 AnimatedSidePanePanel(undefined) → SidePaneTerminalPane(默认 false)
 *   → TerminalSession.isWindowsDesktop=false → textarea 兜底
 *   (`isWindowsDesktop && (term as ...)._core?.textarea`)整段不绑定。
 *   后果：中文输入法 composition（如输入 asdf）被 Shift 中断切换英文时，
 *   xterm 对 composed text "只处理到一半"，兜底缺失导致文本丢失（asdf 没进终端）。
 *   下侧 Terminal 一直传 isWindowsDesktop=true，兜底绑定，故正常。
 *
 * 修复：WorkspaceShellLayout 给 AnimatedSidePanePanel 补传 isWindowsDesktop。
 * 本测试为回归守卫，防止再次漏传。
 */
describe("side pane terminal Windows IME 兜底契约", () => {
  it("WorkspaceShellLayout 必须把 isWindowsDesktop 传给 AnimatedSidePanePanel", () => {
    const source = readSource("packages/ui/src/app-shell/WorkspaceShellLayout.tsx");

    // 定位 AnimatedSidePanePanel 调用块（取足够长的片段覆盖其 props 区）
    const idx = source.indexOf("<AnimatedSidePanePanel");
    expect(idx).toBeGreaterThan(-1);
    const block = source.slice(idx, idx + 3000);

    // 回归守卫：禁止再漏传 isWindowsDesktop。漏传会让 textarea 兜底失效，
    // 中文 composition 被 Shift 中断时文本丢失。
    expect(block).toContain("isWindowsDesktop={isWindowsDesktop}");
  });

  it("AnimatedSidePanePanel 透传 isWindowsDesktop 给 SidePaneTerminalPane", () => {
    const source = readSource("packages/ui/src/app-shell/AnimatedSidePanePanel.tsx");

    const idx = source.indexOf("<SidePaneTerminalPane");
    expect(idx).toBeGreaterThan(-1);
    const block = source.slice(idx, idx + 800);

    expect(block).toContain("isWindowsDesktop={isWindowsDesktop}");
  });

  it("SidePaneTerminalPane 透传 isWindowsDesktop 给 TerminalSession", () => {
    const source = readSource("packages/ui/src/SidePaneTerminalPane.tsx");

    const idx = source.indexOf("<TerminalSession");
    expect(idx).toBeGreaterThan(-1);
    const block = source.slice(idx, idx + 800);

    expect(block).toContain("isWindowsDesktop={isWindowsDesktop}");
  });
});
