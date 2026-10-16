/** @vitest-environment jsdom */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { act, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserUseTabIcon } from "@/app-shell/BrowserUseTabIcon.js";
import { BROWSER_USE_OPERATION_INDICATOR_DURATION_MS } from "@/lib/workspaceSidePane.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("BrowserUseTabIcon", () => {
  it("keeps the mouse indicator for five seconds and then restores the favicon", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-13T00:00:00.000Z"));
    const operationUntil = Date.now() + BROWSER_USE_OPERATION_INDICATOR_DURATION_MS;
    const view = render(
      createElement(BrowserUseTabIcon, {
        tab: {
          id: "browser-use:tab-1",
          type: "browser-use",
          sessionId: "sess-1",
          tabId: "tab-1",
          faviconUrl: "https://example.com/favicon.ico",
          browserUseOperationUntil: operationUntil,
        },
      }),
    );

    const indicator = view.container.querySelector(
      '[data-browser-use-operation-indicator="active"]',
    );
    expect(indicator).not.toBeNull();
    expect(indicator?.classList.contains("browser-use-operation-breathe")).toBe(true);
    expect(
      indicator?.querySelector("svg")?.classList.contains("browser-use-operation-breathe"),
    ).toBe(false);
    expect(view.container.querySelector("img")).toBeNull();

    act(() => vi.advanceTimersByTime(BROWSER_USE_OPERATION_INDICATOR_DURATION_MS - 1));
    expect(
      view.container.querySelector('[data-browser-use-operation-indicator="active"]'),
    ).not.toBeNull();

    act(() => vi.advanceTimersByTime(1));
    expect(view.container.querySelector("[data-browser-use-operation-indicator]")).toBeNull();
    const favicon = view.container.querySelector("img");
    expect(favicon?.getAttribute("src")).toBe("https://example.com/favicon.ico");
    expect(favicon?.getAttribute("referrerpolicy")).toBe("no-referrer");

    fireEvent.error(favicon as HTMLImageElement);
    expect(view.container.querySelector("img")).toBeNull();
    expect(view.container.querySelector("svg")).not.toBeNull();
  });

  it("defines a visible wrapper animation with a reduced-motion fallback", () => {
    // Bugfix：下面断言里有跨行片段（`.browser-use-operation-breathe {\n    animation: none;`），
    // 而仓库只对 *.mjs / *.sh 声明了 `eol=lf`，styles.css 在 `core.autocrlf=true` 的 Windows
    // 检出里是 CRLF，`toContain` 的 `\n` 匹配不到 `\r\n`，用例在 Windows 上必然失败。
    // 它想断言的是样式表内容契约，与换行字节无关，统一归一成 LF 再比对。
    const styles = readFileSync(
      resolve(process.cwd(), "packages/ui/src/styles.css"),
      "utf8",
    ).replaceAll("\r\n", "\n");

    expect(styles).toContain("@keyframes browser-use-operation-breathe");
    expect(styles).toContain("animation: browser-use-operation-breathe 900ms ease-in-out infinite");
    expect(styles).toContain("transform: scale(1.08)");
    expect(styles).toContain("prefers-reduced-motion: reduce");
    expect(styles).toContain(".browser-use-operation-breathe {\n    animation: none;");
    expect(styles).toContain('.browser-use-viewport[data-browser-resize-dimmed="true"]');
    expect(styles).toContain("filter: brightness(0.88)");
    expect(styles).toContain("transition: filter 160ms ease-out");
    expect(styles).toContain(".browser-use-viewport {\n    transition: none;");
  });
});
