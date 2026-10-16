import type { CodingPlanUpgradeMockRequest } from "./coding-plan-upgrade-mock-server.js";
import { assertOverlayWindowControls } from "./overlay-window-controls.js";

const TID_CODING_PLAN_EMBEDDED_WEBVIEW = "coding-plan-embedded-webview";

interface CodingPlanWebviewSnapshot {
  body: string;
  readyState: string;
  title: string;
  url: string;
}

export async function waitForCodingPlanWebviewDisplayed() {
  await browser.waitUntil(
    async () =>
      (await browser.execute((testIdValue) => {
        const isVisible = (element: HTMLElement) => {
          const style = window.getComputedStyle(element);
          if (style.display === "none" || style.visibility === "hidden") {
            return false;
          }
          const rect = element.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        };
        return Array.from(
          document.querySelectorAll<HTMLElement>(`[data-testid="${testIdValue}"]`),
        ).some(isVisible);
      }, TID_CODING_PLAN_EMBEDDED_WEBVIEW)) === true,
    {
      timeout: 30000,
      timeoutMsg: "升级弹窗没有显示 Coding Plan embedded webview",
    },
  );
  await assertOverlayWindowControls('[data-testid="coding-plan-upgrade-surface"]');
}

export async function waitForCodingPlanWebviewBodyTextIncludes(expectedTexts: readonly string[]) {
  let latestSnapshot: CodingPlanWebviewSnapshot = {
    body: "",
    readyState: "unknown",
    title: "",
    url: "",
  };
  await browser.waitUntil(
    async () => {
      const webContentsId = await readCodingPlanWebviewContentsId();
      latestSnapshot = (await browser.electron.execute((electron, id) => {
        const guest = electron.webContents.fromId(id);
        if (!guest || guest.isDestroyed()) {
          return {
            body: "",
            readyState: "destroyed",
            title: "",
            url: "",
          };
        }
        return guest.executeJavaScript(
          `({
              body: document.body?.innerText ?? "",
              readyState: document.readyState,
              title: document.title,
              url: window.location.href
            })`,
          true,
        );
      }, webContentsId)) as unknown as CodingPlanWebviewSnapshot;
      return expectedTexts.some((text) => latestSnapshot.body.includes(text));
    },
    {
      timeout: 30000,
      timeoutMsg: `Coding Plan webview 没有显示预期文案: ${expectedTexts.join(" / ")}，url=${latestSnapshot.url}，readyState=${latestSnapshot.readyState}，title=${latestSnapshot.title}，当前内容: ${latestSnapshot.body}`,
    },
  );
}

export async function readCodingPlanWebviewLocalStorage(
  keys: readonly string[],
): Promise<Record<string, string | null>> {
  await waitForCodingPlanWebviewDisplayed();
  const webContentsId = await readCodingPlanWebviewContentsId();
  return (await browser.electron.execute(
    async (electron, id, storageKeys) => {
      const guest = electron.webContents.fromId(id);
      if (!guest || guest.isDestroyed()) {
        throw new Error("Coding Plan webview is not available");
      }
      return guest.executeJavaScript(
        `(() => {
          const keys = ${JSON.stringify(storageKeys)};
          return Object.fromEntries(keys.map((key) => [
            key,
            window.localStorage.getItem(key)
          ]));
        })()`,
        true,
      );
    },
    webContentsId,
    keys,
  )) as Record<string, string | null>;
}

export async function waitForCodingPlanWebviewClosed() {
  await browser.waitUntil(
    async () =>
      (await browser.execute((testIdValue) => {
        const isVisible = (element: HTMLElement) => {
          const style = window.getComputedStyle(element);
          if (style.display === "none" || style.visibility === "hidden") {
            return false;
          }
          const rect = element.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        };
        return !Array.from(
          document.querySelectorAll<HTMLElement>(`[data-testid="${testIdValue}"]`),
        ).some(isVisible);
      }, TID_CODING_PLAN_EMBEDDED_WEBVIEW)) === true,
    {
      timeout: 15000,
      timeoutMsg: "购买完成后 Coding Plan embedded webview 没有关闭",
    },
  );
}

