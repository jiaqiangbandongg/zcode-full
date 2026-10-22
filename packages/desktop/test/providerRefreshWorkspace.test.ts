import { runInNewContext } from "node:vm";
import { afterEach, expect, it, vi } from "vitest";
import { refreshSeededOpenAIProvidersThroughSettings } from "#e2e/helpers/custom-openai-provider";
import { waitForWorkspaceApp } from "#e2e/helpers/desktop-app";

vi.mock("#e2e/helpers/desktop-app", () => ({
  DEFAULT_WORKSPACE: "/fixture/ZCodeProject",
  clickTestIdByDom: vi.fn(),
  waitForWorkspaceApp: vi.fn(),
}));
vi.mock("#e2e/helpers/custom-openai-provider-store", () => ({}));
vi.mock("#e2e/helpers/upstream-provider", () => ({}));
vi.mock("#e2e/helpers/e2e-electron-reload", () => ({}));
vi.mock("#e2e/helpers/personal-provider-settings", () => ({}));
vi.mock("#e2e/helpers/provider-model-metadata-dialog", () => ({}));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function install() {
  const document = {
    body: { innerText: "Fixture provider" },
    querySelectorAll: () => [
      {
        getAttribute: (name: string) => (name === "aria-label" ? "Refresh" : null),
        disabled: false,
        click: vi.fn(),
      },
    ],
  };
  const window = {
    __zcodeTabStoreE2E: { getState: () => ({ activeWorkspacePath: "/fixture/unclassified" }) },
  };
  vi.stubGlobal("$", () => ({ waitForDisplayed: vi.fn() }));
  vi.stubGlobal("browser", {
    execute: async (fn: (...args: unknown[]) => unknown, ...args: unknown[]) =>
      runInNewContext(`(${fn.toString()})(...args)`, { document, window, args }),
    waitUntil: async (predicate: () => Promise<boolean>) => {
      expect(await predicate()).toBe(true);
    },
  });
}

it("刷新 Personal provider 后返回原未分类工作区，不等待未激活的默认项目", async () => {
  install();
  await refreshSeededOpenAIProvidersThroughSettings(["Fixture provider"]);
  expect(waitForWorkspaceApp).toHaveBeenCalledWith("/fixture/unclassified", 30_000);
});

it("显式指定的返回工作区保持优先", async () => {
  install();
  await refreshSeededOpenAIProvidersThroughSettings(["Fixture provider"], {
    workspacePath: "/explicit",
  });
  expect(waitForWorkspaceApp).toHaveBeenCalledWith("/explicit", 30_000);
});
