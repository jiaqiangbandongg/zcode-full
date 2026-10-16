import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function readSource(path: string) {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

/**
 * side pane terminal persistent profile theme 跨重挂保活契约（CR-01 Critical）。
 *
 * Bug 原因：
 *   terminalService.create() 返回的 profile theme（用户终端配置的颜色）只写入
 *   组件局部 terminalProfileThemeRef（TerminalSession.tsx:565）。registry entry 不保存它。
 *   组件卸载后 ref 销毁；重挂时新组件 ref 被重置为 undefined（line 340），复用路径
 *   reuseThemeObserver 用 mergeTerminalTheme(terminalProfileThemeRef.current) =
 *   mergeTerminalTheme(undefined) = 基础主题，丢掉 profile theme。
 *   触发条件：终端服务返回自定义 theme + 用户切到其他 workspace 再切回 + 之后切换
 *   浅色/深色主题（documentElement.class 变化触发 observer）。
 *   后果：终端颜色与用户配置不一致，前景/背景/ANSI 配色可读性下降，持续到关闭重建 tab。
 *
 * 修复（CR-01 建议）：profile theme 所有权上移到 registry entry（与 term/PTY 同一常驻所有者）。
 *   entry 承载 profileTheme，首次创建写入 entry.profileTheme，重挂 observer 从 entry 读取。
 *   与 CR-01 的精神一致：本 MR 核心承诺是同一个 xterm/PTY 跨组件生命周期复用，
 *   与终端实例关联的 profile theme 也必须由同一常驻所有者保存。
 */
describe("side pane terminal persistent profile theme 跨重挂保活契约", () => {
  it("registry entry 必须承载 profileTheme 字段", () => {
    const source = readSource("packages/ui/src/terminal/sidePaneTerminalSessionRegistry.ts");

    // entry 接口含 profileTheme，否则 profile theme 只活在组件局部 ref，重挂丢失。
    expect(source).toContain("profileTheme");
  });

  it("首次创建时 create 返回的 theme 必须写入 entry.profileTheme", () => {
    const source = readSource("packages/ui/src/terminal/TerminalSession.tsx");

    const idx = source.indexOf("terminalProfileThemeRef.current = theme");
    expect(idx).toBeGreaterThan(-1);
    const block = source.slice(idx, idx + 400);

    // 必须同步写入 entry.profileTheme，让 profile theme 所有权上移到 registry entry。
    expect(block).toContain("entry.profileTheme");
  });

  it("复用路径 observer 必须从 entry.profileTheme 读取，不能用组件局部 ref", () => {
    const source = readSource("packages/ui/src/terminal/TerminalSession.tsx");

    const idx = source.indexOf("reuseThemeObserver");
    expect(idx).toBeGreaterThan(-1);
    // 取 observer 回调块（到闭合 });）
    const blockEnd = source.indexOf("});", idx);
    expect(blockEnd).toBeGreaterThan(idx);
    const block = source.slice(idx, blockEnd);

    // 必须用 existingEntry.profileTheme；用 terminalProfileThemeRef.current 会在重挂后丢 profile theme。
    expect(block).toContain("existingEntry.profileTheme");
    expect(block).not.toContain("terminalProfileThemeRef.current");
  });

  it("首次创建路径 observer 也必须从 entry.profileTheme 读取（统一常驻所有者）", () => {
    const source = readSource("packages/ui/src/terminal/TerminalSession.tsx");

    // 定位首次创建路径的 themeObserver（区别于复用路径的 reuseThemeObserver）
    const idx = source.indexOf("const themeObserver = new MutationObserver");
    expect(idx).toBeGreaterThan(-1);
    const blockEnd = source.indexOf("});", idx);
    expect(blockEnd).toBeGreaterThan(idx);
    const block = source.slice(idx, blockEnd);

    // 首次创建 observer 也应从 entry 读取，统一 profile theme 的单一数据源。
    expect(block).toContain("entry.profileTheme");
  });
});
