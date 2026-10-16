/* eslint-disable max-lines, @typescript-eslint/no-explicit-any -- 该函数会序列化后在隔离的浏览器页面上下文执行，不能引用 host 闭包。 */
import type { BrowserCommandResult, BrowserPlaywrightAction } from "@zcode/shared";
import { buildViewportScreenshotParams } from "./browserCommandPageHandlers.js";
import type { ControlledView } from "./browserCommandTypes.js";
import { captureScreenshotWithCssPixelCorrection } from "./browserScreenshotCapture.js";
import { captureBrowserDomSnapshot } from "./browserPlaywrightDomSnapshot.js";
import { executeIabPlaywrightLocator } from "./browserPlaywrightLocatorExecutor.js";
import { normalizePlaywrightTimeout } from "./browserPlaywrightTimeout.js";

type Done = (partial: Omit<BrowserCommandResult, "elapsedMs">) => BrowserCommandResult;

const POLL_INTERVAL_MS = 50;

function serializeRuntimeCall(fn: (...args: any[]) => unknown, ...args: unknown[]): string {
  return `(${fn.toString()})(${args.map((arg) => JSON.stringify(arg)).join(",")})`;
}

function elementInfoRuntime(options: { x: number; y: number; includeNonInteractable?: boolean }) {
  const cssEscape = (value: string) =>
    globalThis.CSS?.escape?.(value) ?? value.replace(/[^\w-]/g, "\\$&");
  const candidatesFor = (element: Element) => {
    const values: string[] = [];
    if (element.id) values.push(`#${cssEscape(element.id)}`);
    const testId = element.getAttribute("data-testid");
    if (testId) values.push(`[data-testid=${JSON.stringify(testId)}]`);
    const aria = element.getAttribute("aria-label");
    if (aria) values.push(`[aria-label=${JSON.stringify(aria)}]`);
    values.push(element.tagName.toLowerCase());
    return [...new Set(values)];
  };
  const role = (element: Element) =>
    element.getAttribute("role") ??
    (element.matches("button,input[type=button],input[type=submit]")
      ? "button"
      : element.matches("a[href]")
        ? "link"
        : element.matches("input:not([type]),input[type=text],textarea")
          ? "textbox"
          : null);
  const interactable = (element: Element) =>
    Boolean(role(element) || element.matches("input,select,textarea,[tabindex],[contenteditable]"));
  return document
    .elementsFromPoint(options.x, options.y)
    .filter((element) => options.includeNonInteractable || interactable(element))
    .map((element) => {
      const rect = element.getBoundingClientRect();
      const candidates = candidatesFor(element);
      const visibleText =
        (element as HTMLElement).innerText?.trim() || (element as HTMLInputElement).value || null;
      const ariaName = element.getAttribute("aria-label") || visibleText;
      return {
        tagName: element.tagName.toLowerCase(),
        role: role(element),
        visibleText,
        ariaName,
        testId: element.getAttribute("data-testid"),
        boundingBox: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        preview: element.outerHTML.slice(0, 300),
        selector: { primary: candidates[0] ?? null, candidates },
      };
    });
}

function overlayRuntime(options: { x: number; y: number; remove?: boolean }): void {
  const id = "__zcode-playwright-element-screenshot-overlay";
  document.getElementById(id)?.remove();
  if (options.remove) return;
  const root = document.createElement("div");
  root.id = id;
  root.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483647";
  for (const element of document.elementsFromPoint(options.x, options.y)) {
    const rect = element.getBoundingClientRect();
    const box = document.createElement("div");
    box.style.cssText = `position:absolute;left:${rect.x}px;top:${rect.y}px;width:${rect.width}px;height:${rect.height}px;border:2px solid #ff2d55;box-sizing:border-box`;
    root.append(box);
  }
  const point = document.createElement("div");
  point.style.cssText = `position:absolute;left:${options.x - 4}px;top:${options.y - 4}px;width:8px;height:8px;border-radius:50%;background:#ff2d55`;
  root.append(point);
  document.documentElement.append(root);
}