export async function triggerCodingPlanWebviewPurchaseComplete(provider: "bigmodel" | "zai") {
  await waitForCodingPlanWebviewDisplayed();
  await markCodingPlanUpgradeMockPurchaseComplete(readCodingPlanUpgradeMockControlBaseUrl());
  const webContentsId = await readCodingPlanWebviewContentsId();
  let result: {
    body?: string;
    ok: boolean;
    readyState?: string;
    reason?: string;
    title?: string;
    url?: string;
  } = {
    ok: false,
    reason: "not-started",
  };
  try {
    await browser.waitUntil(
      async () => {
        result = (await browser.electron.execute(
          async (electron, id, expectedProvider) => {
            const guest = electron.webContents.fromId(id);
            if (!guest) {
              return { ok: false, reason: "webview-missing" };
            }
            try {
              return await guest.executeJavaScript(
                `(() => {
                  const expectedProvider = ${JSON.stringify(expectedProvider)};
                  const body = document.body?.innerText?.slice(0, 500) ?? "";
                  const readyState = document.readyState;
                  const title = document.title;
                  const url = window.location.href;
                  if (expectedProvider !== "zai" && expectedProvider !== "bigmodel") {
                    return { ok: false, reason: "invalid-provider", body, readyState, title, url };
                  }
                  const bridge = window.zcodeBridge;
                  if (!bridge || typeof bridge.notifyPurchaseComplete !== "function") {
                    return { ok: false, reason: "bridge-missing", body, readyState, title, url };
                  }
                  // E2E 触发必须先把 ok 返回给 WebDriver，再异步发购买完成消息；
                  // 否则 App 同步关闭 webview 时 guest 被销毁，executeJavaScript 可能拿不到返回值。
                  setTimeout(() => {
                    bridge.notifyPurchaseComplete({
                      provider: expectedProvider,
                      timestamp: Date.now()
                    });
                  }, 0);
                  return { ok: true };
                })()`,
                true,
              );
            } catch (error) {
              return {
                ok: false,
                reason: error instanceof Error ? error.message : String(error),
              };
            }
          },
          webContentsId,
          provider,
        )) as { ok: boolean; reason?: string; body?: string };
        return result.ok;
      },
      {
        timeout: 30000,
        timeoutMsg: "触发 Coding Plan webview 购买完成失败",
      },
    );
  } catch (error) {
    throw new Error(
      [
        `触发 Coding Plan webview 购买完成失败: ${result.reason ?? "unknown"}`,
        result.url ? `url=${result.url}` : "",
        result.readyState ? `readyState=${result.readyState}` : "",
        result.title ? `title=${result.title}` : "",
        result.body ? `当前内容: ${result.body}` : "",
      ]
        .filter(Boolean)
        .join("，"),
      { cause: error },
    );
  }

  if (!result.ok) {
    throw new Error(`触发 Coding Plan webview 购买完成失败: ${result.reason ?? "unknown"}`);
  }
}

export async function waitForCodingPlanUpgradeMockRequest(
  predicate: (request: CodingPlanUpgradeMockRequest) => boolean,
  timeoutMsg: string,
) {
  let latestRequests: CodingPlanUpgradeMockRequest[] = [];
  let latestBaseUrls: string[] = [];
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const result = await readCodingPlanUpgradeMockRequests();
    latestRequests = result.requests;
    latestBaseUrls = result.baseUrls;
    if (latestRequests.some(predicate)) {
      return;
    }
    await browser.pause(250);
  }
  throw new Error(
    `${timeoutMsg}，mock=${latestBaseUrls.join(" / ")}，当前请求: ${latestRequests
      .map(formatCodingPlanUpgradeMockRequestForError)
      .join(" / ")}`,
  );
}

function formatCodingPlanUpgradeMockRequestForError(request: CodingPlanUpgradeMockRequest): string {
  const authorization = request.headers.authorization;
  const authState =
    authorization === undefined
      ? "auth=missing"
      : authorization.startsWith("Bearer ")
        ? "auth=bearer"
        : authorization.length > 0
          ? "auth=raw"
          : "auth=empty";
  return `${request.method} ${request.path} (${authState})`;
}

