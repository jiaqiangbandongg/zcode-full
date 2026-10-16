import {
  TID_LOGIN_MENU_ITEM,
  TID_LOGIN_TRIGGER,
  TID_OAUTH_CANCEL,
  TID_OAUTH_ERROR,
  TID_OAUTH_LOGIN_BUTTON,
} from "@zcode/shared";
import { clearAppData, clickTestIdByDom, waitForTestIdByDom } from "./helpers/desktop-app.js";

const CASE_TIMEOUT_MS = 240_000;
// PlatformChannels.OAuthCallback 的 channel 值(main 进程 execute 里无法 import @zcode/shared,
// 与 packages/shared/src/channels.ts 保持一致)
const OAUTH_CALLBACK_CHANNEL = "zcode:oauth-callback";
// state 不匹配的回调:oauthService.handleCallback 在无 pending flow 时会抛
// "OAuth state 不匹配或已过期",复现 OAuth deep link 失败的真实链路。
const TAMPERED_OAUTH_CALLBACK_URL = "zcode://oauth/callback?state=e2e-tampered-state&code=e2e-code";

describe("OAuth 登录失败态的取消交互", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("AUTH-05: 回调失败进入失败态(重新登录+取消),取消后回到渠道列表", async function () {
    this.timeout(CASE_TIMEOUT_MS);

    await ensureLoginPanelOpen();
    await waitForTestIdByDom(TID_OAUTH_LOGIN_BUTTON, {
      timeout: 20_000,
      timeoutMsg: "登录面板没有展示渠道按钮",
    });

    await deliverTamperedOAuthCallback();

    await waitForTestIdByDom(TID_OAUTH_ERROR, {
      timeout: 20_000,
      timeoutMsg: "OAuth 回调失败后没有出现错误提示",
    });
    await waitForTestIdByDom(TID_OAUTH_CANCEL, {
      timeout: 20_000,
      timeoutMsg: "登录失败态没有展示取消按钮",
    });
    // Bugfix 回归锚点:失败态整体替换渠道列表,不再与渠道按钮同屏
    expect(await hasChannelButton()).toBe(false);

    await clickTestIdByDom(TID_OAUTH_CANCEL, {
      timeout: 20_000,
      timeoutMsg: "登录失败态的取消按钮不可点击",
    });
    await waitForTestIdByDom(TID_OAUTH_LOGIN_BUTTON, {
      timeout: 20_000,
      timeoutMsg: "失败态取消后没有回到渠道列表",
    });
    expect(await hasOAuthError()).toBe(false);
  });
});

async function ensureLoginPanelOpen(): Promise<void> {
  await browser.waitUntil(async () => (await hasChannelButton()) || (await hasLoginTrigger()), {
    timeout: 60_000,
    timeoutMsg: "启动后没有出现 OAuth 登录面板或手动登录入口",
  });

  if (await hasChannelButton()) {
    return;
  }

  // 启动期已有可用 workspace shell 时,登录入口在头像菜单里:
  // TID_LOGIN_TRIGGER 打开菜单,TID_LOGIN_MENU_ITEM 才真正打开 WelcomeScreen。
  // Radix 菜单触发器依赖 pointerdown 激活,必须派发完整指针事件序列(对齐 e2ecase-regression)。
  await clickVisibleTestIdByDom(TID_LOGIN_TRIGGER, {
    timeout: 20_000,
    timeoutMsg: "没有可见可点击的头像菜单入口",
  });
  await clickVisibleTestIdByDom(TID_LOGIN_MENU_ITEM, {
    timeout: 20_000,
    timeoutMsg: "头像菜单里没有登录菜单项",
  });
}

async function clickVisibleTestIdByDom(
  targetTestId: string,
  {
    timeout = 10_000,
    timeoutMsg = `页面没有可见可点击的 test id: ${targetTestId}`,
  }: { timeout?: number; timeoutMsg?: string } = {},
): Promise<void> {
  let latestReason = "not-started";
  await browser.waitUntil(
    async () => {
      const result = (await browser.execute((testIdValue: string) => {
        function isVisible(element: HTMLElement) {
          const style = window.getComputedStyle(element);
          if (
            style.display === "none" ||
            style.visibility === "hidden" ||
            Number(style.opacity) === 0
          ) {
            return false;
          }
          if (element.getClientRects().length === 0) {
            return false;
          }
          return !element.closest('[aria-hidden="true"], [hidden]');
        }

        const element = Array.from(document.querySelectorAll<HTMLElement>("[data-testid]")).find(
          (item) => item.dataset.testid === testIdValue && isVisible(item),
        );
        if (!element) {
          return { clicked: false, reason: "missing-visible" };
        }

        // Radix 菜单触发器依赖 pointerdown 激活,单发 element.click() 会让菜单不展开。
        element.focus();
        const usePointerEvent = typeof window.PointerEvent === "function";
        for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
          const event = usePointerEvent
            ? new PointerEvent(type, {
                bubbles: true,
                cancelable: true,
                pointerId: 1,
                pointerType: "mouse",
                isPrimary: true,
              })
            : new MouseEvent(type, {
                bubbles: true,
                cancelable: true,
                view: window,
              });
          element.dispatchEvent(event);
        }
        return { clicked: true };
      }, targetTestId)) as { clicked: boolean; reason?: string };
      latestReason = result.reason ?? "clicked";
      return result.clicked;
    },
    {
      timeout,
      timeoutMsg: `${timeoutMsg}: ${latestReason}`,
    },
  );
}

async function deliverTamperedOAuthCallback(): Promise<void> {
  // 坏 state 不在 main 的 oauthStateToWindow 路由表里,走 app.emit("open-url") 会被
  // 当作"未命中窗口"缓存而无法送达 renderer;这里直接向主窗口投递 OAuthCallback IPC,
  // 覆盖 preload → platform.onOAuthCallback → handleCallback 失败 → oauthError 的真实链路。
  const delivered = await browser.electron.execute(
    (electron, channel, url) => {
      const target = electron.BrowserWindow.getAllWindows().find((window) => !window.isDestroyed());
      if (!target) {
        return false;
      }
      target.webContents.send(channel, url);
      return true;
    },
    OAUTH_CALLBACK_CHANNEL,
    TAMPERED_OAUTH_CALLBACK_URL,
  );
  expect(delivered).toBe(true);
}

async function hasChannelButton(): Promise<boolean> {
  return (await browser.execute((loginButtonId: string) => {
    return Boolean(document.querySelector(`[data-testid="${loginButtonId}"]`));
  }, TID_OAUTH_LOGIN_BUTTON)) as boolean;
}

async function hasOAuthError(): Promise<boolean> {
  return (await browser.execute((errorId: string) => {
    return Boolean(document.querySelector(`[data-testid="${errorId}"]`));
  }, TID_OAUTH_ERROR)) as boolean;
}

async function hasLoginTrigger(): Promise<boolean> {
  return (await browser.execute((loginTriggerId: string) => {
    return Boolean(document.querySelector(`[data-testid="${loginTriggerId}"]`));
  }, TID_LOGIN_TRIGGER)) as boolean;
}
