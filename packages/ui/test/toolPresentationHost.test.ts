// @vitest-environment jsdom
import { createElement } from "react";
import { render, cleanup, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToolCallBlock } from "@/ToolCallBlocks.js";
import { PermissionDialog } from "@/PermissionDialog.js";
import { useToolPresentationCapabilities } from "@/ToolCallBlocks/presentationCapabilities.js";
const state = vi.hoisted(() => ({ plugin: false }));
vi.mock("@/hooks/useToolPresentationHostCapabilities.js", () => ({
  useToolPresentationHostCapabilities: () => ({ resourceUrl: () => "host-capability" }),
}));
vi.mock("@/plugin-ui/index.js", () => ({
  usePluginUiToolBinding: () => undefined,
  shouldRenderPluginUi: () => state.plugin,
  PluginUiToolCallBlock: () => createElement("p", null, "plugin-surface"),
}));
vi.mock("@/ToolCallBlocks/resolveRenderer.js", () => ({
  resolveToolCallRenderer: () => () => createElement("p", null, "special-renderer"),
}));
vi.mock("@/ToolCallBlocks/renderers/fallback.js", () => ({
  FallbackToolCallBlock: () =>
    createElement(
      "p",
      null,
      useToolPresentationCapabilities().resourceUrl?.("preview") ?? "missing-capability",
    ),
}));
vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({ intl: { formatMessage: ({ id }: { id: string }) => id } }),
}));
afterEach(() => {
  cleanup();
  state.plugin = false;
});
describe("App tool presentation boundaries", () => {
  it.each([true, false])("respects the host plugin eligibility decision: %s", (plugin) => {
    state.plugin = plugin;
    render(
      createElement(ToolCallBlock, {
        workspacePath: "/workspace",
        toolCallNode: {
          toolCall: { toolId: "t1", kind: "other", status: "completed" },
          childToolCalls: [],
        },
      }),
    );
    expect(screen.getByText(plugin ? "plugin-surface" : "special-renderer")).toBeTruthy();
  });
  it("injects presentation capabilities into direct permission renderers", () => {
    render(
      createElement(PermissionDialog, {
        request: {
          type: "permission_request",
          taskId: "task",
          traceId: "trace",
          requestId: "request",
          kind: "other",
          description: "Preview",
          options: [],
        },
        workspacePath: "/workspace",
        onRespond: () => {},
      }),
    );
    expect(screen.getByText("host-capability")).toBeTruthy();
    expect(screen.queryByText("plugin-surface")).toBeNull();
  });
});
