import { describe, expect, it, vi } from "vitest";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import {
  BrowserCommandError,
  BrowsersFacade,
  PlaywrightAPI,
  PlaywrightFrameLocator,
  PlaywrightLocator,
  Tab,
  type BrowserInfo,
  setupBrowserRuntime,
} from "../src/browser-client/index.js";
import type { BrowserCommand, BrowserCommandResult } from "@zcode/contracts";

const IAB_INFO: BrowserInfo = {
  id: "iab-runtime-1",
  generation: 1,
  type: "iab",
  name: "ZCode In-app Browser",
  capabilities: { browser: [], tab: [] },
};

function createFacade(
  execute: (command: BrowserCommand) => Promise<BrowserCommandResult>,
  infos: BrowserInfo[] = [IAB_INFO],
  options: { documentationRoot?: string; assertAvailable?: () => void } = {},
): BrowsersFacade {
  return new BrowsersFacade(
    {
      list: async () => infos,
      execute: async (_browserId, _browserGeneration, command) => execute(command),
    },
    options,
  );
}

function fakeExecute() {
  const calls: BrowserCommand[] = [];
  const execute = vi.fn(async (command: BrowserCommand): Promise<BrowserCommandResult> => {
    calls.push(command);
    if (command.method === "list") {
      return { ok: true, tabs: [], elapsedMs: 1 } satisfies BrowserCommandResult;
    }
    if (command.method === "newTab") {
      return {
        ok: true,
        tab: {
          tabId: "t-new",
          url: "about:blank",
          title: "",
          viewport: { width: 1280, height: 720 },
        },
        elapsedMs: 1,
      };
    }
    if (command.method === "screenshot") {
      return { ok: true, image: { base64: "AQID", mimeType: "image/png" }, elapsedMs: 1 };
    }
    if (command.method === "snapshot") {
      return {
        ok: true,
        snapshot: {
          url: "https://example.com",
          title: "E",
          truncated: false,
          elements: [{ ref: "e1", tag: "button", text: "Go" }],
          dom: [
            { tag: "h1", depth: 1, inViewport: true, text: "Example" },
            { tag: "button", depth: 2, inViewport: true, ref: "e1", name: "Go" },
          ],
          domTruncated: false,
        },
        elapsedMs: 1,
      };
    }
    if (command.method === "getState" || command.method === "navigate") {
      return {
        ok: true,
        state: { url: "https://example.com", title: "E", canGoBack: false, canGoForward: false },
        elapsedMs: 1,
      };
    }
    if (command.method === "evaluate") {
      return { ok: true, value: "value", elapsedMs: 1 };
    }
    if (command.method === "getDialog") {
      return { ok: true, dialog: null, elapsedMs: 1 };
    }
    if (command.method === "recordingStart") {
      return {
        ok: true,
        recording: {
          id: "recording-1",
          status: "running",
          phase: "capturing",
          progress: 0.1,
          startedAt: 1,
          updatedAt: 1,
        },
        elapsedMs: 1,
      };
    }
    if (command.method === "recordingStatus") {
      return {
        ok: true,
        recording: {
          id: command.recordingId,
          status: "completed",
          phase: "completed",
          progress: 1,
          startedAt: 1,
          updatedAt: 2,
          artifact: {
            path: command.outputPath ?? "/tmp/browser-recording.webm",
            mimeType: "video/webm",
            width: 1280,
            height: 720,
            fps: 25,
            durationMs: 1_000,
            frameCount: 25,
          },
        },
        elapsedMs: 1,
      };
    }
    if (command.method === "recordingCancel") {
      return {
        ok: true,
        recording: {
          id: command.recordingId,
          status: "cancelled",
          phase: "cancelled",
          progress: 0.1,
          startedAt: 1,
          updatedAt: 2,
        },
        elapsedMs: 1,
      };
    }
    if (command.method === "elementInfo") {
      return {
        ok: true,
        element: { ref: "e1", tag: "button", text: "Go" },
        elapsedMs: 1,
      };
    }
    if (command.method === "playwright") {
      const { action } = command;
      if (action.name === "elementScreenshot") {
        return { ok: true, image: { base64: "AQID", mimeType: "image/png" }, elapsedMs: 1 };
      }
      if (action.name === "elementInfo") {
        return {
          ok: true,
          value: [
            {
              tagName: "button",
              preview: "<button>Go</button>",
              selector: { candidates: ["button"] },
            },
          ],
          elapsedMs: 1,
        };
      }
      if (action.name === "domSnapshot") {
        return { ok: true, value: '- heading "Example" [level=1]', elapsedMs: 1 };
      }
      if (action.name === "waitForEvent") {
        return { ok: true, value: { id: "download-1" }, elapsedMs: 1 };
      }
      if (action.name === "downloadPath") {
        return { ok: true, value: "/tmp/file.txt", elapsedMs: 1 };
      }
      if (action.name === "evaluate") {
        return { ok: true, value: "evaluated", elapsedMs: 1 };
      }
      if (action.name === "locator") {
        const values: Record<string, unknown> = {
          count: 2,
          allTextContents: ["one", "two"],
          textContent: "one",
          innerText: "One",
          getAttribute: "button",
          isVisible: true,
          isEnabled: true,
          evaluate: "locator-evaluated",
        };
        return { ok: true, value: values[action.operation], elapsedMs: 1 };
      }
      return { ok: true, elapsedMs: 1 };
    }
    return { ok: true, elapsedMs: 1 };
  });
  return { execute, calls };
}

