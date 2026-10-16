import { describe, expect, it } from "vitest";
import {
  browserBackendDescriptorSchema,
  browserBackendListResultSchema,
  browserCommandSchema,
  browserCommandResultSchema,
  browserSnapshotSchema,
} from "../src/browser-use/index.js";
import {
  zcodeBrowserExecuteParamsSchema,
  zcodeBrowserExecuteResultSchema,
  zcodeBrowserListParamsSchema,
  zcodeBrowserListResultSchema,
  zcodeProtocolMethods,
  zcodeProtocolSessionMethodContracts,
} from "../src/zcode-protocol/index.js";

const IAB_DESCRIPTOR = {
  id: "iab-runtime-1",
  generation: 1,
  type: "iab" as const,
  name: "ZCode In-app Browser",
  capabilities: {
    browser: [{ id: "visibility", description: "Browser visibility control" }],
    tab: [{ id: "cdp", description: "Controlled CDP commands" }],
  },
  apiSupportOverrides: { "Tabs.finalize": true },
  metadata: { buildFlavor: "development" },
};

describe("browser command schema", () => {
  it("parses each core method", () => {
    expect(browserCommandSchema.parse({ method: "navigate", url: "https://x" }).method).toBe(
      "navigate",
    );
    expect(browserCommandSchema.parse({ method: "snapshot" }).method).toBe("snapshot");
    expect(browserCommandSchema.parse({ method: "click", ref: "e1" }).method).toBe("click");
    expect(browserCommandSchema.parse({ method: "screenshot" }).method).toBe("screenshot");
    expect(browserCommandSchema.parse({ method: "getState" }).method).toBe("getState");
    expect(browserCommandSchema.parse({ method: "activateTab", tabId: "t-1" }).method).toBe(
      "activateTab",
    );
  });

  it("rejects navigate without url and unknown method and extra keys", () => {
    expect(() => browserCommandSchema.parse({ method: "navigate" })).toThrow();
    expect(() => browserCommandSchema.parse({ method: "teleport" })).toThrow();
    expect(() => browserCommandSchema.parse({ method: "activateTab" })).toThrow();
    expect(() => browserCommandSchema.parse({ method: "snapshot", bogus: 1 })).toThrow();
  });

  // dwf 子代理关闭时连 tab 一起关；桌面中继按这份 schema 校验 params，漏了字段命令就到不了 main。
  it("closeSession 接受可选 closeTabs，拒绝非布尔值", () => {
    expect(browserCommandSchema.parse({ method: "closeSession" })).toEqual({
      method: "closeSession",
    });
    expect(
      zcodeBrowserExecuteParamsSchema.parse({
        requestId: "req-close",
        sessionId: "sess_dwf-dwfrun-1-actor_1_1",
        command: { method: "closeSession", closeTabs: true },
      }).command,
    ).toEqual({ method: "closeSession", closeTabs: true });
    expect(() =>
      browserCommandSchema.parse({ method: "closeSession", closeTabs: "yes" }),
    ).toThrow();
  });

  it("parses list method (agent 对象模型 browsers.list)", () => {
    const parsed = browserCommandSchema.parse({ method: "list" });
    expect(parsed.method).toBe("list");
    // list 不带 tabId：作用于会话级别，多余字段被 strict 拒绝。
    expect(() => browserCommandSchema.parse({ method: "list", tabId: "t" })).toThrow();
  });

  it("viewport 与 Playwright Page 参数一致，并对 API 越界直接报错", () => {
    expect(
      browserCommandSchema.parse({
        method: "browserViewportSet",
        tabId: "t-1",
        width: 375,
        height: 667,
      }),
    ).toEqual({ method: "browserViewportSet", tabId: "t-1", width: 375, height: 667 });
    expect(
      browserCommandSchema.parse({ method: "browserViewportSet", width: 320, height: 320 }),
    ).toMatchObject({ width: 320, height: 320 });
    expect(
      browserCommandSchema.parse({ method: "browserViewportSet", width: 3840, height: 2160 }),
    ).toMatchObject({ width: 3840, height: 2160 });
    expect(() =>
      browserCommandSchema.parse({ method: "browserViewportSet", width: 319, height: 667 }),
    ).toThrow();
    expect(() =>
      browserCommandSchema.parse({ method: "browserViewportSet", width: 3841, height: 667 }),
    ).toThrow();
    expect(() =>
      browserCommandSchema.parse({ method: "browserViewportSet", width: 375, height: 2161 }),
    ).toThrow();
    expect(() =>
      browserCommandSchema.parse({ method: "browserViewportSet", width: 375.5, height: 667 }),
    ).toThrow();
  });

  it("按协议约定校验 playwrightWaitForTimeout 非负整数", () => {
    expect(
      browserCommandSchema.parse({
        method: "playwrightWaitForTimeout",
        timeoutMs: 0,
        tabId: "t-1",
      }),
    ).toEqual({ method: "playwrightWaitForTimeout", timeoutMs: 0, tabId: "t-1" });
    expect(() =>
      browserCommandSchema.parse({ method: "playwrightWaitForTimeout", timeoutMs: -1 }),
    ).toThrow();
    expect(() =>
      browserCommandSchema.parse({ method: "playwrightWaitForTimeout", timeoutMs: 1.5 }),
    ).toThrow();
  });

  it("严格校验 WebView 异步录制命令、受限动作和时长边界", () => {
    expect(
      browserCommandSchema.parse({
        method: "recordingStart",
        tabId: "t-1",
        options: {
          viewport: { width: 1280, height: 720 },
          fps: 25,
          jpegQuality: 80,
          maxDurationMs: 60_000,
          showCursor: true,
          actions: [
            { type: "wait", durationMs: 500 },
            { type: "click", selector: "#start" },
            { type: "type", selector: "#name", text: "ZCode" },
            { type: "hover", x: 120, y: 80, durationMs: 200 },
            { type: "scroll", deltaX: 0, deltaY: 600, durationMs: 800 },
            { type: "waitFor", selector: ".done", timeoutMs: 3_000 },
          ],
        },
      }),
    ).toMatchObject({ method: "recordingStart", tabId: "t-1" });
    expect(
      browserCommandSchema.parse({
        method: "recordingStatus",
        recordingId: "recording-1",
        outputPath: "recordings/demo.webm",
      }),
    ).toMatchObject({ method: "recordingStatus", outputPath: "recordings/demo.webm" });
    expect(
      browserCommandSchema.parse({ method: "recordingCancel", recordingId: "recording-1" }),
    ).toMatchObject({ method: "recordingCancel" });

    expect(() =>
      browserCommandSchema.parse({
        method: "recordingStart",
        options: { maxDurationMs: 90_001, actions: [] },
      }),
    ).toThrow();
    expect(() =>
      browserCommandSchema.parse({
        method: "recordingStart",
        options: { actions: [{ type: "eval", script: "document.body.remove()" }] },
      }),
    ).toThrow();
    expect(() =>
      browserCommandSchema.parse({
        method: "recordingStatus",
        recordingId: "recording-1",
        outputPath: "../outside.webm",
      }),
    ).toThrow();
    expect(() =>
      browserCommandSchema.parse({
        method: "recordingStatus",
        recordingId: "recording-1",
        outputPath: "recordings/legacy.mp4",
      }),
    ).toThrow();
  });

  it("严格校验 Playwright page/locator command envelope", () => {
    expect(
      browserCommandSchema.parse({
        method: "playwright",
        action: {
          name: "locator",
          selector: 'internal:role=button[name="Save"i]',
          operation: "click",
          modifiers: ["ControlOrMeta"],
          timeoutMs: 1000,
        },
        tabId: "t-1",
      }),
    ).toMatchObject({ method: "playwright", tabId: "t-1" });
    expect(() =>
      browserCommandSchema.parse({
        method: "playwright",
        action: { name: "locator", selector: "button", operation: "teleport" },
      }),
    ).toThrow();
    expect(() =>
      browserCommandSchema.parse({
        method: "playwright",
        action: { name: "waitForURL", url: "https://x", timeoutMs: 0 },
      }),
    ).toThrow();
  });

  it("严格保留 CUA path、scroll anchor/delta 与组合按键", () => {
    expect(
      browserCommandSchema.parse({
        method: "cuaDrag",
        path: [
          { x: 1, y: 2 },
          { x: 3, y: 4 },
        ],
        modifiers: ["Shift"],
      }),
    ).toMatchObject({
      method: "cuaDrag",
      path: [
        { x: 1, y: 2 },
        { x: 3, y: 4 },
      ],
    });
    expect(
      browserCommandSchema.parse({
        method: "cuaScroll",
        x: 10,
        y: 20,
        scrollX: 0,
        scrollY: 100,
      }),
    ).toMatchObject({ method: "cuaScroll", x: 10, y: 20, scrollY: 100 });
    expect(
      browserCommandSchema.parse({ method: "cuaKeypress", keys: ["ControlOrMeta", "A"] }),
    ).toMatchObject({ method: "cuaKeypress", keys: ["ControlOrMeta", "A"] });
    expect(() => browserCommandSchema.parse({ method: "cuaDrag", path: [] })).toThrow();
    expect(() => browserCommandSchema.parse({ method: "cuaKeypress", keys: [] })).toThrow();
  });

  it("每个变体接受可选 tabId（协议 tabId 寻址）", () => {
    const nav = browserCommandSchema.parse({
      method: "navigate",
      url: "https://x",
      tabId: "t-1",
    });
    expect(nav.tabId).toBe("t-1");
    const state = browserCommandSchema.parse({ method: "getState", tabId: "t-2" });
    expect(state.tabId).toBe("t-2");
    // 不带 tabId 仍合法（缺省作用于默认 view）。
    expect(browserCommandSchema.parse({ method: "getState" }).tabId).toBeUndefined();
  });
});

