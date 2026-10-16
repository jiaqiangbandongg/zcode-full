// @vitest-environment jsdom

import type { Hook } from "@zcode/shared";
import { createElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { HooksSection } from "@/settings/HooksSection.js";

const hooksStateMock = vi.hoisted(() => ({
  workspacePath: "/workspace-a",
  workspaceIdentity: null as string | null,
  loadedWorkspaceKey: "/workspace-a" as string | null,
  hooks: [] as Hook[],
  loading: false,
  error: null as string | null,
  operatingHookId: null as string | null,
  initialize: vi.fn(async () => undefined),
  refresh: vi.fn(async () => undefined),
  addHook: vi.fn(async () => undefined),
  updateHook: vi.fn(async () => undefined),
  deleteHook: vi.fn(async () => undefined),
  toggleHook: vi.fn(async () => undefined),
  importHook: vi.fn(async () => undefined),
}));

const pluginStoreStateMock = vi.hoisted(() => ({
  plugins: [],
  availablePlugins: [],
  installedPlugins: [],
  marketplaceAvailabilityKnown: true,
  loading: false,
  error: null,
  initialize: vi.fn(async () => undefined),
}));

const serviceResolutionMock = vi.hoisted(() => ({
  rpcReady: true,
}));

vi.mock("@/store/hooksStore.js", () => ({
  useHooksStore: () => hooksStateMock,
}));

vi.mock("@/store/pluginManagementStore.js", () => ({
  usePluginManagementStore: (selector: (state: typeof pluginStoreStateMock) => unknown) =>
    selector(pluginStoreStateMock),
}));

vi.mock("@/hooks/useWorkspaceServices.js", () => ({
  useWorkspaceServicesResolution: () => ({
    rpcReady: serviceResolutionMock.rpcReady,
    services: {
      hooksService: {},
      pluginManagementService: {},
    },
  }),
}));

vi.mock("@/hooks/useConfirmDialog.js", () => ({
  useConfirmDialog: () => vi.fn(async () => false),
}));

vi.mock("@/hooks/useZCodeSessionService.js", () => ({
  useZCodeSessionService: () => undefined,
}));

vi.mock("@/store/TabStoreProvider.js", () => ({
  useTabStore: (selector: (state: { tabs: [] }) => unknown) => selector({ tabs: [] }),
}));

vi.mock("@/store/workspaceHookReviewStore.js", () => ({
  useWorkspaceHookReviewStore: (selector: (state: { bindings: Record<string, never> }) => unknown) =>
    selector({ bindings: {} }),
}));

vi.mock("@/settings/useWorkspaceHookInlineTrust.js", () => ({
  useWorkspaceHookInlineTrust: () => ({
    trustActionAvailable: false,
    trustingHookId: null,
    trustHook: vi.fn(async () => undefined),
  }),
}));

vi.mock("@/settings/SettingsSearchInput.js", () => ({
  SettingsSearchInput: ({
    onChange,
    placeholder,
    value,
  }: {
    onChange: (event: { target: { value: string } }) => void;
    placeholder: string;
    value: string;
  }) => createElement("input", { "aria-label": "hooks-search", onChange, placeholder, value }),
}));

// 只替换 React 组件，两个纯函数（getPluginWorkspaceKey / isPluginScopeWorkspaceConnected）
// 走真实实现。此前手写整份 mock，导致源码新增 isPluginScopeWorkspaceConnected 后本用例直接崩
// （"No export is defined on the mock"）；用 importOriginal 可以从结构上避免这类漂移。
vi.mock("@/settings/PluginScopeMenu.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/settings/PluginScopeMenu.js")>()),
  PluginScopeMenu: () => null,
}));

vi.mock("@/settings/HookForm.js", () => ({ HookForm: () => null }));
vi.mock("@/settings/SettingsHeaderBreadcrumb.js", () => ({ SettingsBreadcrumbReporter: () => null }));
vi.mock("@/settings/SettingsResourceHeaderActions.js", () => ({ SettingsResourceHeaderActions: () => null }));
vi.mock("@/settings/HooksList.js", () => ({ HooksList: () => null }));
vi.mock("@/settings/pluginStoreListing.js", () => ({ formatCanonicalPluginName: (name: string) => name }));
vi.mock("@/components/ui/button.js", () => ({
  Button: ({ children }: { children?: unknown }) => createElement("button", null, children),
}));
vi.mock("@/components/ui/toast.js", () => ({ toast: vi.fn() }));
vi.mock("@/lib/zcodeDraftSkillInvalidation.js", () => ({
  invalidateDeferredDraftSessionForRuntimeChange: vi.fn(async () => undefined),
}));
vi.mock("@/settings/PluginInstallEmptyState.js", () => ({
  PluginLoadingState: ({ label }: { label: string }) => createElement("div", null, label),
  PluginSearchEmptyState: ({ label }: { label: string }) => createElement("div", null, label),
}));

function workspaceHook(): Hook {
  return {
    id: "workspace-pending",
    event: "PreToolUse",
    type: "command",
    command: "echo review",
    enabled: true,
    editable: false,
    location: {
      source: "zcode",
      scope: "user",
      directoryPath: "/workspace-a/.zcode",
      projectPath: "/workspace-a",
    },
    workspaceHook: {
      sourceRootEnabled: true,
      declarationEnabled: true,
      runtimeHooksEnabled: true,
      configuredEnabled: true,
      sourcePath: "/workspace-a/.zcode/config.json",
      reviewItemId: "review-pending",
      workspaceIdentity: "/workspace-a",
      bundleDigest: "a".repeat(64),
      hookDeclarationDigest: "b".repeat(64),
      sourceFileIndex: 0,
      trustState: "pending_trust",
    },
  };
}

function renderHooksSection() {
  return render(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "en-US" },
      createElement(HooksSection, { workspacePath: hooksStateMock.workspacePath }),
    ),
  );
}

describe("HooksSection workspace Hook Trust notice", () => {
  beforeEach(() => {
    hooksStateMock.workspacePath = "/workspace-a";
    hooksStateMock.workspaceIdentity = null;
    hooksStateMock.loadedWorkspaceKey = "/workspace-a";
    hooksStateMock.hooks = [workspaceHook()];
    hooksStateMock.loading = false;
    hooksStateMock.error = null;
    serviceResolutionMock.rpcReady = true;
  });

  afterEach(() => cleanup());

  it("keeps the scope notice visible when search filters every hook row", async () => {
    renderHooksSection();

    fireEvent.change(screen.getByLabelText("hooks-search"), {
      target: { value: "does-not-match" },
    });

    await waitFor(() => {
      expect(screen.getByTestId("workspace-hook-trust-notice")).toBeTruthy();
    });
  });

  it("hides the old snapshot notice while the target workspace is connecting", () => {
    hooksStateMock.workspacePath = "/workspace-b";
    hooksStateMock.loadedWorkspaceKey = "/workspace-a";
    serviceResolutionMock.rpcReady = false;

    renderHooksSection();

    expect(screen.queryByTestId("workspace-hook-trust-notice")).toBeNull();
  });
});
