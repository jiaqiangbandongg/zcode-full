import { runInNewContext } from "node:vm";
import { afterEach, expect, it, vi } from "vitest";
import { readRemoteTabSnapshot, selectSSHRemoteDirectory } from "#e2e/helpers/ssh-remote-p0";

vi.mock("#e2e/helpers/desktop-app", () => ({ waitForWorkspaceApp: vi.fn() }));
vi.mock("#e2e/helpers/project-sidebar", () => ({ selectRemoteProjectDirectory: vi.fn() }));
vi.mock("#e2e/helpers/custom-openai-provider-store", () => ({}));
afterEach(() => vi.unstubAllGlobals());

it.each([false, true])(
  "同路径第二个 Source 按新项目 identity 等待，支持预选目录编辑器=%s",
  async (prefilledEditor) => {
    const first = "remote:server:11111111-1111-4111-8111-111111111111:/work";
    const second = "remote:server:22222222-2222-4222-8222-222222222222:/work";
    const projectIds = ["existing"];
    let activeIdentity = first;
    let switching = false;
    let reads = 0;
    const document = {
      querySelectorAll: () => projectIds.map((id) => ({ getAttribute: () => id })),
    };
    const window = {
      __zcodeTabStoreE2E: {
        getState: () => {
          if (switching && ++reads > 1) activeIdentity = second;
          return {
            activeWorkspaceIdentity: activeIdentity,
            activeWorkspacePath: "/work",
            tabs: [first, second].map((identity) => ({
              workspaceIdentity: identity,
              workspacePath: "/work",
              remoteSessionId: identity === first ? "first-session" : "second-session",
              remoteTarget: { kind: "ssh", host: "127.0.0.1" },
            })),
          };
        },
      },
    };
    vi.stubGlobal("$", (selector: string) => {
      if (selector === '[data-testid="ssh-success"]') return { isExisting: async () => false };
      if (selector === '[data-testid="remote-project-new"]') {
        if (prefilledEditor) throw new Error("已在预选目录编辑器，不存在新建项目列表按钮");
        return { waitForEnabled: vi.fn(), click: vi.fn() };
      }
      if (selector === '[data-testid="virtual-project-name"]')
        return { setValue: vi.fn(), isDisplayed: async () => prefilledEditor };
      if (selector === '[data-testid="virtual-project-root-name"]')
        return { getAttribute: async () => "/work", isExisting: async () => true };
      if (selector === '[data-testid="virtual-project-directory-browser"]')
        return { isDisplayed: async () => false };
      if (selector === '[data-testid="virtual-project-save"]') return { click: vi.fn() };
      if (selector === '[data-testid="project-folder-trust-confirm"]')
        return { waitForDisplayed: vi.fn(), click: () => projectIds.push("new") };
      if (selector === '[data-testid="settings-back-button"]')
        return { isDisplayed: async () => false };
      if (selector === '[data-project-id="new"]')
        return {
          getAttribute: async () => second,
          moveTo: vi.fn(),
          $: () => ({
            click: () => {
              switching = true;
            },
          }),
        };
      throw new Error(`Unexpected selector: ${selector}`);
    });
    vi.stubGlobal("browser", {
      execute: async (fn: (...args: unknown[]) => unknown, ...args: unknown[]) =>
        runInNewContext(`(${fn.toString()})(...args)`, { args, document, window }),
      waitUntil: async (predicate: () => Promise<boolean>) => {
        for (let attempt = 0; attempt < 3; attempt++) if (await predicate()) return;
        throw new Error("Second Source did not become active");
      },
    });

    await selectSSHRemoteDirectory("/work", "E2E_SOURCE_SELECTION");
    expect(activeIdentity).toBe(second);
  },
);

it("无筛选条件时读取当前激活工作区，不能把不存在的路径当作无远程会话", async () => {
  const state = {
    activeWorkspaceIdentity: "remote:server:source-b:/work",
    activeWorkspacePath: "/work",
    tabs: [
      {
        workspaceIdentity: "remote:server:source-a:/work",
        workspacePath: "/work",
        remoteSessionId: "a",
      },
      {
        workspaceIdentity: "remote:server:source-b:/work",
        workspacePath: "/work",
        remoteSessionId: "b",
        remoteTarget: { kind: "ssh" },
      },
    ],
  };
  vi.stubGlobal("browser", {
    execute: async (fn: (...args: unknown[]) => unknown, ...args: unknown[]) =>
      runInNewContext(`(${fn.toString()})(...args)`, {
        args,
        window: { __zcodeTabStoreE2E: { getState: () => state } },
      }),
  });
  expect(await readRemoteTabSnapshot()).toMatchObject({
    remoteSessionId: "b",
    workspaceIdentity: state.activeWorkspaceIdentity,
  });
  state.activeWorkspaceIdentity = "";
  state.activeWorkspacePath = "/local";
  expect((await readRemoteTabSnapshot()).remoteSessionId).toBeNull();
  expect((await readRemoteTabSnapshot("remote:server:source-a:/work")).remoteSessionId).toBe("a");
});
