// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useWorkspaceMainViewSettingsExit } from "@/app-shell/useWorkspaceMainViewSettingsExit.js";

describe("useWorkspaceMainViewSettingsExit", () => {
  it("only returns the workspace main view to chat after the settings layer closes", () => {
    const onExitSettings = vi.fn();
    const hook = renderHook(
      ({ isWorkspaceVisible, workspaceMainView }) =>
        useWorkspaceMainViewSettingsExit({
          isWorkspaceVisible,
          workspaceMainView,
          onExitSettings,
        }),
      {
        initialProps: {
          isWorkspaceVisible: true,
          workspaceMainView: "automations" as const,
        },
      },
    );

    expect(onExitSettings).not.toHaveBeenCalled();

    hook.rerender({
      isWorkspaceVisible: false,
      workspaceMainView: "automations",
    });
    expect(onExitSettings).not.toHaveBeenCalled();

    hook.rerender({
      isWorkspaceVisible: true,
      workspaceMainView: "automations",
    });
    expect(onExitSettings).toHaveBeenCalledTimes(1);

    hook.rerender({
      isWorkspaceVisible: true,
      workspaceMainView: "automations",
    });
    expect(onExitSettings).toHaveBeenCalledTimes(1);
  });

  it("preserves an explicit plugin store navigation while settings closes", () => {
    const onExitSettings = vi.fn();
    const hook = renderHook(
      ({ isWorkspaceVisible, workspaceMainView }) =>
        useWorkspaceMainViewSettingsExit({
          isWorkspaceVisible,
          workspaceMainView,
          onExitSettings,
        }),
      {
        initialProps: {
          isWorkspaceVisible: false,
          workspaceMainView: "chat" as "chat" | "plugin-store",
        },
      },
    );

    hook.rerender({
      isWorkspaceVisible: false,
      workspaceMainView: "plugin-store",
    });
    hook.rerender({
      isWorkspaceVisible: true,
      workspaceMainView: "plugin-store",
    });

    expect(onExitSettings).not.toHaveBeenCalled();
  });

  it("preserves plugin store when explicit navigation targets the already-open store", () => {
    const onExitSettings = vi.fn();
    const hook = renderHook(
      ({ isWorkspaceVisible }) =>
        useWorkspaceMainViewSettingsExit({
          isWorkspaceVisible,
          workspaceMainView: "plugin-store",
          onExitSettings,
        }),
      { initialProps: { isWorkspaceVisible: true } },
    );

    hook.rerender({ isWorkspaceVisible: false });
    act(() => hook.result.current.preserveNextSettingsExit());
    hook.rerender({ isWorkspaceVisible: true });

    expect(onExitSettings).not.toHaveBeenCalled();
  });
});
