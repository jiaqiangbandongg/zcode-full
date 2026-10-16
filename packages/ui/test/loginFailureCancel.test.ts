// @vitest-environment jsdom

/**
 * 登录失败态的取消交互
 *
 * 背景(Bugfix):失败态此前只有「重新登录」(沿原渠道重试),想换渠道只能重开登录入口,
 * 容易在同一条失败链路上反复重试;且 Root 层 oauthError 触发的失败态(轮询/回调失败)会把
 * useOAuth reset 回 idle,导致失败块和渠道按钮列表同屏、状态纠缠。
 * 改为:失败态 = Alert + 重新登录 + 取消(outline,对齐等待态),取消后回到渠道列表。
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TID_OAUTH_CANCEL, TID_OAUTH_ERROR, TID_OAUTH_LOGIN_BUTTON } from "@zcode/shared";

const oauthState = vi.hoisted(() => ({
  status: "idle" as "idle" | "waiting" | "error",
  error: null as string | null,
  providers: [
    { id: "bigmodel", displayName: "BigModel", enabled: true, order: 0 },
    { id: "zai", displayName: "Z.AI", enabled: true, order: 1 },
  ] as Array<{ id: string; displayName: string; enabled: boolean; order: number }>,
}));

const oauthActions = vi.hoisted(() => ({
  startLogin: vi.fn(),
  cancel: vi.fn(),
  reset: vi.fn(),
}));

const storeState = vi.hoisted(() => ({
  oauthError: null as string | null,
  setOAuthError: vi.fn(),
  markLoginEntryAttemptStatus: vi.fn(),
}));

// 登录壳新增窗控；夹具提供平台命令，继续聚焦 OAuth 失败/取消交互。
vi.mock("@/hooks/usePlatform.js", () => ({
  usePlatform: () => ({ executeDesktopCommand: vi.fn().mockResolvedValue(undefined) }),
}));

vi.mock("@/hooks/useOAuth.js", () => ({
  useOAuth: () => ({
    startLogin: oauthActions.startLogin,
    cancel: oauthActions.cancel,
    reset: oauthActions.reset,
    status: oauthState.status,
    error: oauthState.error,
    providers: oauthState.providers,
    activeProvider: null,
    loadingProviders: false,
    pendingProvider: null,
    refreshProviders: vi.fn(),
  }),
}));

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: {
      formatMessage: ({ id }: { id: string }) => id,
    },
  }),
}));

vi.mock("@/store/StoreProvider.js", () => ({
  useZCodeStore: (selector: (state: unknown) => unknown) =>
    selector({
      user: null,
      oauthError: storeState.oauthError,
      setOAuthError: storeState.setOAuthError,
      oauthSuccessSeq: 0,
      lastOAuthSuccessProvider: null,
      loginEntryRequest: null,
      loginEntryAttempt: null,
      clearLoginEntryRequest: vi.fn(),
      markLoginEntryAttemptStatus: storeState.markLoginEntryAttemptStatus,
    }),
}));

async function renderWelcomeScreen() {
  const { WelcomeScreen } = await import("@/WelcomeScreen.js");
  const view = render(createElement(WelcomeScreen, { onComplete: vi.fn() }));
  return { view, WelcomeScreen };
}

describe("登录失败态的取消交互", () => {
  beforeEach(() => {
    oauthState.status = "error";
    oauthState.error = "登录失败，请重试";
    storeState.oauthError = null;
    oauthActions.startLogin.mockClear();
    oauthActions.cancel.mockClear();
    oauthActions.reset.mockClear();
    storeState.setOAuthError.mockClear();
    storeState.markLoginEntryAttemptStatus.mockClear();
  });

  afterEach(() => {
    cleanup();
  });

  it("本地启动失败(error)在重新登录下方展示 outline 取消按钮,渠道按钮列表不渲染", async () => {
    await renderWelcomeScreen();

    expect(screen.getByTestId(TID_OAUTH_ERROR)).toBeTruthy();
    const retryButton = screen.getByText("login.oauth.retry");
    const cancelButton = screen.getByTestId(TID_OAUTH_CANCEL);

    // 取消按钮与等待态取消一致:outline 弱样式,位于「重新登录」下方
    expect(cancelButton.getAttribute("data-variant")).toBe("outline");
    expect(
      retryButton.compareDocumentPosition(cancelButton) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);

    // 失败态整体替换渠道列表,用户通过取消回到列表换渠道
    expect(screen.queryByTestId(TID_OAUTH_LOGIN_BUTTON)).toBeNull();
  });

  it("Root 层 oauthError 触发的失败态同样替换渠道列表,不再与按钮列表同屏", async () => {
    oauthState.status = "idle";
    oauthState.error = null;
    // 模拟轮询/回调失败:Root 写入 store.oauthError 后 effect 会 reset() 本地状态回 idle
    storeState.oauthError = "登录失败，请重试";

    await renderWelcomeScreen();

    expect(screen.getByTestId(TID_OAUTH_ERROR)).toBeTruthy();
    expect(screen.getByTestId(TID_OAUTH_CANCEL)).toBeTruthy();
    expect(screen.queryByTestId(TID_OAUTH_LOGIN_BUTTON)).toBeNull();
  });

  it("点击失败态取消:清 store 错误并取消 pending,状态回 idle 后渠道列表恢复", async () => {
    const { view, WelcomeScreen } = await renderWelcomeScreen();

    fireEvent.click(screen.getByTestId(TID_OAUTH_CANCEL));

    // 行为与等待态取消对齐:取消服务端 pending flow + 清 store 残留错误
    expect(oauthActions.cancel).toHaveBeenCalledTimes(1);
    expect(storeState.setOAuthError).toHaveBeenCalledWith(null);

    // 模拟取消生效后的状态(useOAuth 回 idle、store 错误已清)
    oauthState.status = "idle";
    oauthState.error = null;
    storeState.oauthError = null;
    view.rerender(createElement(WelcomeScreen, { onComplete: vi.fn() }));

    expect(screen.getByTestId(TID_OAUTH_LOGIN_BUTTON)).toBeTruthy();
    expect(screen.queryByTestId(TID_OAUTH_ERROR)).toBeNull();
    expect(screen.queryByTestId(TID_OAUTH_CANCEL)).toBeNull();
  });

  it("失败后点重新登录:清 store 错误并沿用最近失败的渠道重试", async () => {
    await renderWelcomeScreen();

    fireEvent.click(screen.getByText("login.oauth.retry"));

    expect(storeState.setOAuthError).toHaveBeenCalledWith(null);
    // retry 未记录 lastAttempt 时回退到渠道列表首位
    expect(oauthActions.startLogin).toHaveBeenCalledWith(
      expect.stringMatching(/^(bigmodel|zai)$/u),
      undefined,
    );
  });

  it("等待态取消按钮与失败态取消并存不冲突:等待态只有取消,无错误提示", async () => {
    oauthState.status = "waiting";
    oauthState.error = null;

    await renderWelcomeScreen();

    expect(screen.getByTestId(TID_OAUTH_CANCEL)).toBeTruthy();
    expect(screen.queryByTestId(TID_OAUTH_ERROR)).toBeNull();
    expect(screen.queryByTestId(TID_OAUTH_LOGIN_BUTTON)).toBeNull();
  });
});
