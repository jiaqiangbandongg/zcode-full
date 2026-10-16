import { describe, expect, it, vi } from "vitest";
import {
  captureBrowserDomSnapshot,
  normalizeBrowserDomSnapshot,
} from "../src/main/browserView/browserPlaywrightDomSnapshot.js";
import type { ControlledView } from "../src/main/browserView/browserCommandExecutor.js";
import { getPlaywrightInjectedScriptSource } from "../src/main/browserView/playwrightInjectedScriptSource.js";

function viewWithCdp(send: ControlledView["cdp"]["send"]): ControlledView {
  return {
    cdp: { send },
    webContents: {
      canGoBack: () => false,
      canGoForward: () => false,
      executeJavaScript: vi.fn(async () => undefined),
      getTitle: () => "Example",
      getURL: () => "https://example.com",
      goBack: vi.fn(),
      goForward: vi.fn(),
      loadURL: vi.fn(async () => undefined),
      reload: vi.fn(),
    },
  };
}

function snapshotResult(full: string, iframeRefs: string[] = []) {
  return {
    exceptionDetails: undefined,
    result: {
      value: {
        full,
        iframeDepths: Object.fromEntries(iframeRefs.map((ref) => [ref, 0])),
        iframeRefs,
      },
    },
  };
}

describe("Playwright DOM snapshot", () => {
  it("从 pinned playwright-core 读取真实 incrementalAriaSnapshot runtime", () => {
    const source = getPlaywrightInjectedScriptSource();
    expect(source.length).toBeGreaterThan(250_000);
    expect(source).toContain("incrementalAriaSnapshot");
    expect(source).toContain("getElementAccessibleName");
  });

  it("移除内部 ref/cursor、空图片并压平匿名容器", () => {
    expect(
      normalizeBrowserDomSnapshot(
        [
          "- generic [ref=e1] [cursor=pointer]:",
          '  - heading "Settings" [level=1] [ref=e2]',
          "  - listitem [ref=e3]:",
          '    - link "Profile" [ref=e4]',
          "  - img [ref=e5]",
          '  - img "Avatar" [ref=e6]',
        ].join("\n"),
      ),
    ).toBe(['- heading "Settings" [level=1]', '- link "Profile"', '- img "Avatar"'].join("\n"));
  });

  it("在 isolated world 运行 Playwright AI/ARIA snapshot，不读取 outerHTML", async () => {
    const send = vi.fn<ControlledView["cdp"]["send"]>(async (method, params) => {
      if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main" } } };
      if (method === "Page.createIsolatedWorld") return { executionContextId: 1 };
      if (method === "Runtime.evaluate") {
        const expression = String((params as { expression?: unknown }).expression ?? "");
        if (expression.startsWith("Boolean(globalThis.")) return { result: { value: false } };
        if (expression.includes("globalThis.__zcodePlaywrightInjected = new")) {
          return { result: { value: true } };
        }
        if (expression.includes("const snapshot = injected.incrementalAriaSnapshot")) {
          return snapshotResult(
            [
              '- heading "Dashboard" [level=1] [ref=e1]',
              '- button "Save" [ref=e2] [cursor=pointer]',
            ].join("\n"),
          );
        }
      }
      return {};
    });

    await expect(captureBrowserDomSnapshot(viewWithCdp(send))).resolves.toBe(
      ['- heading "Dashboard" [level=1]', '- button "Save"'].join("\n"),
    );
    const evaluations = send.mock.calls.filter(([method]) => method === "Runtime.evaluate");
    expect(
      evaluations.some(([, params]) =>
        String((params as { expression?: unknown }).expression ?? "").includes("outerHTML"),
      ),
    ).toBe(false);
  });

  it("递归读取同源 iframe 并按原 ARIA tree 位置缩进插入", async () => {
    const send = vi.fn<ControlledView["cdp"]["send"]>(async (method, params) => {
      if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main" } } };
      if (method === "Page.createIsolatedWorld") {
        return {
          executionContextId: (params as { frameId?: string }).frameId === "child-frame" ? 2 : 1,
        };
      }
      if (method === "Runtime.evaluate") {
        const input = params as {
          contextId?: number;
          expression?: string;
          returnByValue?: boolean;
        };
        const expression = input.expression ?? "";
        if (expression.startsWith("Boolean(globalThis.")) return { result: { value: false } };
        if (expression.includes("globalThis.__zcodePlaywrightInjected = new")) {
          return { result: { value: true } };
        }
        if (expression.includes("const snapshot = injected.incrementalAriaSnapshot")) {
          return input.contextId === 1
            ? snapshotResult('- iframe "Preview" [ref=f1]', ["f1"])
            : snapshotResult('- heading "Inside frame" [level=2] [ref=e9]');
        }
        if (expression.includes("return frame || null")) {
          return { result: { objectId: "frame-object" } };
        }
      }
      if (method === "DOM.describeNode") return { node: { frameId: "child-frame" } };
      return {};
    });

    await expect(captureBrowserDomSnapshot(viewWithCdp(send))).resolves.toBe(
      ['- iframe "Preview":', '  - heading "Inside frame" [level=2]'].join("\n"),
    );
    expect(send).toHaveBeenCalledWith(
      "Page.createIsolatedWorld",
      expect.objectContaining({ frameId: "child-frame" }),
      undefined,
    );
  });

  it("子 frame 无法进入时保留 iframe 节点并完成主快照", async () => {
    const send = vi.fn<ControlledView["cdp"]["send"]>(async (method, params) => {
      if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main" } } };
      if (method === "Page.createIsolatedWorld") {
        if ((params as { frameId?: string }).frameId === "oopif") throw new Error("No frame");
        return { executionContextId: 1 };
      }
      if (method === "Runtime.evaluate") {
        const expression = String((params as { expression?: unknown }).expression ?? "");
        if (expression.startsWith("Boolean(globalThis.")) return { result: { value: false } };
        if (expression.includes("globalThis.__zcodePlaywrightInjected = new")) {
          return { result: { value: true } };
        }
        if (expression.includes("const snapshot = injected.incrementalAriaSnapshot")) {
          return snapshotResult('- iframe "Remote" [ref=f1]', ["f1"]);
        }
        if (expression.includes("return frame || null")) {
          return { result: { objectId: "frame-object" } };
        }
      }
      if (method === "DOM.describeNode") return { node: { frameId: "oopif" } };
      if (method === "Target.attachToTarget") throw new Error("unavailable");
      return {};
    });

    await expect(captureBrowserDomSnapshot(viewWithCdp(send))).resolves.toBe('- iframe "Remote"');
  });

  it("OOPIF 导航竞态后刷新 target，并用最新 frame id 重试", async () => {
    let describeCount = 0;
    const send = vi.fn<ControlledView["cdp"]["send"]>(async (method, params, sessionId) => {
      if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main" } } };
      if (method === "Page.createIsolatedWorld") {
        const frameId = (params as { frameId?: string }).frameId;
        if (frameId === "stale-frame" || (frameId === "fresh-frame" && !sessionId)) {
          throw new Error("No frame for given id found");
        }
        return { executionContextId: sessionId ? 2 : 1 };
      }
      if (method === "Runtime.evaluate") {
        const input = params as { contextId?: number; expression?: string };
        const expression = input.expression ?? "";
        if (expression.startsWith("Boolean(globalThis.")) return { result: { value: false } };
        if (expression.includes("globalThis.__zcodePlaywrightInjected = new")) {
          return { result: { value: true } };
        }
        if (expression.includes("const snapshot = injected.incrementalAriaSnapshot")) {
          return input.contextId === 1
            ? snapshotResult('- iframe "Remote" [ref=f1]', ["f1"])
            : snapshotResult('- button "Recovered" [ref=e1]');
        }
        if (expression.includes("return frame || null")) {
          return { result: { objectId: `frame-object-${describeCount + 1}` } };
        }
      }
      if (method === "DOM.describeNode") {
        describeCount += 1;
        return { node: { frameId: describeCount === 1 ? "stale-frame" : "fresh-frame" } };
      }
      if (method === "Target.attachToTarget") {
        if ((params as { targetId?: string }).targetId === "stale-frame") {
          throw new Error("No target with given id found");
        }
        return { sessionId: "oopif-session" };
      }
      return {};
    });

    await expect(captureBrowserDomSnapshot(viewWithCdp(send))).resolves.toBe(
      ['- iframe "Remote":', '  - button "Recovered"'].join("\n"),
    );
    expect(send).toHaveBeenCalledWith("Target.getTargets", undefined, undefined);
    expect(send).toHaveBeenCalledWith("Target.detachFromTarget", { sessionId: "oopif-session" });
  });
});