/** open() 复用路径的可编程 mock：list/activateTab/newTab/navigate 全部记录命令序列。 */
function reuseFacade(tabs: Array<{ tabId: string; url?: string; active?: boolean }>) {
  const calls: BrowserCommand[] = [];
  const execute = vi.fn(async (command: BrowserCommand): Promise<BrowserCommandResult> => {
    calls.push(command);
    if (command.method === "list") {
      return {
        ok: true,
        tabs: tabs.map((tab) => ({
          tabId: tab.tabId,
          url: tab.url,
          title: tab.tabId,
          active: tab.active,
          viewport: { width: 1280, height: 720 },
        })),
        elapsedMs: 1,
      } satisfies BrowserCommandResult;
    }
    if (command.method === "activateTab") {
      const found = tabs.find((tab) => tab.tabId === command.tabId);
      return {
        ok: true,
        tab: {
          tabId: command.tabId,
          url: found?.url ?? "about:blank",
          title: command.tabId,
          active: true,
          viewport: { width: 1280, height: 720 },
        },
        elapsedMs: 1,
      } satisfies BrowserCommandResult;
    }
    if (command.method === "newTab") {
      return {
        ok: true,
        tab: {
          tabId: "t-new",
          url: "about:blank",
          title: "",
          viewport: { width: 1280, height: 720 },
        },
        elapsedMs: 1,
      } satisfies BrowserCommandResult;
    }
    if (command.method === "navigate") {
      return {
        ok: true,
        state: {
          url: command.url,
          title: "",
          canGoBack: false,
          canGoForward: false,
        },
        elapsedMs: 1,
      } satisfies BrowserCommandResult;
    }
    return { ok: true, elapsedMs: 1 } satisfies BrowserCommandResult;
  });
  return { calls, facade: createFacade(execute) };
}

