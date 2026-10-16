// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => {
  const tabs = { activeWorkspacePath: "/workspace", activeWorkspaceIdentity: "host-a" };
  const pane = { focusedPaneId: "primary", panes: {} };
  const group = { activeGroupId: null, groups: {} };
  const list = vi.fn();
  const resolution = {
    rpcReady: true,
    services: { skillsService: { list } },
    remoteSessionId: "attachment-a",
  };
  return { tabs, pane, group, list, resolution, toast: vi.fn() };
});
vi.mock("@/hooks/useWorkspaceServices.js", () => ({
  useWorkspaceServicesResolution: () => mocks.resolution,
}));
vi.mock("@/store/TabStoreProvider.js", () => ({
  useTabStore: (select: (s: unknown) => unknown) => select(mocks.tabs),
  useTabStoreApi: () => ({ getState: () => mocks.tabs }),
}));
vi.mock("@/store/tabStore.js", () => ({ isWorkspaceReadOnly: () => false }));
vi.mock("@/v4/paneLayoutStore.js", () => ({
  INITIAL_PANE_LAYOUT: mocks.pane,
  usePaneLayoutStore: Object.assign((select: (s: unknown) => unknown) => select(mocks.pane), {
    getState: () => mocks.pane,
  }),
}));
vi.mock("@/v4/workbenchGroupStore.js", () => ({
  useWorkbenchGroupStore: Object.assign((select: (s: unknown) => unknown) => select(mocks.group), {
    getState: () => mocks.group,
  }),
}));
vi.mock("@/v4/workbenchNewTaskTarget.js", () => ({
  resolveWorkbenchNewTaskTarget: (s: {
    activeWorkspacePath: string;
    activeWorkspaceIdentity: string;
  }) => ({ workspacePath: s.activeWorkspacePath, workspaceIdentity: s.activeWorkspaceIdentity }),
}));
vi.mock("@/components/ui/toast.js", () => ({ toast: mocks.toast }));
vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({ intl: { formatMessage: ({ id }: { id: string }) => id } }),
}));
vi.mock("@/logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn() } }));
import { usePluginCreator } from "@/hooks/usePluginCreator.js";
const skill = {
  id: "creator",
  name: "plugin-creator",
  scope: "plugin",
  enabled: true,
  path: "/workspace/creator/SKILL.md",
  pluginId: "plugin-creator@zcode-plugins-official",
  description: "Create",
  body: "",
};
let root: ReturnType<typeof createRoot> | undefined;
afterEach(async () => {
  if (root) await act(() => root?.unmount());
  root = undefined;
  vi.clearAllMocks();
  mocks.tabs.activeWorkspaceIdentity = "host-a";
  mocks.resolution.remoteSessionId = "attachment-a";
  mocks.resolution.rpcReady = true;
});
async function mount(onCreate: () => void) {
  let api!: ReturnType<typeof usePluginCreator>;
  function Component() {
    api = usePluginCreator(onCreate);
    return null;
  }
  root = createRoot(document.createElement("div"));
  const render = () => act(() => root?.render(createElement(Component)));
  await render();
  return { get: () => api, render };
}
describe("creator action admission", () => {
  it("coalesces duplicate clicks and creates one unsent draft with target identity", async () => {
    let finish!: (r: unknown) => void;
    mocks.list.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const create = vi.fn();
    const app = await mount(create);
    let pending!: Promise<void>;
    await act(async () => {
      pending = app.get().create();
      void app.get().create();
    });
    expect(mocks.list).toHaveBeenCalledTimes(1);
    expect(mocks.list).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceIdentity: "host-a", workspacePath: "/workspace" }),
    );
    await act(async () => {
      finish({ skills: [skill] });
      await pending;
    });
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedWorkspaceKey: "host-a",
        initialPrompt: "[$plugin-creator](/workspace/creator/SKILL.md) ",
      }),
    );
  });
  it.each(["identity", "attachment"])(
    "discards a pending lookup after %s changes",
    async (kind) => {
      let finish!: (r: unknown) => void;
      mocks.list.mockImplementation(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      const create = vi.fn();
      const app = await mount(create);
      let pending!: Promise<void>;
      await act(async () => {
        pending = app.get().create();
      });
      if (kind === "identity") mocks.tabs.activeWorkspaceIdentity = "host-b";
      else mocks.resolution.remoteSessionId = "attachment-b";
      await app.render();
      await act(async () => {
        finish({ skills: [skill] });
        await pending;
      });
      expect(create).not.toHaveBeenCalled();
    },
  );
  it("reports disabled creator without creating or enabling anything", async () => {
    mocks.list.mockResolvedValue({ skills: [{ ...skill, enabled: false }] });
    const create = vi.fn();
    const app = await mount(create);
    await act(() => app.get().create());
    expect(create).not.toHaveBeenCalled();
    expect(mocks.toast).toHaveBeenCalled();
  });
  it.each(["missing", "failure", "disconnected"])(
    "reports %s without inserting a reference",
    async (kind) => {
      if (kind === "failure") mocks.list.mockRejectedValue(new Error("unavailable"));
      else mocks.list.mockResolvedValue({ skills: [] });
      if (kind === "disconnected") mocks.resolution.rpcReady = false;
      const create = vi.fn();
      const app = await mount(create);
      await act(() => app.get().create());
      expect(create).not.toHaveBeenCalled();
      expect(mocks.toast).toHaveBeenCalled();
      if (kind === "disconnected") expect(mocks.list).not.toHaveBeenCalled();
    },
  );
});