async function evaluateInPlaywrightIsolatedWorld(
  view: ControlledView,
  expression: string,
): Promise<unknown> {
  const tree = (await view.cdp.send("Page.getFrameTree")) as {
    frameTree?: { frame?: { id?: string } };
  };
  const frameId = tree.frameTree?.frame?.id;
  if (!frameId) throw new Error("Playwright isolated world requires a main frame id");
  const world = (await view.cdp.send("Page.createIsolatedWorld", {
    frameId,
    grantUniveralAccess: false,
    worldName: "zcode-playwright-helper",
  })) as { executionContextId?: number };
  if (typeof world.executionContextId !== "number") {
    throw new Error("Playwright isolated world was not created");
  }
  const result = (await view.cdp.send("Runtime.evaluate", {
    expression,
    contextId: world.executionContextId,
    awaitPromise: true,
    returnByValue: true,
  })) as {
    result?: { value?: unknown };
    exceptionDetails?: { text?: string; exception?: { description?: string } };
  };
  if (result.exceptionDetails) {
    throw new Error(
      result.exceptionDetails.exception?.description ??
        result.exceptionDetails.text ??
        "Playwright isolated-world evaluation failed",
    );
  }
  return result.result?.value;
}

async function poll(
  predicate: () => Promise<boolean>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<"matched" | "timeout" | "cancelled"> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (signal?.aborted) return "cancelled";
    if (await predicate()) return "matched";
    const remaining = deadline - Date.now();
    if (remaining <= 0) return "timeout";
    await new Promise<void>((resolve) =>
      setTimeout(resolve, Math.min(POLL_INTERVAL_MS, remaining)),
    );
  }
}

function timeoutResult(done: Done, description: string): BrowserCommandResult {
  return done({
    ok: false,
    error: { code: "timeout", message: `Timeout waiting for ${description}` },
  });
}

function locatorTimeoutResult(done: Done, description: string): BrowserCommandResult {
  return done({
    ok: false,
    error: {
      code: "timeout",
      message:
        `Timeout waiting for ${description}. ` +
        "Do not retry the same locator. Take a fresh domSnapshot(), rebuild from snapshot-proven facts, " +
        "and check count()/isVisible() before the next action.",
    },
  });
}

function urlMatches(pattern: string, url: string): boolean {
  if (!pattern.includes("*")) return url === pattern;
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(url);
}

async function waitForDocumentState(
  view: ControlledView,
  state: "load" | "domcontentloaded" | "networkidle",
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<"matched" | "timeout" | "cancelled"> {
  if (state === "networkidle") {
    throw new Error("playwright_wait_for_load_state does not support networkidle");
  }
  return poll(
    async () => {
      const pageState = (await view.webContents.executeJavaScript(`(() => ({
        readyState: document.readyState,
        resourceCount: 0
      }))()`)) as { readyState?: string; resourceCount?: number };
      const ready =
        state === "domcontentloaded"
          ? pageState.readyState !== "loading"
          : pageState.readyState === "complete";
      return ready;
    },
    timeoutMs,
    signal,
  );
}

async function evaluateWithCdp(
  view: ControlledView,
  expression: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<unknown> {
  const terminate = () => {
    void view.cdp.send("Runtime.terminateExecution").catch(() => undefined);
  };
  if (signal?.aborted) throw new DOMException("aborted", "AbortError");
  signal?.addEventListener("abort", terminate, { once: true });
  try {
    const raw = (await view.cdp.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      timeout: timeoutMs,
    })) as {
      result?: { value?: unknown };
      exceptionDetails?: { text?: string; exception?: { description?: string } };
    };
    if (raw.exceptionDetails) {
      throw new Error(
        `playwright.evaluate failed: ${
          raw.exceptionDetails.exception?.description ??
          raw.exceptionDetails.text ??
          "Playwright evaluate failed"
        }`,
      );
    }
    return raw.result?.value;
  } finally {
    signal?.removeEventListener("abort", terminate);
  }
}