describe("browser command result tabs", () => {
  it("round-trips recording job status and artifact without extra fields", () => {
    expect(
      browserCommandResultSchema.parse({
        ok: true,
        recording: {
          id: "recording-1",
          status: "completed",
          phase: "completed",
          progress: 1,
          startedAt: 1,
          updatedAt: 2,
          artifact: {
            path: "recordings/demo.webm",
            mimeType: "video/webm",
            width: 1280,
            height: 720,
            fps: 25,
            durationMs: 4_000,
            frameCount: 100,
          },
        },
        elapsedMs: 1,
      }),
    ).toMatchObject({
      recording: {
        status: "completed",
        artifact: { path: "recordings/demo.webm", mimeType: "video/webm" },
      },
    });
  });

  it("result round-trips list tabs（BrowserTabSummary[]）", () => {
    const parsed = browserCommandResultSchema.parse({
      ok: true,
      tabs: [
        {
          tabId: "t-1",
          url: "https://a",
          title: "A",
          active: true,
          viewport: { width: 1280, height: 720 },
        },
        {
          tabId: "t-2",
          url: "https://b",
          title: "B",
          viewport: { width: 375, height: 667 },
        },
      ],
      elapsedMs: 3,
    });
    expect(parsed.tabs).toHaveLength(2);
    expect(parsed.tabs?.[0]).toEqual({
      tabId: "t-1",
      url: "https://a",
      title: "A",
      active: true,
      viewport: { width: 1280, height: 720 },
    });
  });

  it("拒绝 tabs 内多余字段（strict）", () => {
    expect(() =>
      browserCommandResultSchema.parse({
        ok: true,
        tabs: [
          {
            tabId: "t",
            url: "u",
            title: "x",
            viewport: { width: 1280, height: 720 },
            bogus: 1,
          },
        ],
        elapsedMs: 1,
      }),
    ).toThrow();
  });
});

