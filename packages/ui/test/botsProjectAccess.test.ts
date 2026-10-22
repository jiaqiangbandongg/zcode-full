// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { WorkspaceAccessCard } from "@/BotsDialog/WorkspaceAccessCard.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import type { BotConfig } from "@zcode/shared";
vi.mock("@/components/ui/select.js", () => ({
  Select: ({
    onValueChange,
    disabled,
    children,
  }: {
    onValueChange: (value: string) => void;
    disabled: boolean;
    children: unknown;
  }) =>
    createElement(
      "div",
      null,
      createElement(
        "button",
        { disabled, onClick: () => onValueChange("selected") },
        "select-projects",
      ),
      children,
    ),
  SelectContent: () => null,
  SelectItem: () => null,
  SelectTrigger: () => null,
  SelectValue: () => null,
}));
afterEach(cleanup);
it("切换指定项目时保存真实项目 ID，不能保存当前 tab cwd", () => {
  const patch = vi.fn(async () => undefined);
  const props = {
    bot: { allowedWorkspaces: ["*"] } as BotConfig,
    workspaceRefs: [
      { id: '["local","p1"]', label: "P1", workspacePath: "/same" },
      { id: '["local","p2"]', label: "P2", workspacePath: "/same" },
    ],
    currentWorkspace: { id: "/unopened", label: "old tab", workspacePath: "/unopened" },
    loading: false,
    onPatchAllowedWorkspaces: patch,
    onToggleWorkspaceAccess: vi.fn(async () => undefined),
  };
  render(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "en-US" },
      createElement(WorkspaceAccessCard, props),
    ),
  );
  fireEvent.click(screen.getByText("select-projects"));
  expect(patch).toHaveBeenCalledWith(['["local","p1"]']);
});
