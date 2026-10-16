// @vitest-environment jsdom

import type { Hook } from "@zcode/shared";
import { createElement } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { HooksList } from "@/settings/HooksList.js";

function untrustedWorkspaceHook(): Hook {
  return {
    id: "workspace-hook-row",
    event: "SessionStart",
    type: "command",
    command: "echo project",
    enabled: true,
    workspaceHook: {
      reviewItemId: "item-0",
      workspaceIdentity: "workspace:repo",
      bundleDigest: "b".repeat(64),
      hookDeclarationDigest: "a".repeat(64),
      sourceFileIndex: 0,
      sourceRootEnabled: true,
      declarationEnabled: true,
      runtimeHooksEnabled: true,
      configuredEnabled: true,
      sourcePath: ".zcode/config.json",
      trustState: "pending_trust",
    },
  };
}

afterEach(() => cleanup());

describe("Workspace Hook 行内 Trust 交互", () => {
  it("Trust 点击不冒泡打开编辑，未信任开关不可触发配置写入", () => {
    const onEdit = vi.fn();
    const onToggle = vi.fn(async () => undefined);
    const onTrust = vi.fn(async () => undefined);
    render(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "en-US" },
        createElement(
          TooltipProvider,
          null,
          createElement(HooksList, {
            compatibilityHooks: [],
            editableHooks: [untrustedWorkspaceHook()],
            operatingHookId: null,
            pluginHooks: [],
            trustActionAvailable: true,
            trustingHookId: null,
            onEdit,
            onImport: async () => undefined,
            onToggle,
            onTrust,
          }),
        ),
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: "Trust" }));
    expect(onTrust).toHaveBeenCalledTimes(1);
    expect(onEdit).not.toHaveBeenCalled();

    const toggle = screen.getByRole("switch");
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect((toggle as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(toggle);
    expect(onToggle).not.toHaveBeenCalled();
    expect(onEdit).not.toHaveBeenCalled();
  });
});