describe("browser DOM snapshot schema", () => {
  it("同时保留动作 refs 与有界可见语义 DOM", () => {
    const parsed = browserSnapshotSchema.parse({
      url: "https://example.com",
      title: "Example",
      elements: [
        {
          ref: "e1",
          tag: "a",
          role: "link",
          name: "Details",
          selector: "#details",
          xpath: "//*[@id='details']",
          rect: { x: 1, y: 2, width: 30, height: 10 },
          inViewport: true,
          attributes: { id: "details", href: "/details", "data-testid": "details-link" },
        },
      ],
      truncated: false,
      dom: [
        { tag: "h1", depth: 1, inViewport: true, text: "Example heading" },
        {
          tag: "a",
          depth: 2,
          inViewport: true,
          ref: "e1",
          role: "link",
          name: "Details",
          attributes: { href: "/details" },
        },
      ],
      domTruncated: false,
    });

    expect(parsed.elements[0]?.ref).toBe("e1");
    expect(parsed.dom?.[0]?.text).toBe("Example heading");
    expect(parsed.dom?.[1]?.ref).toBe("e1");
    expect(JSON.stringify(parsed).indexOf('"dom"')).toBeLessThan(
      JSON.stringify(parsed).indexOf('"elements"'),
    );
  });

  it("语义 DOM 节点继续保持 strict", () => {
    expect(() =>
      browserSnapshotSchema.parse({
        url: "https://example.com",
        title: "Example",
        elements: [],
        truncated: false,
        dom: [{ tag: "p", depth: 1, inViewport: true, text: "x", unexpected: true }],
      }),
    ).toThrow();
  });
});

