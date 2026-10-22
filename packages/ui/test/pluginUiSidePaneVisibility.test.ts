// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PluginUiSidePaneView } from "@/plugin-ui/components/PluginUiSidePane.js";
import type { PluginUiSidePaneViewProps } from "@/plugin-ui/contract.js";

const { bind, release } = vi.hoisted(() => {
  const release = vi.fn();
  return { bind: vi.fn(() => release), release };
});
vi.mock("@/plugin-ui/adapters/pluginUiPageRegistry.js", () => ({ bindPluginUiPage: bind }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const props: PluginUiSidePaneViewProps = {
  visible: true,
  scopeRef: { kind: "surface", surfaceId: "editor" },
  host: {
    pageKey: "fixture-page",
    handle: null,
    phase: "preparing",
    height: 240,
    error: null,
    reload: vi.fn(),
  },
  loadingLabel: "loading",
  errorLabel: "error",
  retryLabel: "retry",
  onWidthChange: vi.fn(),
};

describe("plugin side pane visibility", () => {
  it("unbinds a retained hidden tab synchronously and reuses its anchor when reopened", () => {
    const view = render(createElement(PluginUiSidePaneView, props));
    const anchor = view.getByTestId("plugin-ui-card");
    expect(bind).toHaveBeenCalledWith("fixture-page", anchor, true);

    view.rerender(createElement(PluginUiSidePaneView, { ...props, visible: false }));
    expect(release).toHaveBeenCalledTimes(1);
    expect(anchor.isConnected).toBe(true);
    expect(bind).toHaveBeenCalledTimes(1);

    view.rerender(createElement(PluginUiSidePaneView, props));
    expect(bind).toHaveBeenCalledTimes(2);
    expect(bind).toHaveBeenLastCalledWith("fixture-page", anchor, true);
  });

  it("does not bind a page created while its tab is hidden", () => {
    const view = render(createElement(PluginUiSidePaneView, { ...props, visible: false }));
    view.rerender(
      createElement(PluginUiSidePaneView, {
        ...props,
        visible: false,
        host: { ...props.host, phase: "running" },
      }),
    );
    expect(bind).not.toHaveBeenCalled();
    view.rerender(createElement(PluginUiSidePaneView, props));
    expect(bind).toHaveBeenCalledTimes(1);
  });
});
