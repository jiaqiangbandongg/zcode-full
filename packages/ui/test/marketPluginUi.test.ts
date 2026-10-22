// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  useMarketPluginUi,
  type MarketPluginUiTarget,
} from "@/plugin-ui/adapters/useMarketPluginUi.js";

const state = vi.hoisted(() => ({ sandbox: true, list: vi.fn(), open: vi.fn(), toast: vi.fn() }));
vi.mock("@/hooks/usePlatform.js", () => ({
  useOptionalPlatform: () => ({ pluginSandbox: state.sandbox }),
}));
vi.mock("@/hooks/useServices.js", () => ({
  useOptionalServices: () => ({ pluginUiBridgeService: { listSurfaces: state.list } }),
}));
vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    locale: "en-US",
    intl: { formatMessage: ({ id }: { id: string }) => id },
  }),
}));
vi.mock("@/plugin-ui/adapters/PluginUiProviders.js", () => ({ useOpenPluginUi: () => state.open }));
vi.mock("@/plugin-ui/adapters/usePluginUiSurfaces.js", () => ({
  resolvePluginUiSurfaceTitle: (title: string) => title,
}));
vi.mock("@/components/ui/toast.js", () => ({ toast: state.toast }));

const surface = {
  pluginId: "panel@example",
  pluginName: "panel",
  id: "panel",
  title: "Panel",
  server: "panel",
  resourceUri: "ui://panel/app",
  availability: "session",
};
let root: ReturnType<typeof createRoot>;
let result: ReturnType<typeof useMarketPluginUi>;
const target = { workspacePath: "/workspace", sessionId: "session-a" };
function Harness(props: MarketPluginUiTarget) {
  result = useMarketPluginUi(props);
  return null;
}
beforeEach(async () => {
  state.sandbox = true;
  state.list.mockReset().mockResolvedValue([surface]);
  state.open.mockReset();
  state.toast.mockReset();
  root = createRoot(document.createElement("div"));
  await act(() => root.render(createElement(Harness, target)));
});
afterEach(async () => {
  await act(() => root.unmount());
});

it("opens only after enabling succeeds", async () => {
  const enable = vi.fn(async () => false);
  await act(() => result.open(surface.pluginId, enable));
  expect(state.list).not.toHaveBeenCalled();
  expect(state.open).not.toHaveBeenCalled();
  enable.mockResolvedValue(true);
  await act(() => result.open(surface.pluginId, enable));
  expect(state.open).toHaveBeenCalledWith(
    expect.objectContaining({
      parentSessionId: "session-a",
      pluginId: surface.pluginId,
      surfaceId: "panel",
    }),
  );
});

it.each([{ remoteSessionId: "remote-a" }, { sessionId: null }])(
  "does not enable in an unsupported context %s",
  async (change) => {
    await act(() => root.render(createElement(Harness, { ...target, ...change })));
    const enable = vi.fn();
    await act(() => result.open(surface.pluginId, enable));
    expect(enable).not.toHaveBeenCalled();
    expect(state.open).not.toHaveBeenCalled();
    expect(state.toast).toHaveBeenCalled();
  },
);

it("does not enable or open in a Web host without the plugin sandbox", async () => {
  state.sandbox = false;
  await act(() => root.render(createElement(Harness, target)));
  const enable = vi.fn();
  await act(() => result.open(surface.pluginId, enable));
  expect(enable).not.toHaveBeenCalled();
  expect(state.list).not.toHaveBeenCalled();
  expect(state.open).not.toHaveBeenCalled();
  expect(state.toast).toHaveBeenCalled();
});

it("discards a surface response after switching sessions", async () => {
  let resolve!: (value: unknown) => void;
  state.list.mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const pending = result.open(surface.pluginId);
  await act(() => root.render(createElement(Harness, { ...target, sessionId: "session-b" })));
  await act(async () => {
    resolve([surface]);
    await pending;
  });
  expect(state.open).not.toHaveBeenCalled();
  expect(result.surfaces).toHaveLength(0);
});

it("requires a choice when the plugin provides multiple surfaces", async () => {
  state.list.mockResolvedValue([surface, { ...surface, id: "other" }]);
  await act(() => result.open(surface.pluginId));
  expect(state.open).not.toHaveBeenCalled();
  expect(result.surfaces).toHaveLength(2);
  await act(() => result.selectSurface(result.surfaces[1]!));
  expect(state.open).toHaveBeenCalledWith(expect.objectContaining({ surfaceId: "other" }));
  expect(result.surfaces).toHaveLength(0);
});

it("does not open after its market view unmounts", async () => {
  let resolve!: (value: unknown) => void;
  state.list.mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const pending = result.open(surface.pluginId);
  await act(() => root.render(null));
  await act(async () => {
    resolve([surface]);
    await pending;
  });
  expect(state.open).not.toHaveBeenCalled();
});