export async function handlePlaywrightAction(
  view: ControlledView,
  action: BrowserPlaywrightAction,
  done: Done,
  signal?: AbortSignal,
): Promise<BrowserCommandResult> {
  if (action.name === "domSnapshot") {
    // Bugfix：此前这里只 clone documentElement，返回的是高噪声 outerHTML，不是
    // Playwright AI/ARIA snapshot。统一走 isolated-world runtime + iframe 展开和相同后处理。
    const value = await captureBrowserDomSnapshot(view, signal);
    return done({ ok: true, value });
  }
  if (action.name === "elementInfo") {
    // DOM 探测必须在 isolated world 执行，避免页面覆写全局对象或 getter 改变结果。
    const value = await evaluateInPlaywrightIsolatedWorld(
      view,
      serializeRuntimeCall(elementInfoRuntime, action),
    );
    return done({ ok: true, value });
  }
  if (action.name === "elementScreenshot") {
    await evaluateInPlaywrightIsolatedWorld(view, serializeRuntimeCall(overlayRuntime, action));
    try {
      const raw = await captureScreenshotWithCssPixelCorrection(
        view,
        await buildViewportScreenshotParams(view),
      );
      if (!raw.data) throw new Error("CDP Page.captureScreenshot returned no data");
      return done({ ok: true, image: { base64: raw.data, mimeType: "image/png" } });
    } finally {
      await evaluateInPlaywrightIsolatedWorld(
        view,
        serializeRuntimeCall(overlayRuntime, { x: action.x, y: action.y, remove: true }),
      );
    }
  }
  if (action.name === "evaluate") {
    const arg = JSON.stringify(action.arg);
    const expression =
      action.expressionKind === "function"
        ? `(${action.expression})(${arg})`
        : `(() => { const arg = ${arg}; return (${action.expression}); })()`;
    const value = await evaluateWithCdp(
      view,
      expression,
      normalizePlaywrightTimeout(action.timeoutMs),
      signal,
    );
    return done({ ok: true, value });
  }
  if (action.name === "waitForURL") {
    const pattern = action.url;
    const timeoutMs = normalizePlaywrightTimeout(action.timeoutMs);
    const startedAt = Date.now();
    const status = await poll(
      async () => urlMatches(pattern, view.webContents.getURL()),
      timeoutMs,
      signal,
    );
    if (status === "cancelled")
      return done({
        ok: false,
        error: { code: "cancelled", message: "browser request cancelled", sideEffect: "none" },
      });
    if (status !== "matched") return timeoutResult(done, `URL ${pattern}`);
    const waitUntil = action.waitUntil ?? "load";
    if (waitUntil !== "commit") {
      const loadStatus = await waitForDocumentState(
        view,
        waitUntil,
        Math.max(1, timeoutMs - (Date.now() - startedAt)),
        signal,
      );
      if (loadStatus === "cancelled") {
        return done({
          ok: false,
          error: { code: "cancelled", message: "browser request cancelled", sideEffect: "none" },
        });
      }
      if (loadStatus === "timeout")
        return timeoutResult(done, `URL ${pattern} to reach ${waitUntil}`);
    }
    return done({ ok: true, value: view.webContents.getURL() });
  }
  if (action.name === "waitForLoadState") {
    const state = action.state ?? "load";
    const status = await waitForDocumentState(
      view,
      state,
      normalizePlaywrightTimeout(action.timeoutMs),
      signal,
    );
    if (status === "cancelled")
      return done({
        ok: false,
        error: { code: "cancelled", message: "browser request cancelled", sideEffect: "none" },
      });
    return status === "matched" ? done({ ok: true }) : timeoutResult(done, `load state ${state}`);
  }
  if (action.name === "locator") {
    const execution = await executeIabPlaywrightLocator(
      view,
      action,
      normalizePlaywrightTimeout(action.timeoutMs),
      signal,
    );
    if (execution.kind === "cancelled") {
      return done({
        ok: false,
        error: { code: "cancelled", message: "browser request cancelled", sideEffect: "none" },
      });
    }
    if (execution.kind === "timeout") return locatorTimeoutResult(done, execution.reason);
    return done({ ok: true, value: execution.value });
  }
  return done({
    ok: false,
    error: {
      code: "capability_unsupported",
      message: `playwright.${action.name} is handled by the IAB manager`,
    },
  });
}
