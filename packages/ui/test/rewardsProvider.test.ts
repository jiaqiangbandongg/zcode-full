// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { RewardsProvider, useOpenRewards } from "@/rewards/RewardsProvider.js";

const h = vi.hoisted(() => ({
  state: {
    user: null as { id: string } | null,
    theme: "zai-light",
    loginEntryAttempt: null as { id: number; status: string } | null,
    requestLoginEntry: vi.fn(() => 1),
  },
  external: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/store/StoreProvider.js", () => ({
  useZCodeStore: (select: (s: typeof h.state) => unknown) => select(h.state),
}));
vi.mock("@/hooks/usePlatform.js", () => ({ usePlatform: () => ({ openExternal: h.external }) }));
vi.mock("@/i18n/IntlProvider.js", () => ({ useZCodeIntl: () => ({ locale: "en-US" }) }));
vi.mock("@/rewards/RewardsWebview.js", () => ({
  RewardsWebview: () => createElement("div", { "data-testid": "rewards-view" }),
}));

function Trigger() {
  const open = useOpenRewards();
  return createElement("button", { onClick: () => void open?.() }, "open rewards");
}
const app = (desktop = true) =>
  createElement(RewardsProvider, { desktop, children: createElement(Trigger) });
beforeEach(() => {
  h.state.user = null;
  h.state.loginEntryAttempt = null;
  vi.clearAllMocks();
});
afterEach(cleanup);

it("登录后直接打开，不请求登录", () => {
  h.state.user = { id: "user" };
  render(app());
  fireEvent.click(screen.getByText("open rewards"));
  expect(screen.getByTestId("rewards-view")).toBeTruthy();
  expect(h.state.requestLoginEntry).not.toHaveBeenCalled();
});
it("同一登录成功且用户就绪才打开，重复点击不重复登录", () => {
  const view = render(app());
  fireEvent.click(screen.getByText("open rewards"));
  fireEvent.click(screen.getByText("open rewards"));
  expect(h.state.requestLoginEntry).toHaveBeenCalledTimes(1);
  expect(h.state.requestLoginEntry).toHaveBeenCalledWith(undefined, "app-login");
  expect(screen.queryByTestId("rewards-view")).toBeNull();
  h.state.loginEntryAttempt = { id: 1, status: "succeeded" };
  view.rerender(app());
  expect(screen.queryByTestId("rewards-view")).toBeNull();
  h.state.user = { id: "user" };
  view.rerender(app());
  expect(screen.getByTestId("rewards-view")).toBeTruthy();
});
it.each(["cancelled", "failed", "replaced"])("%s 后无关登录不补跳", (status) => {
  const view = render(app());
  fireEvent.click(screen.getByText("open rewards"));
  h.state.loginEntryAttempt = { id: status === "replaced" ? 2 : 1, status };
  view.rerender(app());
  h.state.user = { id: "other" };
  h.state.loginEntryAttempt = { id: 2, status: "succeeded" };
  view.rerender(app());
  expect(screen.queryByTestId("rewards-view")).toBeNull();
});
it("Web 登录后走既有外链且续接只执行一次", async () => {
  const view = render(app(false));
  fireEvent.click(screen.getByText("open rewards"));
  h.state.user = { id: "user" };
  h.state.loginEntryAttempt = { id: 1, status: "succeeded" };
  await act(async () => view.rerender(app(false)));
  view.rerender(app(false));
  expect(h.external).toHaveBeenCalledTimes(1);
  expect(h.external.mock.calls[0][0]).toMatch(
    /^https:\/\/[^/]+\/en\/rewards\?embedded=app&theme=zai-light$/,
  );
});
