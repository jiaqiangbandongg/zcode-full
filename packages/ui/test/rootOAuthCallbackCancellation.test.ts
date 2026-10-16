import { describe, expect, it, vi } from "vitest";

const { effects, errorLog } = vi.hoisted(() => ({
  effects: [] as Array<() => unknown>,
  errorLog: vi.fn(),
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useEffect: (effect: () => unknown) => effects.push(effect),
  useRef: (current: unknown) => ({ current }),
}));
vi.mock("@/hooks/useAlertDialog.js", () => ({ useAlertDialog: () => vi.fn() }));
vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({ intl: { formatMessage: () => "登录失败" } }),
}));
vi.mock("@/root/useAccountConnectionLossNotification.js", () => ({
  useAccountConnectionLossNotification: vi.fn(),
}));
vi.mock("@/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: errorLog },
}));
import { useRootOAuthEffects } from "@/root/useRootOAuthEffects.js";

describe("失效 OAuth 回调", () => {
  it.each([true, false])("pollingActive=%s 时静默忽略取消结果", async (oauthPollingActive) => {
    effects.length = 0;
    errorLog.mockClear();
    let callback!: (url: string) => Promise<void>;
    const setUser = vi.fn();
    const setOAuthError = vi.fn();
    const markOAuthSuccess = vi.fn();
    const setOAuthPollingActive = vi.fn();
    useRootOAuthEffects({
      accountIntentKey: "test",
      platform: {
        notifyRendererReady: vi.fn(),
        onOAuthCallback: (handler: typeof callback) => {
          callback = handler;
          return vi.fn();
        },
      } as never,
      services: {
        oauthService: { handleCallback: vi.fn(async () => null) },
        broadcastService: {},
      } as never,
      refreshProviderState: vi.fn(async () => {}),
      setUser,
      setIsRestoringOAuthSession: vi.fn(),
      setOAuthError,
      oauthPollingActive,
      setOAuthPollingActive,
      markOAuthSuccess,
      onReauthenticationRequired: vi.fn(),
    });
    // 只挂载回调订阅；启动恢复和轮询在各自测试中验证。
    effects.at(-1)!();
    await callback("zcode://oauth/callback?state=cancelled");
    expect(errorLog).not.toHaveBeenCalled();
    expect(setUser).not.toHaveBeenCalled();
    expect(setOAuthError).not.toHaveBeenCalled();
    expect(markOAuthSuccess).not.toHaveBeenCalled();
    expect(setOAuthPollingActive).not.toHaveBeenCalled();
  });
});
