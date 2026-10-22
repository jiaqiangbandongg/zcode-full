// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Hook } from "@zcode/shared";
import type { IHooksService } from "@zcode/services";
import { useWorkspaceHookInlineTrust } from "@/settings/useWorkspaceHookInlineTrust.js";
import { useHooksStore } from "@/store/hooksStore.js";
import { useWorkspaceHookReviewStore } from "@/store/workspaceHookReviewStore.js";

vi.mock("@/hooks/useServices.js", () => ({
  useServices: () => ({}),
}));

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({ intl: { formatMessage: ({ id }: { id: string }) => id } }),
}));

vi.mock("@/components/ui/toast.js", () => ({ toast: vi.fn() }));

beforeEach(() => {
  useHooksStore.setState({
    workspacePath: null,
    workspaceIdentity: null,
    authorityKey: null,
    loadedWorkspaceKey: null,
    hooks: [],
    loading: false,
    error: null,
    operatingHookId: null,
  });
  useWorkspaceHookReviewStore.setState({ bindings: {}, commandBindings: {} });
});

describe("useWorkspaceHookInlineTrust Source authority", () => {
  it("refreshes the same authority bucket after granting trust", async () => {
    const loadHooks = vi.fn(async () => ({ hooks: [], hooksEnabled: true }));
    const service: IHooksService = {
      loadHooks,
      saveHooks: vi.fn(async () => undefined),
      grantWorkspaceHookTrust: vi.fn(async () => ({ accepted: true })),
    };
    await useHooksStore
      .getState()
      .initialize("/root", "workspace:repo", service, "source-settings:a");
    const { result } = renderHook(() =>
      useWorkspaceHookInlineTrust({
        workspacePath: "/root",
        workspaceIdentity: "workspace:repo",
        authorityKey: "source-settings:a",
        hooksService: service,
        rpcReady: true,
      }),
    );
    const hook: Hook = {
      id: "source-hook",
      event: "SessionStart",
      type: "command",
      command: "echo source",
      enabled: false,
      workspaceHook: {
        reviewItemId: "item",
        workspaceIdentity: "workspace:repo",
        bundleDigest: "b".repeat(64),
        hookDeclarationDigest: "a".repeat(64),
        sourceFileIndex: 0,
        sourceRootEnabled: true,
        declarationEnabled: false,
        runtimeHooksEnabled: true,
        configuredEnabled: false,
        sourcePath: ".zcode/config.json",
        trustState: "pending_trust",
      },
    };

    await act(async () => await result.current.trustHook(hook));

    expect(service.grantWorkspaceHookTrust).toHaveBeenCalledOnce();
    expect(loadHooks).toHaveBeenCalledTimes(2);
  });
});
