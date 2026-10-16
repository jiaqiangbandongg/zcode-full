import { describe, expect, it } from "vitest";
import {
  isProviderStartupSyncPending,
  shouldEnableProviderAvailabilityLoginEntryGuard,
  shouldResolveProviderStartupState,
  shouldBlockRootRender,
  shouldShowRootStartupLoading,
  shouldOpenFallbackWorkspaceAfterCreate,
} from "@/lib/rootStartupGate.js";

describe("Root startup gate", () => {
  it("会在恢复标签页时阻塞首屏", () => {
    expect(
      shouldBlockRootRender({
        isResolvingStartupAuthState: false,
        isResolvingProviderStartupState: false,
        isRestoring: true,
        isBootstrappingInitialWorkspace: false,
      }),
    ).toBe(true);
  });

  it("会在注入初始工作区时阻塞首屏", () => {
    expect(
      shouldBlockRootRender({
        isResolvingStartupAuthState: false,
        isResolvingProviderStartupState: false,
        isRestoring: false,
        isBootstrappingInitialWorkspace: true,
      }),
    ).toBe(true);
  });

  it("会在启动鉴权状态未落定时阻塞首屏", () => {
    expect(
      shouldBlockRootRender({
        isResolvingStartupAuthState: true,
        isResolvingProviderStartupState: false,
        isRestoring: false,
        isBootstrappingInitialWorkspace: false,
      }),
    ).toBe(true);
  });

  it("会在 provider 登录入口判定未落定时阻塞首屏", () => {
    expect(
      shouldBlockRootRender({
        isResolvingStartupAuthState: false,
        isResolvingProviderStartupState: true,
        isRestoring: false,
        isBootstrappingInitialWorkspace: false,
      }),
    ).toBe(true);
  });

  it("所有启动检查完成后才放行首屏", () => {
    expect(
      shouldBlockRootRender({
        isResolvingStartupAuthState: false,
        isResolvingProviderStartupState: false,
        isRestoring: false,
        isBootstrappingInitialWorkspace: false,
      }),
    ).toBe(false);
  });

  it("provider 启动同步未完成时会延后首屏放行", () => {
    const providerStartupSyncPending = isProviderStartupSyncPending({
      providerFamilyDomainMigrationComplete: false,
      modelSelectionViewHydrated: true,
    });
    expect(providerStartupSyncPending).toBe(true);
    expect(
      shouldBlockRootRender({
        isResolvingStartupAuthState: false,
        isResolvingProviderStartupState: providerStartupSyncPending,
        isRestoring: false,
        isBootstrappingInitialWorkspace: false,
      }),
    ).toBe(true);
  });

  it("Web 远控 Root 不运行 provider 登录入口守卫", () => {
    expect(
      shouldEnableProviderAvailabilityLoginEntryGuard({
        isWebRemoteControlRoot: true,
      }),
    ).toBe(false);
  });

  it("Web 远控 Root 不把 provider 启动态作为 workspace 注入门禁", () => {
    expect(
      shouldResolveProviderStartupState({
        isWebRemoteControlRoot: true,
        providerStartupSyncPending: true,
        providerAvailabilityStartupCheckCompleted: false,
      }),
    ).toBe(false);
  });

  it("桌面 Root 继续等待 provider 启动检查落定", () => {
    expect(
      shouldResolveProviderStartupState({
        isWebRemoteControlRoot: false,
        providerStartupSyncPending: false,
        providerAvailabilityStartupCheckCompleted: false,
      }),
    ).toBe(true);
  });

  it("登录入口已经打开时不应继续显示启动 loading", () => {
    expect(
      shouldShowRootStartupLoading({
        isDesktop: true,
        welcomeScreenOpen: true,
        isResolvingStartupAuthState: false,
        isResolvingProviderStartupState: true,
        isRestoring: false,
        isBootstrappingInitialWorkspace: false,
      }),
    ).toBe(false);
  });

  it("兜底默认 workspace 返回时如果已经恢复出 active workspace，就不再抢占当前 tab", () => {
    expect(
      shouldOpenFallbackWorkspaceAfterCreate({
        isMounted: true,
        activeWorkspacePath: "/Users/dev/workspace/cgx-dev-web",
      }),
    ).toBe(false);
  });
});
