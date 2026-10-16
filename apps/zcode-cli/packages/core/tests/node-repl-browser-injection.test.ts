import { describe, expect, it, vi } from "vitest";
import { jsToolEntry, disposeNodeReplSession } from "../src/tool/handlers/node-repl.js";
import type { ToolExecutionContext } from "../src/tool/types.js";
import type {
  BrowserControlPort,
  BrowserCommandResult,
  ToolArtifactStorePort,
} from "@zcode/contracts";
import type { JsOutput } from "@zcode/contracts";

const IAB = {
  id: "iab-runtime-1",
  generation: 1,
  type: "iab" as const,
  name: "ZCode In-app Browser",
  capabilities: {},
};

function browserPort(execute: BrowserControlPort["execute"]): BrowserControlPort {
  return {
    list: vi.fn(async () => [IAB]),
    execute: vi.fn(async (input) => {
      if (input.command.method === "newTab") {
        return {
          ok: true,
          tab: {
            tabId: "tab-1",
            url: "about:blank",
            title: "",
            viewport: { width: 1280, height: 720 },
          },
          elapsedMs: 1,
        };
      }
      return execute(input);
    }),
  };
}

function ctx(sessionId: string, port?: BrowserControlPort): ToolExecutionContext {
  return {
    toolCallId: "t",
    traceId: "tr",
    abortSignal: new AbortController().signal,
    workingDirectory: "/tmp",
    workspaceRoot: "/tmp",
    sessionId: sessionId as ToolExecutionContext["sessionId"],
    ...(port ? { browserControlPort: port } : {}),
  };
}