describe("browser backend descriptor schema", () => {
  it.each(["iab", "extension", "cdp"] as const)("接受 %s backend family", (type) => {
    const parsed = browserBackendDescriptorSchema.parse({
      ...IAB_DESCRIPTOR,
      id: `${type}-runtime-1`,
      type,
    });
    expect(parsed.type).toBe(type);
    expect(parsed.id).toBe(`${type}-runtime-1`);
  });

  it("拒绝把 Playwright 当作 backend，并拒绝 descriptor 多余字段", () => {
    expect(() =>
      browserBackendDescriptorSchema.parse({ ...IAB_DESCRIPTOR, type: "playwright" }),
    ).toThrow();
    expect(() =>
      browserBackendDescriptorSchema.parse({ ...IAB_DESCRIPTOR, available: true }),
    ).toThrow();
  });

  it("list result round-trips descriptor 数组且保持 strict", () => {
    const parsed = browserBackendListResultSchema.parse({ browsers: [IAB_DESCRIPTOR] });
    expect(parsed.browsers).toEqual([IAB_DESCRIPTOR]);
    expect(() =>
      browserBackendListResultSchema.parse({ browsers: [IAB_DESCRIPTOR], stale: [] }),
    ).toThrow();
  });
});

describe("interaction/browserList protocol", () => {
  it("注册严格 method contract", () => {
    expect(zcodeProtocolMethods.interactionBrowserList).toBe("interaction/browserList");
    const entry = zcodeProtocolSessionMethodContracts[zcodeProtocolMethods.interactionBrowserList];
    expect(entry?.params).toBe(zcodeBrowserListParamsSchema);
    expect(entry?.result).toBe(zcodeBrowserListResultSchema);
  });

  it("round-trips 完整 discovery context", () => {
    const parsed = zcodeBrowserListParamsSchema.parse({
      requestId: "req-list-1",
      sessionId: "sess-1",
      turnId: "turn-1",
      workspaceKey: "ssh://host/repo",
      workspacePath: "/repo",
      workspaceIdentity: "ssh://host/repo",
      remoteSessionId: "remote-1",
      clientMode: "web-remote-replayable",
      sessionContext: "live",
    });
    expect(parsed.workspaceKey).toBe("ssh://host/repo");
    expect(parsed.clientMode).toBe("web-remote-replayable");
  });

  it("拒绝缺失隔离 context 或多余字段", () => {
    expect(() =>
      zcodeBrowserListParamsSchema.parse({
        requestId: "req-list-1",
        sessionId: "sess-1",
      }),
    ).toThrow();
    expect(() =>
      zcodeBrowserListParamsSchema.parse({
        requestId: "req-list-1",
        sessionId: "sess-1",
        workspaceKey: "/repo",
        workspacePath: "/repo",
        clientMode: "desktop-continuous",
        sessionContext: "live",
        unexpected: true,
      }),
    ).toThrow();
  });

  it("result 使用统一 descriptor list schema", () => {
    expect(
      zcodeBrowserListResultSchema.parse({ browsers: [IAB_DESCRIPTOR] }).browsers[0]?.type,
    ).toBe("iab");
  });
});