async function readCodingPlanWebviewContentsId(): Promise<number> {
  const rendererWebview = (await browser.execute((testIdValue) => {
    const isVisible = (element: HTMLElement) => {
      const style = window.getComputedStyle(element);
      if (style.display === "none" || style.visibility === "hidden") {
        return false;
      }
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const webviews = Array.from(
      document.querySelectorAll<HTMLElement>(`[data-testid="${testIdValue}"]`),
    ) as Array<HTMLElement & { getWebContentsId?: () => number }>;
    // 修复原因：升级弹层可能和背景设置页共存，WDIO 默认取第一个会命中隐藏 webview。
    const webview = webviews.findLast(isVisible) ?? webviews.at(-1) ?? null;
    return {
      id: webview?.getWebContentsId?.() ?? 0,
      src: webview?.getAttribute("src") ?? "",
    };
  }, TID_CODING_PLAN_EMBEDDED_WEBVIEW)) as { id: number; src: string };
  const webContentsId = (await browser.electron.execute(
    (electron, candidateId, expectedSrc) => {
      const isCodingPlanUrl = (value: string | undefined) => {
        if (!value) return false;
        try {
          const url = new URL(value);
          return url.pathname.includes("coding-plan");
        } catch {
          return false;
        }
      };
      const candidate = electron.webContents.fromId(candidateId);
      if (candidate && !candidate.isDestroyed() && isCodingPlanUrl(candidate.getURL())) {
        return candidateId;
      }
      const matched = electron.webContents
        .getAllWebContents()
        .find(
          (contents) =>
            !contents.isDestroyed() &&
            (isCodingPlanUrl(contents.getURL()) || contents.getURL() === expectedSrc),
        );
      return matched?.id ?? candidateId;
    },
    rendererWebview.id,
    rendererWebview.src,
  )) as number;
  if (!webContentsId) {
    throw new Error("没有读取到 Coding Plan webview 的 webContentsId");
  }
  return webContentsId;
}

export async function readCodingPlanUpgradeMockRequests(): Promise<{
  baseUrls: string[];
  requests: CodingPlanUpgradeMockRequest[];
}> {
  const baseUrls = readCodingPlanUpgradeMockBaseUrlCandidates();
  const requestGroups = await Promise.all(
    baseUrls.map(async (baseUrl) => {
      try {
        const response = await fetch(`${baseUrl}/__e2e/coding-plan/requests`);
        const payload = (await response.json()) as {
          requests?: CodingPlanUpgradeMockRequest[];
        };
        return Array.isArray(payload.requests) ? payload.requests : [];
      } catch {
        return [];
      }
    }),
  );
  return {
    baseUrls,
    requests: requestGroups.flat(),
  };
}

function readCodingPlanUpgradeMockBaseUrlCandidates(): string[] {
  const baseUrls = [
    process.env.ZCODE_CODING_PLAN_UPGRADE_MOCK_BASE_URL,
    process.env.ZCODE_E2E_CODING_PLAN_MOCK_URL,
    process.env.BIGMODEL_TEST_API_BASE_URL,
    process.env.BIGMODEL_API_BASE_URL,
    process.env.ZAI_BUSINESS_BASE_URL,
    process.env.ZCODE_ENDPOINT_ORIGIN,
  ].flatMap((item) => {
    const value = item?.trim();
    return value ? [value] : [];
  });
  const uniqueBaseUrls = Array.from(new Set(baseUrls));
  if (uniqueBaseUrls.length === 0) {
    throw new Error("Coding Plan upgrade mock baseUrl 未配置");
  }
  return uniqueBaseUrls;
}

function readCodingPlanUpgradeMockControlBaseUrl(): string {
  const baseUrl = process.env.ZCODE_CODING_PLAN_UPGRADE_MOCK_BASE_URL?.trim();
  if (!baseUrl) {
    throw new Error("Coding Plan upgrade mock control baseUrl 未配置");
  }
  return baseUrl;
}

async function markCodingPlanUpgradeMockPurchaseComplete(baseUrl: string) {
  const response = await fetch(`${baseUrl}/__e2e/coding-plan/purchase-complete`, {
    method: "POST",
  });
  if (!response.ok) {
    throw new Error(`Coding Plan upgrade mock 标记购买完成失败: ${baseUrl}`);
  }
}