describe("node_repl browser injection", () => {
  it("exposes the browser.tabs.new path when browserControlPort is present", async () => {
    const port = browserPort(
      vi.fn(async (): Promise<BrowserCommandResult> => ({ ok: true, elapsedMs: 1 })),
    );
    const c = ctx("bs1", port);
    const out = (await jsToolEntry.handler(
      {
        code: "const browser = await agent.browsers.getDefault(); return typeof browser.tabs.new;",
      },
      c,
    )) as JsOutput;
    expect(out.error).toBeUndefined();
    expect(out.result).toBe("function");
    disposeNodeReplSession("bs1" as ToolExecutionContext["sessionId"]);
  });

  it("injects browser.documentation and agent.documentation.get as separate surfaces", async () => {
    const port = browserPort(
      vi.fn(async (): Promise<BrowserCommandResult> => ({ ok: true, elapsedMs: 1 })),
    );
    const c = {
      ...ctx("bs-docs", port),
      browserDocumentationRoot: new URL("../../browser-use-plugin/docs", import.meta.url).pathname,
    };
    const out = (await jsToolEntry.handler(
      {
        code: `const docsBrowser = await agent.browsers.get("iab"); const full = await docsBrowser.documentation(); const lookup = await agent.documentation.get("screenshots"); return JSON.stringify({full:full.includes("API manifest"),fullBytes:Buffer.byteLength(full,"utf8"),lookup:lookup.includes("# Screenshots"),legacy:typeof agent.browsers.documentation});`,
      },
      c,
    )) as JsOutput;
    const result = JSON.parse(out.result ?? "{}") as {
      full: boolean;
      fullBytes: number;
      lookup: boolean;
      legacy: string;
    };
    expect(result).toEqual({
      full: true,
      fullBytes: expect.any(Number),
      lookup: true,
      legacy: "undefined",
    });
    // 回归原因：真实 backend 的有效文档会超过旧 30 KB 预算；预算固定为 64 KiB，
    // 测试夹具生成的完整文档也必须能原样进入下一轮模型上下文。
    expect(jsToolEntry.resultBudget?.maxModelBytes).toBe(64 * 1024);
    expect(jsToolEntry.resultBudget?.preview?.maxBytes).toBe(64 * 1024);
    expect(result.fullBytes).toBeLessThanOrEqual(jsToolEntry.resultBudget?.maxModelBytes ?? 0);
    disposeNodeReplSession("bs-docs" as ToolExecutionContext["sessionId"]);
  });

  it("kernel reset drops old JS bindings and recovers backend-owned tabs through tabs.list", async () => {
    const execute = vi.fn(async (input): Promise<BrowserCommandResult> => {
      if (input.command.method === "list") {
        return {
          ok: true,
          tabs: [
            {
              tabId: "controlled-1",
              url: "https://example.com",
              title: "Example",
              viewport: { width: 1280, height: 720 },
            },
          ],
          elapsedMs: 1,
        };
      }
      if (input.command.method === "listUserTabs") {
        return { ok: true, userTabs: [], elapsedMs: 1 };
      }
      if (input.command.method === "activateTab") {
        return {
          ok: true,
          tab: {
            tabId: input.command.tabId,
            url: "https://example.com",
            title: "Example",
            active: true,
            viewport: { width: 1280, height: 720 },
          },
          elapsedMs: 1,
        };
      }
      return { ok: true, elapsedMs: 1 };
    });
    const c = ctx("bs-reset-recovery", browserPort(execute));
    await jsToolEntry.handler(
      {
        code: `globalThis.iab = await agent.browsers.get("iab"); globalThis.tab = await iab.tabs.get("controlled-1");`,
      },
      c,
    );
    // 2026-09-18：js_reset 工具已删除。dispose 后同 sessionId 再调用会重建 session，
    // 与旧 reset 等价，且更贴近生产——MCP 路径下每次 js 调用本来就是 fresh kernel。
    disposeNodeReplSession("bs-reset-recovery" as ToolExecutionContext["sessionId"]);
    const out = (await jsToolEntry.handler(
      {
        code: `const oldBinding = typeof tab; globalThis.iab = await agent.browsers.get("iab"); const controlled = await iab.tabs.list(); const userTabs = await iab.user.openTabs(); return JSON.stringify({oldBinding, controlled, userTabs});`,
      },
      c,
    )) as JsOutput;
    expect(JSON.parse(out.result ?? "{}")).toEqual({
      oldBinding: "undefined",
      controlled: [
        {
          id: "controlled-1",
          url: "https://example.com",
          title: "Example",
          viewport: { width: 1280, height: 720 },
        },
      ],
      userTabs: [],
    });
    disposeNodeReplSession("bs-reset-recovery" as ToolExecutionContext["sessionId"]);
  });

  it("rejects an in-flight browser result that arrives after kernel reset", async () => {
    let resolveLate!: (result: BrowserCommandResult) => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const execute = vi.fn(async (input): Promise<BrowserCommandResult> => {
      if (input.command.method !== "playwright") return { ok: true, elapsedMs: 1 };
      markStarted();
      return await new Promise<BrowserCommandResult>((resolve) => {
        resolveLate = resolve;
      });
    });
    const port = browserPort(execute);
    const controller = new AbortController();
    const firstContext = {
      ...ctx("bs-reset-late-result", port),
      abortSignal: controller.signal,
    };
    const interrupted = jsToolEntry.handler(
      {
        code: `const lateBrowser = await agent.browsers.getDefault(); const lateTab = await lateBrowser.tabs.new(); await lateTab.playwright.domSnapshot();`,
      },
      firstContext,
    ) as Promise<JsOutput>;
    await started;
    controller.abort();
    expect((await interrupted).error?.name).toBe("AbortError");

    // 第二个 cell 保持 sink 活跃；旧 generation 的迟到结果不得把 browser meta 合并进来。
    const nextContext = ctx("bs-reset-late-result", port);
    const nextCell = jsToolEntry.handler(
      {
        code: "await new Promise(resolve => setTimeout(resolve, 30)); return 42;",
        timeout_ms: 100,
      },
      nextContext,
    ) as Promise<JsOutput>;
    resolveLate({
      ok: true,
      value: "late",
      meta: {
        browserUse: true,
        backendType: "iab",
        browserId: IAB.id,
        browserGeneration: IAB.generation,
        openTabIds: ["late-tab"],
      },
      elapsedMs: 20,
    });
    const next = await nextCell;
    expect(next.result).toBe("42");
    expect(next.responseMeta).toBeUndefined();
    disposeNodeReplSession("bs-reset-late-result" as ToolExecutionContext["sessionId"]);
  });

  it("browser.tabs.new + tab.goto triggers port.execute (navigate) and returns result", async () => {
    const execute = vi.fn(
      async (): Promise<BrowserCommandResult> => ({
        ok: true,
        state: {
          url: "https://x",
          title: "X",
          canGoBack: false,
          canGoForward: false,
        },
        elapsedMs: 2,
      }),
    );
    const port = browserPort(execute);
    const c = ctx("bs2", port);
    const out = (await jsToolEntry.handler(
      {
        code: `const browser = await agent.browsers.getDefault(); const b = await browser.tabs.new(); await b.goto("https://x"); return b.constructor.name;`,
      },
      c,
    )) as JsOutput;
    expect(out.error).toBeUndefined();
    // 至少发生了一次 navigate 调用。
    expect(execute).toHaveBeenCalled();
    const firstCall = execute.mock.calls[0][0] as {
      command: { method: string; url?: string };
    };
    expect(firstCall.command).toEqual({
      method: "navigate",
      url: "https://x",
      tabId: "tab-1",
    });
    expect(firstCall).toMatchObject({ browserId: IAB.id, sessionId: "bs2" });
    disposeNodeReplSession("bs2" as ToolExecutionContext["sessionId"]);
  });

  it("emits an explicit screenshot and exposes its original artifact absolute path", async () => {
    const port = browserPort(
      vi.fn(async (input): Promise<BrowserCommandResult> => {
        const command = (input as { command: { method: string } }).command;
        if (command.method === "screenshot") {
          return {
            ok: true,
            image: { base64: "AAAA", mimeType: "image/png" },
            elapsedMs: 1,
          };
        }
        return { ok: true, elapsedMs: 1 };
      }),
    );
    const writes: Uint8Array[] = [];
    const artifactStore: ToolArtifactStorePort = {
      writeToolResultArtifact: async () => {
        throw new Error("unexpected text artifact write");
      },
      writeToolResultBinaryArtifact: async (request) => {
        writes.push(request.content);
        return {
          id: "browser-shot",
          uri: "zcode-artifact://bs3/browser-shot",
          path: "/tmp/browser-shot.png",
          bytes: request.content.byteLength,
          contentType: request.contentType,
          createdAt: new Date("2026-07-20T00:00:00.000Z"),
        };
      },
      readToolResultArtifact: async () => {
        throw new Error("not used");
      },
    };
    const c = { ...ctx("bs3", port), artifactStore };
    const out = (await jsToolEntry.handler(
      {
        code: `const browser = await agent.browsers.getDefault(); const b = await browser.tabs.new(); nodeRepl.emitImage(await b.screenshot());`,
      },
      c,
    )) as JsOutput;
    expect(out.error).toBeUndefined();
    expect(out.images?.[0]?.base64).toBe("AAAA");
    expect(out.browserScreenshotPaths).toEqual(["/tmp/browser-shot.png"]);
    expect(Buffer.from(writes[0] ?? [])).toEqual(Buffer.from("AAAA", "base64"));
    // Canonical node_repl result order puts the emitted raster before its summary.
    expect(jsToolEntry.formatModelContent?.(out)).toEqual([
      expect.objectContaining({ type: "image", mediaType: "image/png" }),
      expect.objectContaining({
        type: "text",
        text: expect.stringContaining("Browser screenshot saved to: /tmp/browser-shot.png"),
      }),
    ]);
    disposeNodeReplSession("bs3" as ToolExecutionContext["sessionId"]);
  });

  it("DOM-first example returns snapshot text without capturing a screenshot", async () => {
    const execute = vi.fn(async (input): Promise<BrowserCommandResult> => {
      const command = (input as { command: { method: string } }).command;
      if (command.method === "playwright" && command.action.name === "domSnapshot") {
        return {
          ok: true,
          value: '- heading "百度一下" [level=1]\n- paragraph: 网页内容',
          elapsedMs: 1,
        };
      }
      return { ok: true, elapsedMs: 1 };
    });
    const c = ctx("bs-dom-first", browserPort(execute));
    const out = (await jsToolEntry.handler(
      {
        code: `const browser = await agent.browsers.getDefault(); const domFirstTab = await browser.tabs.new(); await domFirstTab.goto("https://www.baidu.com"); await domFirstTab.playwright.domSnapshot()`,
      },
      c,
    )) as JsOutput;

    expect(out.error).toBeUndefined();
    expect(out.result).toContain("百度一下");
    expect(out.images ?? []).toEqual([]);
    const methods = execute.mock.calls.map(
      ([input]) => (input as { command: { method: string } }).command.method,
    );
    expect(methods).toEqual(["navigate", "playwright"]);
    disposeNodeReplSession("bs-dom-first" as ToolExecutionContext["sessionId"]);
  });

  it("automatically forwards browser response meta without creating an image block", async () => {
    const port = browserPort(
      vi.fn(
        async (): Promise<BrowserCommandResult> => ({
          ok: true,
          value: '- heading "X" [level=1]',
          meta: {
            browserUse: true,
            backendType: "iab",
            browserId: IAB.id,
            browserGeneration: IAB.generation,
            openTabIds: ["tab-1"],
            tabId: "tab-1",
            currentUrl: "https://x",
            lifecycle: "active",
          },
          elapsedMs: 1,
        }),
      ),
    );
    const c = ctx("bs-response-meta", port);
    const out = (await jsToolEntry.handler(
      {
        code: "const browser = await agent.browsers.getDefault(); const metaTab = await browser.tabs.new(); await metaTab.playwright.domSnapshot()",
      },
      c,
    )) as JsOutput;

    expect(out.responseMeta).toEqual({
      "zcode/browserUse": true,
      "zcode/toolSurface": expect.objectContaining({
        kind: "browserUse",
        backend: "iab",
        browserId: IAB.id,
      }),
      browser_use: { url: "https://x" },
      "zcode/browserTurnScreenshot": {
        browserGeneration: IAB.generation,
        browserId: IAB.id,
        tabId: "tab-1",
      },
    });
    expect(out.images).toBeUndefined();
    disposeNodeReplSession("bs-response-meta" as ToolExecutionContext["sessionId"]);
  });

  it("keeps last side-effect openTabIds through later reads without preview screenshot meta", async () => {
    const port = browserPort(
      vi.fn(
        async (input): Promise<BrowserCommandResult> => ({
          ok: true,
          ...(input.command.method === "getState"
            ? {
                state: {
                  url: "https://x",
                  title: "X",
                  canGoBack: false,
                  canGoForward: false,
                },
              }
            : {}),
          meta: {
            browserUse: true,
            backendType: "iab",
            browserId: IAB.id,
            browserGeneration: IAB.generation,
            openTabIds: ["tab-1"],
            tabId: "tab-1",
            currentUrl: "https://x",
            lifecycle: "active",
          },
          elapsedMs: 1,
        }),
      ),
    );
    const c = ctx("bs-side-effect-meta", port);
    const out = (await jsToolEntry.handler(
      {
        code: `const sideEffectBrowser = await agent.browsers.getDefault(); const sideEffectTab = await sideEffectBrowser.tabs.new(); await sideEffectTab.goto("https://x"); await sideEffectTab.title();`,
      },
      c,
    )) as JsOutput;
    expect(out.responseMeta).toMatchObject({
      "zcode/toolSurface": {
        kind: "browserUse",
        backend: "iab",
        browserId: IAB.id,
        openTabIds: ["tab-1"],
      },
    });
    expect(
      (out.responseMeta?.["zcode/toolSurface"] as Record<string, unknown>)?.screenshot,
    ).toBeUndefined();
    expect(out.images).toBeUndefined();
    disposeNodeReplSession("bs-side-effect-meta" as ToolExecutionContext["sessionId"]);
  });

  it("does not inject agent.browsers when no browser port is injected", async () => {
    const c = ctx("bs4");
    const out = (await jsToolEntry.handler({ code: "return typeof agent;" }, c)) as JsOutput;
    expect(out.error).toBeUndefined();
    expect(out.result).toBe("undefined");
    disposeNodeReplSession("bs4" as ToolExecutionContext["sessionId"]);
  });
});