describe("interaction/browserExecute protocol", () => {
  it("registers the method", () => {
    expect(zcodeProtocolMethods.interactionBrowserExecute).toBe("interaction/browserExecute");
  });

  it("has a contract entry with params/result schemas", () => {
    const entry =
      zcodeProtocolSessionMethodContracts[zcodeProtocolMethods.interactionBrowserExecute];
    expect(entry).toBeDefined();
    expect(entry?.params).toBeDefined();
    expect(entry?.result).toBeDefined();
  });

  it("params round-trips a navigate command", () => {
    const params = {
      requestId: "req-1",
      sessionId: "sess-1",
      command: { method: "navigate", url: "https://example.com" } as const,
    };
    const parsed = zcodeBrowserExecuteParamsSchema.parse(params);
    expect(parsed.command.method).toBe("navigate");
    expect(parsed.sessionId).toBe("sess-1");
  });

  it("params round-trips browserId + workspace/session context", () => {
    const parsed = zcodeBrowserExecuteParamsSchema.parse({
      requestId: "req-2",
      sessionId: "sess-1",
      turnId: "turn-1",
      browserId: "extension-runtime-3",
      workspaceKey: "ssh://host/repo",
      workspacePath: "/repo",
      workspaceIdentity: "ssh://host/repo",
      remoteSessionId: "remote-1",
      clientMode: "web-remote-replayable",
      sessionContext: "live",
      command: { method: "getState" },
    });
    expect(parsed.browserId).toBe("extension-runtime-3");
    expect(parsed.workspaceIdentity).toBe("ssh://host/repo");
    expect(parsed.clientMode).toBe("web-remote-replayable");
  });

  it("兼容旧 execute params，但继续拒绝未知字段", () => {
    expect(
      zcodeBrowserExecuteParamsSchema.parse({
        requestId: "legacy-req",
        sessionId: "legacy-session",
        command: { method: "getState" },
      }).browserId,
    ).toBeUndefined();
    expect(() =>
      zcodeBrowserExecuteParamsSchema.parse({
        requestId: "legacy-req",
        sessionId: "legacy-session",
        command: { method: "getState" },
        backend: "iab",
      }),
    ).toThrow();
  });

  it("result round-trips ok + image", () => {
    const result = {
      ok: true,
      image: { base64: "iVBOR", mimeType: "image/png" as const },
      elapsedMs: 12,
    };
    const parsed = zcodeBrowserExecuteResultSchema.parse(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.image?.base64).toBe("iVBOR");
  });

  it("result round-trips structured error", () => {
    const parsed = browserCommandResultSchema.parse({
      ok: false,
      error: { code: "navigation_blocked", message: "no" },
      elapsedMs: 1,
    });
    expect(parsed.error?.code).toBe("navigation_blocked");
  });

  it("result round-trips duplicate request id errors", () => {
    const parsed = zcodeBrowserExecuteResultSchema.parse({
      ok: false,
      error: {
        code: "duplicate_request_id",
        message: "browser requestId 'duplicate' is already running",
        sideEffect: "none",
      },
      elapsedMs: 0,
    });
    expect(parsed.error).toMatchObject({ code: "duplicate_request_id", sideEffect: "none" });
  });
});