describe("browser-client facade", () => {
  it("list()/get()/getDefault() expose the iab backend model", async () => {
    const { execute } = fakeExecute();
    const browsers = createFacade(execute);
    await expect(browsers.list()).resolves.toEqual([
      {
        id: "iab-runtime-1",
        type: "iab",
        name: "ZCode In-app Browser",
        capabilities: { browser: [], tab: [] },
      },
    ]);
    const byType = await browsers.get("iab");
    await expect(browsers.get("iab-runtime-1")).resolves.toBe(byType);
    await expect(browsers.getDefault()).resolves.toBe(byType);
    await expect(browsers.getForUrl("https://example.com")).resolves.toBe(byType);
    await expect(browsers.get("chrome")).rejects.toMatchObject({ code: "backend_unavailable" });
  });

  it("routes commands by runtime browser id and never synthesizes unavailable backends", async () => {
    const extension: BrowserInfo = {
      id: "extension-profile-1",
      generation: 2,
      type: "extension",
      name: "Chrome",
      capabilities: {},
    };
    const execute = vi.fn(
      async (_browserId: string, _browserGeneration: number, command: BrowserCommand) => {
        if (command.method === "list") {
          return { ok: true, tabs: [], elapsedMs: 1 } satisfies BrowserCommandResult;
        }
        return { ok: true, elapsedMs: 1 } satisfies BrowserCommandResult;
      },
    );
    const browsers = new BrowsersFacade({
      list: async () => [extension, IAB_INFO],
      execute,
    });

    const chrome = await browsers.get("extension");
    await chrome.default.goto("https://example.com");
    expect(execute).toHaveBeenLastCalledWith(extension.id, extension.generation, {
      method: "navigate",
      url: "https://example.com",
    });
    await expect(browsers.getDefault()).resolves.toMatchObject({ browserId: IAB_INFO.id });
    await expect(browsers.getForUrl("http://localhost:3000")).resolves.toMatchObject({
      browserId: IAB_INFO.id,
    });

    const empty = new BrowsersFacade({ list: async () => [], execute });
    await expect(empty.getDefault()).rejects.toMatchObject({ code: "backend_unavailable" });
  });

  it("open(url) navigates with direct-return SDK semantics", async () => {
    const { execute, calls } = fakeExecute();
    const tab = await createFacade(execute).open("https://example.com");
    expect(tab).toBeInstanceOf(Tab);
    // 无已有 tab 可复用时，open() 仍走 newTab + navigate 的直返语义。
    expect(calls).toEqual([
      { method: "list" },
      { method: "newTab" },
      { method: "navigate", url: "https://example.com", tabId: "t-new" },
    ]);
  });

  describe("open(url) tab reuse", () => {
    it("reuses an exact URL match by activating it and navigating in place", async () => {
      const { calls, facade } = reuseFacade([
        { tabId: "t-1", url: "https://example.com/docs#old-section" },
      ]);
      const tab = await facade.open("https://example.com/docs");
      expect(tab).toBeInstanceOf(Tab);
      expect(tab.id).toBe("t-1");
      expect(calls).toEqual([
        { method: "list" },
        { method: "activateTab", tabId: "t-1" },
        { method: "navigate", url: "https://example.com/docs", tabId: "t-1" },
      ]);
    });

    it("reuses a same-hostname tab when no closer match exists", async () => {
      const { calls, facade } = reuseFacade([{ tabId: "t-1", url: "https://a.com/list" }]);
      const tab = await facade.open("https://a.com/detail");
      expect(tab.id).toBe("t-1");
      expect(calls).toEqual([
        { method: "list" },
        { method: "activateTab", tabId: "t-1" },
        { method: "navigate", url: "https://a.com/detail", tabId: "t-1" },
      ]);
    });

    it("does not reuse a parent/child-host tab", async () => {
      const { calls, facade } = reuseFacade([{ tabId: "t-1", url: "https://shop.example.com/cart" }]);
      const tab = await facade.open("https://example.com");
      expect(tab.id).toBe("t-new");
      expect(calls).toEqual([
        { method: "list" },
        { method: "newTab" },
        { method: "navigate", url: "https://example.com", tabId: "t-new" },
      ]);
    });

    it("creates a new tab when nothing matches and ignores unusable tab urls", async () => {
      const { calls, facade } = reuseFacade([
        { tabId: "t-1", url: "https://a.com" },
        { tabId: "t-2", url: "::not-a-url::" },
        { tabId: "t-3" },
      ]);
      const tab = await facade.open("https://b.com");
      expect(tab.id).toBe("t-new");
      expect(calls).toEqual([
        { method: "list" },
        { method: "newTab" },
        { method: "navigate", url: "https://b.com", tabId: "t-new" },
      ]);
    });

    it("falls back to a new tab when listing fails", async () => {
      const calls: BrowserCommand[] = [];
      const execute = vi.fn(async (command: BrowserCommand): Promise<BrowserCommandResult> => {
        calls.push(command);
        if (command.method === "list") {
          return {
            ok: false,
            elapsedMs: 1,
            error: { code: "backend_unavailable", message: "backend gone" },
          } satisfies BrowserCommandResult;
        }
        if (command.method === "newTab") {
          return {
            ok: true,
            tab: { tabId: "t-new", url: "about:blank", title: "", viewport: { width: 1280, height: 720 } },
            elapsedMs: 1,
          } satisfies BrowserCommandResult;
        }
        return { ok: true, elapsedMs: 1 } satisfies BrowserCommandResult;
      });
      const tab = await createFacade(execute).open("https://example.com");
      expect(tab.id).toBe("t-new");
      expect(calls).toEqual([
        { method: "list" },
        { method: "newTab" },
        { method: "navigate", url: "https://example.com", tabId: "t-new" },
      ]);
    });

    it("creates a tab without listing when url is omitted", async () => {
      const { calls, facade } = reuseFacade([{ tabId: "t-1", url: "https://a.com" }]);
      const tab = await facade.open();
      expect(tab.id).toBe("t-new");
      expect(calls).toEqual([{ method: "newTab" }]);
    });

    it("skips reuse when reuseTab is false", async () => {
      const { calls, facade } = reuseFacade([{ tabId: "t-1", url: "https://example.com/docs" }]);
      const tab = await facade.open("https://example.com/docs", { reuseTab: false });
      expect(tab.id).toBe("t-new");
      expect(calls).toEqual([
        { method: "newTab" },
        { method: "navigate", url: "https://example.com/docs", tabId: "t-new" },
      ]);
    });

    it("prefers the active tab among equal-rank matches", async () => {
      const { calls, facade } = reuseFacade([
        { tabId: "t-1", url: "https://a.com/one" },
        { tabId: "t-2", url: "https://a.com/two", active: true },
      ]);
      const tab = await facade.open("https://a.com/three");
      expect(tab.id).toBe("t-2");
      expect(calls).toEqual([
        { method: "list" },
        { method: "activateTab", tabId: "t-2" },
        { method: "navigate", url: "https://a.com/three", tabId: "t-2" },
      ]);
    });

    it("falls back to the newest tab among equal-rank matches without an active one", async () => {
      const { calls, facade } = reuseFacade([
        { tabId: "t-1", url: "https://a.com/one" },
        { tabId: "t-2", url: "https://a.com/two" },
      ]);
      const tab = await facade.open("https://a.com/three");
      expect(tab.id).toBe("t-2");
      expect(calls).toEqual([
        { method: "list" },
        { method: "activateTab", tabId: "t-2" },
        { method: "navigate", url: "https://a.com/three", tabId: "t-2" },
      ]);
    });

    it("open() stays visible through the runtime proxy (manifest hideUnknown surface)", async () => {
      // 修复原因：SKILL.md 教模型调 agent.browsers.open(url)，但 REPL 注入的是
      // asRuntimeObject() 的 hideUnknown 代理——open 不在 Browsers manifest 声明里
      // 时会被隐藏成 undefined，文档指引直接踩空。必须走真实代理路径验证。
      const { calls, facade } = reuseFacade([{ tabId: "t-1", url: "https://example.com/docs" }]);
      const runtime = facade.asRuntimeObject();
      expect(typeof runtime.open).toBe("function");
      const tab = await runtime.open("https://example.com/docs");
      expect(tab.id).toBe("t-1");
      expect(calls).toEqual([
        { method: "list" },
        { method: "activateTab", tabId: "t-1" },
        { method: "navigate", url: "https://example.com/docs", tabId: "t-1" },
      ]);
    });
  });

  it("browser.tabs list/selected/get/new map controlled tabs", async () => {
    const execute = vi.fn(async (command: BrowserCommand): Promise<BrowserCommandResult> => {
      if (command.method === "list") {
        return {
          ok: true,
          tabs: [
            {
              tabId: "t-1",
              url: "https://a.com",
              title: "A",
              viewport: { width: 1024, height: 768 },
            },
            {
              tabId: "t-2",
              url: "https://b.com",
              title: "B",
              active: true,
              viewport: { width: 1280, height: 720 },
            },
          ],
          elapsedMs: 1,
        };
      }
      if (command.method === "newTab") {
        return {
          ok: true,
          tab: {
            tabId: "t-3",
            url: "about:blank",
            title: "",
            active: true,
            viewport: { width: 1280, height: 720 },
          },
          elapsedMs: 1,
        };
      }
      if (command.method === "activateTab") {
        return {
          ok: true,
          tab: {
            tabId: command.tabId,
            url: "https://a.com",
            title: "A",
            active: true,
            viewport: { width: 1024, height: 768 },
          },
          elapsedMs: 1,
        };
      }
      return { ok: true, elapsedMs: 1 };
    });
    const browser = await createFacade(execute).getDefault();
    const tabs = await browser.tabs.list();
    expect(execute).toHaveBeenCalledWith({ method: "list" });
    expect(tabs[0]).toEqual({
      id: "t-1",
      url: "https://a.com",
      title: "A",
      viewport: { width: 1024, height: 768 },
    });
    expect(tabs[1]).toMatchObject({ id: "t-2", active: true });
    await expect(browser.tabs.selected()).resolves.toMatchObject({ tabId: "t-2" });
    await expect(browser.tabs.get("t-1")).resolves.toMatchObject({ tabId: "t-1" });
    expect(execute.mock.calls.slice(-2).map(([command]) => command)).toEqual([
      { method: "list" },
      { method: "activateTab", tabId: "t-1" },
    ]);
    await expect(browser.tabs.get("t-9")).rejects.toMatchObject({
      code: "backend_unavailable",
    });
    await expect(browser.tabs.new()).resolves.toMatchObject({ tabId: "t-3" });
  });

  it("对齐 BrowserUser claim、live tab state、capability collection 和 tabs.finalize", async () => {
    const commands: BrowserCommand[] = [];
    const execute = vi.fn(async (command: BrowserCommand): Promise<BrowserCommandResult> => {
      commands.push(command);
      if (command.method === "listUserTabs") {
        return {
          ok: true,
          userTabs: [{ id: "user-1", url: "https://user.example", title: "User" }],
          elapsedMs: 1,
        };
      }
      if (command.method === "claimTab") {
        return {
          ok: true,
          tab: {
            tabId: "user-1",
            url: "https://user.example",
            title: "User",
            viewport: { width: 1024, height: 768 },
          },
          elapsedMs: 1,
        };
      }
      if (command.method === "getState") {
        return {
          ok: true,
          state: {
            url: "https://user.example/live",
            title: "Live title",
            canGoBack: false,
            canGoForward: false,
          },
          elapsedMs: 1,
        };
      }
      if (command.method === "browserVisibilityGet") {
        return { ok: true, value: true, elapsedMs: 1 };
      }
      return { ok: true, elapsedMs: 1 };
    });
    const info: BrowserInfo = {
      ...IAB_INFO,
      apiSupportOverrides: {
        "BrowserUser.claimTab": true,
        "Tabs.finalize": true,
        "Tab.markDeliverable": true,
        "Tab.markHandoff": true,
      },
      capabilities: {
        browser: [{ id: "visibility", description: "Visibility" }],
        tab: [{ id: "pageAssets", description: "Assets" }],
      },
    };
    const browser = await createFacade(execute, [info]).getDefault();
    await expect(browser.capabilities.list()).resolves.toEqual([
      { id: "visibility", description: "Visibility" },
    ]);
    const visibility = await browser.capabilities.get("visibility");
    await visibility.set(true);
    await expect(visibility.get()).resolves.toBe(true);
    const userTab = (await browser.user.openTabs())[0]!;
    const tab = await browser.user.claimTab(userTab);
    expect(tab.viewportSize()).toEqual({ width: 1024, height: 768 });
    await tab.setViewportSize({ width: 1280, height: 720 });
    expect(tab.viewportSize()).toEqual({ width: 1280, height: 720 });
    await expect(tab.setViewportSize({ width: 319, height: 720 })).rejects.toThrow(
      "setViewportSize requires integer width 320..3840 and height 320..2160",
    );
    await expect(tab.url()).resolves.toBe("https://user.example/live");
    await expect(tab.title()).resolves.toBe("Live title");
    await expect(tab.capabilities.list()).resolves.toEqual([
      { id: "pageAssets", description: "Assets" },
    ]);
    await browser.tabs.finalize({ keep: [{ tab, status: "deliverable" }] });
    expect(commands).toContainEqual({
      method: "finalizeTabs",
      keep: [{ tabId: "user-1", status: "deliverable" }],
    });
    expect(commands).toContainEqual({ method: "browserVisibilitySet", visible: true });
    expect(commands).toContainEqual({
      method: "browserViewportSet",
      tabId: "user-1",
      width: 1280,
      height: 720,
    });
  });

  it("current()/listTabs()/tab(id) keep compatibility shortcuts", async () => {
    const execute = vi.fn(async (command: BrowserCommand): Promise<BrowserCommandResult> => {
      if (command.method === "list") {
        return {
          ok: true,
          tabs: [
            {
              tabId: "t-1",
              url: "https://a.com",
              title: "A",
              viewport: { width: 1024, height: 768 },
            },
            {
              tabId: "t-2",
              url: "https://b.com",
              title: "B",
              active: true,
              viewport: { width: 1280, height: 720 },
            },
          ],
          elapsedMs: 1,
        };
      }
      return { ok: true, elapsedMs: 1 };
    });
    const browsers = createFacade(execute);
    await expect(browsers.current()).resolves.toMatchObject({ tabId: "t-2" });
    await expect(browsers.listTabs()).resolves.toHaveLength(2);
    expect(browsers.tab("t-9").tabId).toBe("t-9");
  });

  it("direct methods return payloads and raw methods preserve BrowserCommandResult", async () => {
    const { execute, calls } = fakeExecute();
    const tab = createFacade(execute).tab("t-1");

    const snapshot = await tab.snapshot({ maxElements: 50 });
    expect(snapshot.elements[0].ref).toBe("e1");
    expect(snapshot.dom?.[0]).toMatchObject({ tag: "h1", text: "Example" });
    expect(calls.at(-1)).toMatchObject({ method: "snapshot", maxElements: 50, tabId: "t-1" });

    const bytes = await tab.screenshot();
    expect([...bytes]).toEqual([1, 2, 3]);
    expect(calls.at(-1)).toMatchObject({ method: "screenshot", tabId: "t-1" });

    const rawShot = await tab.raw.screenshot();
    expect(rawShot.image?.base64).toBe("AQID");

    await tab.click("e1", { button: "right", doubleClick: true });
    expect(calls.at(-1)).toMatchObject({
      method: "click",
      ref: "e1",
      button: "right",
      doubleClick: true,
    });

    await tab.type("hello", { ref: "e2" });
    expect(calls.at(-1)).toMatchObject({ method: "type", text: "hello", ref: "e2" });
    await tab.press("Enter", { modifiers: ["Meta"] });
    expect(calls.at(-1)).toMatchObject({ method: "press", key: "Enter", modifiers: ["Meta"] });
    await tab.scroll({ y: 300 });
    expect(calls.at(-1)).toMatchObject({ method: "scroll", y: 300 });
  });

  it("exposes async WebView recording start/status/cancel without a persistent JS kernel", async () => {
    const { execute, calls } = fakeExecute();
    const tab = createFacade(execute).tab("t-1");

    const started = await tab.recording.start({
      viewport: { width: 1280, height: 720 },
      actions: [
        { type: "wait", durationMs: 500 },
        { type: "click", selector: "#start" },
      ],
    });
    expect(started).toMatchObject({ id: "recording-1", status: "running" });
    expect(calls.at(-1)).toMatchObject({
      method: "recordingStart",
      tabId: "t-1",
      options: { viewport: { width: 1280, height: 720 } },
    });

    const completed = await tab.recording.status(started.id, {
      outputPath: "recordings/demo.webm",
    });
    expect(completed).toMatchObject({
      id: "recording-1",
      status: "completed",
      artifact: { path: "recordings/demo.webm", mimeType: "video/webm" },
    });
    expect(calls.at(-1)).toEqual({
      method: "recordingStatus",
      recordingId: "recording-1",
      outputPath: "recordings/demo.webm",
      tabId: "t-1",
    });

    await tab.recording.cancel(started.id);
    expect(calls.at(-1)).toEqual({
      method: "recordingCancel",
      recordingId: "recording-1",
      tabId: "t-1",
    });
  });

  it("throws BrowserCommandError on ok:false", async () => {
    const execute = vi.fn(
      async (): Promise<BrowserCommandResult> => ({
        ok: false,
        elapsedMs: 1,
        error: { code: "ref_not_found", message: "stale ref" },
      }),
    );
    const tab = createFacade(execute).tab("t-1");
    await expect(tab.click("old")).rejects.toBeInstanceOf(BrowserCommandError);
    await expect(tab.click("old")).rejects.toMatchObject({ code: "ref_not_found" });
  });

  it("locator 错误包装只保留一次原始 message，并附带 selector context", async () => {
    const execute = vi.fn(
      async (): Promise<BrowserCommandResult> => ({
        ok: false,
        elapsedMs: 3_000,
        error: { code: "timeout", message: "Timeout waiting for locator placeholder" },
      }),
    );
    const tab = createFacade(execute).tab("t-1");

    let caught: Error | undefined;
    try {
      await tab.playwright.getByPlaceholder("搜索").fill("zcode");
    } catch (error) {
      caught = error as Error;
    }

    expect(caught).toBeDefined();
    expect(caught?.message).toBe(
      'Timeout waiting for locator placeholder\nlocator.fill failed for selector internal:attr=[placeholder="搜索"i]',
    );
    expect(caught?.stack?.match(/Timeout waiting for locator placeholder/g)).toHaveLength(1);
    expect(caught?.cause).toBeInstanceOf(BrowserCommandError);
  });

  it("additional methods construct expected commands", async () => {
    const { execute, calls } = fakeExecute();
    const tab = createFacade(execute).tab("t-9");

    await tab.hover("e1");
    expect(calls.at(-1)).toEqual({ method: "hover", ref: "e1", tabId: "t-9" });
    await tab.hover({ x: 10, y: 20 });
    expect(calls.at(-1)).toEqual({ method: "hover", x: 10, y: 20, tabId: "t-9" });
    await tab.select("e2", ["a", "b"]);
    expect(calls.at(-1)).toEqual({ method: "select", ref: "e2", values: ["a", "b"], tabId: "t-9" });
    await tab.check("e3", false);
    expect(calls.at(-1)).toEqual({ method: "check", ref: "e3", checked: false, tabId: "t-9" });
    await tab.drag("e4", { x: 3, y: 4 }, { modifiers: ["Shift"] });
    expect(calls.at(-1)).toEqual({
      method: "drag",
      fromRef: "e4",
      to: { x: 3, y: 4 },
      modifiers: ["Shift"],
      tabId: "t-9",
    });
    await tab.close();
    expect(calls.at(-1)).toEqual({ method: "close", tabId: "t-9" });
    await expect(tab.elementInfo(5, 6)).resolves.toMatchObject({ ref: "e1" });
    await expect(tab.evaluate("document.title")).resolves.toBe("value");
    await expect(tab.getDialog()).resolves.toBeNull();
    await tab.handleDialog(true, "answer");
    expect(calls.at(-1)).toEqual({
      method: "handleDialog",
      accept: true,
      promptText: "answer",
      tabId: "t-9",
    });
    expect((tab as unknown as { waitForTimeout?: unknown }).waitForTimeout).toBeUndefined();
    await tab.playwright.waitForTimeout(0);
    expect(calls.at(-1)).toEqual({
      method: "playwrightWaitForTimeout",
      timeoutMs: 0,
      tabId: "t-9",
    });
  });

  it("playwright.waitForTimeout 在 client 侧拒绝负数和非整数", async () => {
    const { execute } = fakeExecute();
    const tab = createFacade(execute).tab("t-1");

    await expect(tab.playwright.waitForTimeout(-1)).rejects.toThrow(
      "playwright.waitForTimeout requires a non-negative integer",
    );
    await expect(tab.playwright.waitForTimeout(1.5)).rejects.toThrow(
      "playwright.waitForTimeout requires a non-negative integer",
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it("完整暴露 Playwright/Locator/FrameLocator 公共对象图", () => {
    expect(
      Object.getOwnPropertyNames(PlaywrightAPI.prototype).filter((name) => name !== "constructor"),
    ).toEqual(
      expect.arrayContaining([
        "domSnapshot",
        "elementInfo",
        "elementScreenshot",
        "evaluate",
        "expectNavigation",
        "frameLocator",
        "getByLabel",
        "getByPlaceholder",
        "getByRole",
        "getByTestId",
        "getByText",
        "locator",
        "waitForEvent",
        "waitForLoadState",
        "waitForTimeout",
        "waitForURL",
      ]),
    );
    expect(
      Object.getOwnPropertyNames(PlaywrightLocator.prototype).filter(
        (name) => !name.startsWith("_") && name !== "constructor",
      ),
    ).toEqual(
      expect.arrayContaining([
        "all",
        "allTextContents",
        "and",
        "check",
        "click",
        "count",
        "dblclick",
        "downloadMedia",
        "evaluate",
        "fill",
        "filter",
        "first",
        "getAttribute",
        "getByLabel",
        "getByPlaceholder",
        "getByRole",
        "getByTestId",
        "getByText",
        "innerText",
        "isEnabled",
        "isVisible",
        "last",
        "locator",
        "nth",
        "or",
        "press",
        "selectOption",
        "setChecked",
        "textContent",
        "type",
        "uncheck",
        "waitFor",
      ]),
    );
    expect(
      Object.getOwnPropertyNames(PlaywrightFrameLocator.prototype).filter(
        (name) => name !== "constructor",
      ),
    ).toEqual(
      expect.arrayContaining([
        "frameLocator",
        "getByLabel",
        "getByPlaceholder",
        "getByRole",
        "getByTestId",
        "getByText",
        "locator",
      ]),
    );
  });

  it("locator builder 惰性组合 selector，终结操作才发 command", async () => {
    const { execute, calls } = fakeExecute();
    const tab = createFacade(execute).tab("t-9");
    const locator = tab.playwright
      .getByRole("button", { name: "Save" })
      .filter({ hasText: "now", visible: true })
      .nth(1);
    expect(calls).toHaveLength(0);

    await expect(locator.count()).resolves.toBe(2);
    expect(calls.at(-1)).toEqual({
      method: "playwright",
      action: {
        name: "locator",
        operation: "count",
        selector:
          'internal:role=button[name="Save"i] >> internal:has-text="now"i >> visible=true >> nth=1',
      },
      tabId: "t-9",
    });
    await locator.fill("saved", { timeoutMs: 1000 });
    expect(calls.at(-1)).toMatchObject({
      method: "playwright",
      action: {
        name: "locator",
        operation: "fill",
        replace: true,
        value: "saved",
        timeoutMs: 1000,
      },
    });
  });

  it("RegExp matcher 支持 node_repl VM 创建的跨 Realm 值", async () => {
    const { execute, calls } = fakeExecute();
    const tab = createFacade(execute).tab("t-cross-realm");
    const crossRealmName = runInNewContext("/维生素 C/i") as RegExp;

    await tab.playwright.getByRole("heading", { name: crossRealmName }).count();

    expect(calls.at(-1)).toMatchObject({
      method: "playwright",
      action: {
        name: "locator",
        operation: "count",
        selector: "internal:role=heading[name=/维生素 C/i]",
      },
      tabId: "t-cross-realm",
    });
  });

  it("page waits/evaluate/DOM helpers/download 映射为 direct-return 语义", async () => {
    const { execute, calls } = fakeExecute();
    const tab = createFacade(execute).tab("t-1");
    await expect(
      tab.playwright.evaluate((arg: { value: string }) => arg.value, { value: "x" }),
    ).resolves.toBe("evaluated");
    await expect(tab.playwright.domSnapshot()).resolves.toContain('- heading "Example"');
    await expect(tab.playwright.elementInfo({ x: 10, y: 20 })).resolves.toMatchObject([
      { tagName: "button" },
    ]);
    await expect(tab.playwright.elementScreenshot({ x: 10, y: 20 })).resolves.toEqual(
      new Uint8Array([1, 2, 3]),
    );
    await tab.playwright.waitForURL("https://example.com", { waitUntil: "load", timeoutMs: 500 });
    expect(calls.at(-1)).toMatchObject({
      method: "playwright",
      action: { name: "waitForURL", url: "https://example.com", waitUntil: "load", timeoutMs: 500 },
    });
    const download = await tab.playwright.waitForEvent("download");
    await expect(download.path()).resolves.toBe("/tmp/file.txt");
  });

  it("and/or/filter 拒绝跨 tab locator，expectNavigation 先 wait 后 action", async () => {
    const { execute, calls } = fakeExecute();
    const browsers = createFacade(execute);
    const left = browsers.tab("a").playwright.locator("button");
    const right = browsers.tab("b").playwright.locator("button");
    expect(() => left.and(right)).toThrow("Locators must belong to the same tab");

    const tab = browsers.tab("a");
    await tab.playwright.expectNavigation(() => tab.playwright.locator("a").click(), {
      url: "https://example.com",
    });
    const last = calls.slice(-2);
    expect(last[0]).toMatchObject({ method: "playwright", action: { name: "waitForURL" } });
    expect(last[1]).toMatchObject({
      method: "playwright",
      action: { name: "locator", operation: "click" },
    });
  });

  it("cua/dom_cua escape hatches use direct-return semantics", async () => {
    const { execute, calls } = fakeExecute();
    const tab = createFacade(execute).tab("t-1");

    await tab.cua.click({ x: 1, y: 2, button: 3 });
    expect(calls.at(-1)).toMatchObject({ method: "click", x: 1, y: 2, button: "right" });
    expect(() => tab.cua.click({ x: 1, y: 2, button: 4 })).toThrow(
      "Unsupported CUA mouse button: 4",
    );
    await tab.cua.double_click({ x: 3, y: 4 });
    expect(calls.at(-1)).toMatchObject({ method: "click", x: 3, y: 4, doubleClick: true });
    await tab.cua.move({ x: 5, y: 6, keys: ["Shift"] });
    expect(calls.at(-1)).toMatchObject({
      method: "hover",
      x: 5,
      y: 6,
      modifiers: ["Shift"],
    });
    await tab.cua.scroll({
      x: 5,
      y: 6,
      scrollX: 0,
      scrollY: 100,
      keypress: ["Control"],
    });
    expect(calls.at(-1)).toMatchObject({
      method: "cuaScroll",
      x: 5,
      y: 6,
      scrollX: 0,
      scrollY: 100,
      modifiers: ["Control"],
    });
    await tab.cua.drag({
      path: [
        { x: 1, y: 1 },
        { x: 4, y: 7 },
        { x: 9, y: 9 },
      ],
    });
    expect(calls.at(-1)).toMatchObject({
      method: "cuaDrag",
      path: [
        { x: 1, y: 1 },
        { x: 4, y: 7 },
        { x: 9, y: 9 },
      ],
    });
    await tab.cua.keypress({ keys: ["ControlOrMeta", "A"] });
    expect(calls.at(-1)).toMatchObject({
      method: "cuaKeypress",
      keys: ["ControlOrMeta", "A"],
    });
    await tab.cua.type({ text: "hi" });
    expect(calls.at(-1)).toMatchObject({ method: "type", text: "hi" });

    await expect(tab.dom_cua.get_visible_dom()).resolves.toMatchObject({
      url: "https://example.com",
    });
    await tab.dom_cua.click({ node_id: "n1" });
    expect(calls.at(-1)).toMatchObject({ method: "click", ref: "n1" });
    await tab.dom_cua.scroll({ node_id: "n1", x: 3, y: 40 });
    expect(calls.at(-1)).toMatchObject({
      method: "domCuaScroll",
      nodeId: "n1",
      scrollX: 3,
      scrollY: 40,
    });
    const strictTab = (await createFacade(execute).getDefault()).default;
    expect("downloadMedia" in strictTab.cua).toBe(false);
    expect("downloadMedia" in strictTab.dom_cua).toBe(false);
  });

  it("browser.documentation() and agent.documentation.get() load plugin docs", async () => {
    const { execute } = fakeExecute();
    const browsers = createFacade(execute, [IAB_INFO], {
      documentationRoot: resolve(process.cwd(), "../browser-use-plugin/docs"),
    });
    const doc = await (await browsers.getDefault()).documentation();
    for (const kw of [
      "# Selected Browser",
      "- Name: ZCode In-app Browser",
      "- Type: iab",
      "- ID: iab-runtime-1",
      "API manifest",
      'agent.browsers.get("iab")',
      "Tabs",
      "BrowserCommandError",
      "setViewportSize(viewportSize: { width: number; height: number })",
      "viewportSize(): { width: number; height: number } | null",
      "waitForTimeout(timeoutMs: number)",
      "Never guess a label, accessible name, placeholder, selector, URL pattern",
      "If the latest snapshot already contains the target",
      "execute JavaScript in the page context",
      "If `count() === 0`",
      "at most 3000ms",
      "do not loop over guessed URL variants",
      "ambient UI state, not a browser-selection instruction",
    ]) {
      expect(doc).toContain(kw);
    }
    expect(doc).toContain("Recreate this browser wrapper in every fresh Browser Use call");
    expect(doc).not.toContain("Reuse this browser binding across later turns");
    expect(doc).not.toContain("# Screenshots");
    expect(doc).toContain("nodeRepl.emitImage(await tab.screenshot())");
    expect(doc).toContain("Never use tab.screenshot() as the final expression");

    const globals: Record<string, unknown> = {};
    setupBrowserRuntime({
      globals,
      transport: {
        list: async () => [IAB_INFO],
        execute: async () => ({ ok: true, elapsedMs: 0 }),
      },
      documentationRoot: resolve(process.cwd(), "../browser-use-plugin/docs"),
    });
    const screenshots = await (
      globals.agent as { documentation: { get(name: string): Promise<string> } }
    ).documentation.get("screenshots");
    expect(screenshots).toContain("# Screenshots");
    expect(screenshots).toContain("nodeRepl.emitImage(await tab.screenshot())");
    expect(screenshots).toContain("Never use `await tab.screenshot()` as the final expression");
    await expect(
      (
        globals.agent as { documentation: { get(name: string): Promise<string> } }
      ).documentation.get("missing-guide"),
    ).rejects.toThrow(/not found/i);
  });

  it("rejects a cached browser object once the runtime binding is stale", async () => {
    const { execute } = fakeExecute();
    let stale = false;
    const assertAvailable = () => {
      if (stale) throw new Error("Browser runtime binding is stale after kernel reset");
    };
    const browsers = createFacade(execute, [IAB_INFO], {
      assertAvailable,
      documentationRoot: resolve(process.cwd(), "../browser-use-plugin/docs"),
    });
    const iab = await browsers.get("iab");

    await expect(iab.documentation()).resolves.toContain("# Selected Browser");
    stale = true;

    await expect(iab.documentation()).rejects.toThrow("stale");
    await expect(iab.capabilities.list()).rejects.toThrow("stale");
    await expect(iab.tabs.list()).rejects.toThrow("stale");

    stale = false;
    await expect(iab.documentation()).resolves.toContain("# Selected Browser");
  });

  it("exposes the PlaywrightAPI wait path without inventing a root Tab alias", async () => {
    const { execute } = fakeExecute();
    const tab = createFacade(execute).tab("t-1");
    expect(typeof tab.playwright.waitForTimeout).toBe("function");
    expect((tab as unknown as { waitForTimeout?: unknown }).waitForTimeout).toBeUndefined();
    expect("waitForTimeout" in tab).toBe(false);
    expect(
      (tab.playwright as unknown as { setObjectWrapper?: unknown }).setObjectWrapper,
    ).toBeUndefined();
    const locator = tab.playwright.locator("button") as unknown as {
      action?: unknown;
      selector?: unknown;
    };
    expect(locator.action).toBeUndefined();
    expect(locator.selector).toBeUndefined();
  });

  it("setupBrowserRuntime injects agent.browsers into globals", () => {
    const { execute } = fakeExecute();
    const globals: Record<string, unknown> = {};
    setupBrowserRuntime({
      globals,
      transport: {
        list: async () => [IAB_INFO],
        execute: async (_browserId, _browserGeneration, command) => execute(command),
      },
    });
    const agent = globals.agent as { browsers: BrowsersFacade };
    expect(agent.browsers).toBeInstanceOf(BrowsersFacade);
    expect(typeof agent.browsers.list).toBe("function");
    // 设计反转（2026-08-24）：open() 从「兼容入口、刻意隐藏」改为默认导航入口
    // （同站复用 + 激活 + 原地跳转），必须在 hideUnknown 代理表面可见。
    expect(typeof (agent.browsers as unknown as { open?: unknown }).open).toBe("function");
  });
});
