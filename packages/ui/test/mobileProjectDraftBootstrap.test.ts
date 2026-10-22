// @vitest-environment jsdom
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useRootPlatformEffects } from "@/root/useRootPlatformEffects.js";
import { persistV4ComposerDraft, V4_DRAFT_SCOPE_ROOT } from "@/v4/composer/composerDraftStore.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
vi.mock("@/hooks/useWorkspaceServices.js", () => ({
  useOptionalBaseWorkspaceServices: () => null,
}));
vi.mock("@/store/TabStoreProvider.js", () => ({
  useTabStore: (selector: (value: unknown) => unknown) => selector({ tabs: [], activeTabId: null }),
}));
vi.mock("@/lib/rendererNavigation.js", () => ({ isRendererReloadNavigation: () => false }));
beforeEach(() => {
  localStorage.clear();
  useZCodeSessionStore.setState({ workspaces: {} });
});
afterEach(cleanup);
function mount(options: Partial<Parameters<typeof useRootPlatformEffects>[0]> = {}) {
  const startDraftInWorkspace = vi.fn();
  const subscribe = () => () => {};
  const platform = {
    onFocusTab: subscribe,
    onNewTab: subscribe,
    onNewTask: subscribe,
    onOpenWorkspace: subscribe,
    onTaskNotificationClick: subscribe,
    syncWindowTabs: vi.fn(),
    syncWindowUnreadCount: vi.fn(),
    syncActiveTaskSession: vi.fn(),
    setApplicationLocale: vi.fn(async () => {}),
  };
  renderHook(() =>
    useRootPlatformEffects({
      initialWorkspaceAbsPath: "/cwd",
      initialWorkspaceIdentity: "remote:server:s:/cwd",
      clientMode: "web-remote-replayable",
      addTab: vi.fn(),
      setIsBootstrappingInitialWorkspace: vi.fn(),
      platform: platform as never,
      activateTabByPath: vi.fn(() => true),
      startDraftInWorkspace,
      startNewTaskFromActiveWorkspace: vi.fn(),
      openWorkspace: vi.fn(),
      openWorkspacePath: vi.fn(),
      setWorkspaceActionError: vi.fn(),
      isDesktop: false,
      locale: "en-US",
      tabs: [],
      totalUnreadTaskCount: 0,
      intl: { formatMessage: ({ id }: { id: string }) => id } as never,
      isRestoringOAuthSession: false,
      ...options,
    }),
  );
  return startDraftInWorkspace;
}
it("mobile Root recreation restores project under the same identity before initializing the draft", () => {
  persistV4ComposerDraft("/cwd", "remote:server:s:/cwd", V4_DRAFT_SCOPE_ROOT, {
    text: "unsent",
    projectId: "p",
    taskGroupId: "g",
  });
  const start = mount();
  expect(start).toHaveBeenCalledWith("/cwd", "remote:server:s:/cwd", {
    projectId: "p",
    taskGroupId: "g",
  });
});
it("explicit new unclassified intent wins over a saved project draft", () => {
  persistV4ComposerDraft("/cwd", "remote:server:s:/cwd", V4_DRAFT_SCOPE_ROOT, {
    text: "unsent",
    projectId: "p",
  });
  const start = mount({ initialTaskDraft: { projectId: null } });
  expect(start).toHaveBeenCalledWith("/cwd", "remote:server:s:/cwd", { projectId: null });
});
it("desktop continuous and another remote identity do not restore this mobile project", () => {
  persistV4ComposerDraft("/cwd", "remote:server:s:/cwd", V4_DRAFT_SCOPE_ROOT, {
    text: "unsent",
    projectId: "p",
  });
  const desktop = mount({ clientMode: "desktop-continuous" });
  expect(desktop).toHaveBeenCalledWith("/cwd", "remote:server:s:/cwd", undefined);
  const other = mount({ initialWorkspaceIdentity: "remote:server:other:/cwd" });
  expect(other).toHaveBeenCalledWith("/cwd", "remote:server:other:/cwd", undefined);
});
it("an explicit task opens directly and never initializes a project draft", () => {
  const start = mount({ initialTaskId: "existing" });
  expect(start).not.toHaveBeenCalled();
  expect(
    useZCodeSessionStore.getState().getWorkspaceState("/cwd", "remote:server:s:/cwd").activeTaskId,
  ).toBe("existing");
});
