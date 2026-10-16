import { BrowserWindow, dialog, nativeImage, webContents } from "electron";
import type { WebContents } from "electron";
import type { Locale } from "@zcode/shared";

const DEFAULT_AUTOMATION_GRACE_MS = 3_000;
const USER_BROWSER_TAB_PREFIX = "browser:";

interface EmbeddedBrowserDialogRequest {
  type: "alert" | "confirm";
  message: string;
}

export interface EmbeddedBrowserDialogResponse {
  handled: boolean;
  value?: boolean;
}

interface RegisteredGuest {
  guest: WebContents;
  tabId: string;
  windowId: number;
}

interface AutomationWindowState {
  activeCount: number;
  passthroughUntil: number;
  cleanupTimer?: ReturnType<typeof setTimeout>;
}

function parseEmbeddedBrowserDialogRequest(value: unknown): EmbeddedBrowserDialogRequest | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Partial<EmbeddedBrowserDialogRequest>;
  if (
    (candidate.type !== "alert" && candidate.type !== "confirm") ||
    typeof candidate.message !== "string"
  ) {
    return null;
  }
  return { type: candidate.type, message: candidate.message };
}

export function resolveEmbeddedBrowserDialogSource(
  frameUrl: string,
  guestUrl?: string,
): string {
  for (const candidate of [frameUrl, guestUrl]) {
    if (!candidate) continue;
    try {
      const parsed = new URL(candidate);
      if ((parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.host) {
        return `${parsed.host} says`;
      }
      if (parsed.protocol === "blob:" && parsed.origin) {
        const origin = new URL(parsed.origin);
        if ((origin.protocol === "http:" || origin.protocol === "https:") && origin.host) {
          return `${origin.host} says`;
        }
      }
    } catch {
      // 继续尝试 Chromium 维护的下一层可信 URL。
    }
  }
  // 非法或无 host URL 统一使用不可伪造的中性来源标签。
  return "This page says";
}

export function resolveEmbeddedBrowserDialogButtons(
  locale: Locale,
  type: EmbeddedBrowserDialogRequest["type"],
): string[] {
  if (type === "alert") return [locale === "zh-CN" ? "确定" : "OK"];
  return locale === "zh-CN" ? ["取消", "确定"] : ["Cancel", "OK"];
}

/**
 * 用户 Browser 的 preload 在网页调用原生 alert/confirm 之前同步进入这里，因此用户路径
 * 不会先创建 Chromium Dialog。自动化期间返回 handled=false，由 preload 调回原生 API，
 * 继续让 BrowserGuestManager 的 getDialog/handleDialog 处理。
 */
export class EmbeddedBrowserJavaScriptDialogController {
  private readonly guests = new Map<number, RegisteredGuest>();
  private readonly openDialogGuestIds = new Set<number>();
  private readonly automationByWindow = new Map<number, AutomationWindowState>();

  constructor(
    private readonly options: {
      iconPath: string;
      getLocale: () => Locale;
      logger: { warn: (...args: unknown[]) => void };
      automationGraceMs?: number;
    },
  ) {}

  dispose(): void {
    for (const webContentsId of this.guests.keys()) this.unbindGuest(webContentsId);
    for (const state of this.automationByWindow.values()) {
      if (state.cleanupTimer) clearTimeout(state.cleanupTimer);
    }
    this.automationByWindow.clear();
    this.openDialogGuestIds.clear();
  }

  bindGuest(tabId: string, webContentsId: number, windowId: number): void {
    this.unbindGuest(webContentsId);
    if (!tabId.startsWith(USER_BROWSER_TAB_PREFIX)) return;

    const guest = webContents.fromId(webContentsId);
    if (!guest || guest.isDestroyed() || guest.getType() !== "webview") return;

    const registration: RegisteredGuest = { guest, tabId, windowId };
    this.guests.set(webContentsId, registration);
    guest.once("destroyed", () => {
      if (this.guests.get(webContentsId) === registration) this.unbindGuest(webContentsId);
    });
  }

  handleDialogRequest(
    webContentsId: number,
    frameUrl: string,
    payload: unknown,
  ): EmbeddedBrowserDialogResponse {
    const request = parseEmbeddedBrowserDialogRequest(payload);
    const registration = this.guests.get(webContentsId);
    if (
      !request ||
      !registration ||
      this.openDialogGuestIds.has(webContentsId) ||
      this.shouldUseNativeDialog(registration.windowId)
    ) {
      return { handled: false };
    }

    const parent = BrowserWindow.fromId(registration.windowId);
    if (!parent || parent.isDestroyed()) return { handled: false };

    this.openDialogGuestIds.add(webContentsId);
    try {
      const icon = nativeImage.createFromPath(this.options.iconPath);
      const selected = dialog.showMessageBoxSync(parent, {
        type: request.type === "alert" ? "info" : "question",
        buttons: resolveEmbeddedBrowserDialogButtons(this.options.getLocale(), request.type),
        defaultId: request.type === "alert" ? 0 : 1,
        cancelId: 0,
        // 同源 iframe 的可信 frame URL 可能是 about:blank；该 URL 没有
        // 可展示 host，必须继续使用 Chromium 维护的 guest 主文档 URL。
        message: resolveEmbeddedBrowserDialogSource(frameUrl, registration.guest.getURL()),
        detail: request.message,
        noLink: true,
        normalizeAccessKeys: true,
        ...(!icon.isEmpty() ? { icon } : {}),
      });
      return {
        handled: true,
        ...(request.type === "confirm" ? { value: selected === 1 } : {}),
      };
    } catch (error) {
      // 系统框创建失败时不能伪造用户选择；通知 preload 调回网页原生 API。
      this.options.logger.warn("[browser-pane] failed to handle JavaScript dialog with source", {
        error: error instanceof Error ? error.message : String(error),
        tabId: registration.tabId,
      });
      return { handled: false };
    } finally {
      this.openDialogGuestIds.delete(webContentsId);
    }
  }

  beginAutomation(windowId: number): () => void {
    const state = this.automationByWindow.get(windowId) ?? {
      activeCount: 0,
      passthroughUntil: 0,
    };
    if (state.cleanupTimer) {
      clearTimeout(state.cleanupTimer);
      state.cleanupTimer = undefined;
    }
    state.activeCount += 1;
    state.passthroughUntil = Number.POSITIVE_INFINITY;
    this.automationByWindow.set(windowId, state);

    let released = false;
    return () => {
      if (released) return;
      released = true;
      state.activeCount = Math.max(0, state.activeCount - 1);
      if (state.activeCount > 0) return;

      const graceMs = this.options.automationGraceMs ?? DEFAULT_AUTOMATION_GRACE_MS;
      state.passthroughUntil = Date.now() + graceMs;
      state.cleanupTimer = setTimeout(() => {
        const current = this.automationByWindow.get(windowId);
        if (current === state && current.activeCount === 0) {
          this.automationByWindow.delete(windowId);
        }
      }, graceMs);
      state.cleanupTimer.unref?.();
    };
  }

  private shouldUseNativeDialog(windowId: number): boolean {
    const state = this.automationByWindow.get(windowId);
    return Boolean(state && (state.activeCount > 0 || Date.now() < state.passthroughUntil));
  }

  private unbindGuest(webContentsId: number): void {
    this.guests.delete(webContentsId);
    this.openDialogGuestIds.delete(webContentsId);
  }
}
