import type {
  BrowserCommand,
  BrowserCommandResult,
  BrowserKeyModifier,
  BrowserPageState,
  BrowserPoint,
} from "@zcode/contracts";
import type { ElementHandle, Page } from "playwright-core";
import { executeManagedPlaywrightAction, evaluatePage } from "./playwright-command.js";
import {
  captureManagedCdpSnapshot,
  resolveSnapshotElement,
  resolveSnapshotRef,
} from "./snapshot.js";

type PartialResult = Omit<BrowserCommandResult, "elapsedMs">;

const NAVIGATION_TIMEOUT_MS = 30_000;

export function isAllowedManagedBrowserUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    return url.protocol === "http:" || url.protocol === "https:" || url.href === "about:blank";
  } catch {
    return false;
  }
}

function normalizedModifier(modifier: BrowserKeyModifier): "Alt" | "Control" | "Meta" | "Shift" {
  return modifier === "ControlOrMeta"
    ? process.platform === "darwin"
      ? "Meta"
      : "Control"
    : modifier;
}

async function withModifiers(
  page: Page,
  modifiers: BrowserKeyModifier[] | undefined,
  action: () => Promise<void>,
): Promise<void> {
  const keys = (modifiers ?? []).map(normalizedModifier);
  for (const key of keys) await page.keyboard.down(key);
  try {
    await action();
  } finally {
    for (const key of keys.reverse()) await page.keyboard.up(key);
  }
}

async function elementForRef(page: Page, ref: string): Promise<ElementHandle<Element>> {
  const element = await resolveSnapshotElement(page, ref);
  if (!element) {
    throw new Error(
      `Browser ref '${ref}' is stale or unavailable. Take a fresh snapshot before retrying.`,
    );
  }
  return element;
}

async function pointFor(
  page: Page,
  ref: string | undefined,
  point: BrowserPoint | undefined,
): Promise<{ x: number; y: number }> {
  if (ref) {
    const resolved = await resolveSnapshotRef(page, ref);
    if (!resolved) throw new Error(`Browser ref '${ref}' is stale or unavailable`);
    return resolved;
  }
  if (point) return point;
  throw new Error("Browser action requires a ref or x/y coordinates");
}

export async function readManagedPageState(page: Page): Promise<BrowserPageState> {
  const client = await page.context().newCDPSession(page);
  try {
    const history = (await client.send("Page.getNavigationHistory")) as {
      currentIndex?: number;
      entries?: unknown[];
    };
    const currentIndex = history.currentIndex ?? 0;
    const entryCount = history.entries?.length ?? 1;
    const viewport = page.viewportSize();
    const scroll = await page
      .evaluate(() => ({
        scrollX: Math.round(window.scrollX),
        scrollY: Math.round(window.scrollY),
      }))
      .catch(() => ({ scrollX: 0, scrollY: 0 }));
    return {
      url: page.url(),
      title: await page.title().catch(() => ""),
      canGoBack: currentIndex > 0,
      canGoForward: currentIndex + 1 < entryCount,
      ...scroll,
      ...(viewport ? { viewportWidth: viewport.width, viewportHeight: viewport.height } : {}),
    };
  } finally {
    await client.detach().catch(() => undefined);
  }
}

async function pressKeys(page: Page, keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  const normalized = keys.map((key) =>
    key === "ControlOrMeta" ? (process.platform === "darwin" ? "Meta" : "Control") : key,
  );
  const modifiers = normalized.slice(0, -1);
  for (const key of modifiers) await page.keyboard.down(key);
  try {
    await page.keyboard.press(normalized.at(-1) ?? "");
  } finally {
    for (const key of modifiers.reverse()) await page.keyboard.up(key);
  }
}

async function dragPath(page: Page, path: BrowserPoint[]): Promise<void> {
  if (path.length === 0) throw new Error("Browser drag requires a non-empty path");
  const [first, ...rest] = path;
  await page.mouse.move(first.x, first.y);
  await page.mouse.down();
  try {
    for (const point of rest) await page.mouse.move(point.x, point.y, { steps: 4 });
  } finally {
    await page.mouse.up();
  }
}

export async function executeManagedPageCommand(
  page: Page,
  command: BrowserCommand,
): Promise<PartialResult> {
  switch (command.method) {
    case "navigate":
      if (!isAllowedManagedBrowserUrl(command.url)) {
        return {
          ok: false,
          error: {
            code: "navigation_blocked",
            message: `Navigation URL is not allowed: ${command.url}`,
          },
        };
      }
      await page.goto(command.url, { timeout: NAVIGATION_TIMEOUT_MS, waitUntil: "load" });
      return { ok: true, state: await readManagedPageState(page) };
    case "back":
      await page.goBack({ timeout: NAVIGATION_TIMEOUT_MS, waitUntil: "load" });
      return { ok: true, state: await readManagedPageState(page) };
    case "forward":
      await page.goForward({ timeout: NAVIGATION_TIMEOUT_MS, waitUntil: "load" });
      return { ok: true, state: await readManagedPageState(page) };
    case "reload":
      await page.reload({ timeout: NAVIGATION_TIMEOUT_MS, waitUntil: "load" });
      return { ok: true, state: await readManagedPageState(page) };
    case "getState":
      return { ok: true, state: await readManagedPageState(page) };
    case "snapshot":
      return {
        ok: true,
        snapshot: await captureManagedCdpSnapshot(page, command.maxElements, command.includeHidden),
      };
    case "screenshot": {
      const image = command.ref
        ? await (await elementForRef(page, command.ref)).screenshot({ type: "png" })
        : await page.screenshot({
            type: "png",
            fullPage: command.fullPage,
            clip: command.clip,
          });
      return { ok: true, image: { base64: image.toString("base64"), mimeType: "image/png" } };
    }
    case "click": {
      const point = await pointFor(
        page,
        command.ref,
        command.x !== undefined && command.y !== undefined
          ? { x: command.x, y: command.y }
          : undefined,
      );
      await withModifiers(page, command.modifiers, async () => {
        await page.mouse.click(point.x, point.y, {
          button: command.button,
          clickCount: command.doubleClick ? 2 : 1,
        });
      });
      return { ok: true };
    }
    case "fill": {
      const element = await elementForRef(page, command.ref);
      await element.fill(command.value);
      return { ok: true };
    }
    case "type":
      if (command.ref) {
        await (await elementForRef(page, command.ref)).focus();
      }
      await page.keyboard.type(command.text);
      return { ok: true };
    case "press":
      if (command.ref) await (await elementForRef(page, command.ref)).press(command.key);
      else
        await withModifiers(page, command.modifiers, async () => page.keyboard.press(command.key));
      return { ok: true };
    case "cuaKeypress":
      await pressKeys(page, command.keys);
      return { ok: true };
    case "scroll":
      if (command.ref)
        await (
          await elementForRef(page, command.ref)
        ).evaluate((element) => element.scrollIntoView());
      await page.evaluate(({ x, y }) => window.scrollBy(x, y), {
        x: command.x ?? 0,
        y: command.y ?? 0,
      });
      return { ok: true };
    case "cuaScroll":
      await withModifiers(page, command.modifiers, async () => {
        await page.mouse.move(command.x, command.y);
        await page.mouse.wheel(command.scrollX, command.scrollY);
      });
      return { ok: true };
    case "domCuaScroll": {
      const anchor = command.nodeId
        ? await pointFor(page, command.nodeId, undefined)
        : await page.evaluate(() => ({ x: window.innerWidth / 2, y: window.innerHeight / 2 }));
      await page.mouse.move(anchor.x, anchor.y);
      await page.mouse.wheel(command.scrollX, command.scrollY);
      return { ok: true };
    }
    case "hover": {
      const point = await pointFor(
        page,
        command.ref,
        command.x !== undefined && command.y !== undefined
          ? { x: command.x, y: command.y }
          : undefined,
      );
      await withModifiers(page, command.modifiers, async () => page.mouse.move(point.x, point.y));
      return { ok: true };
    }
    case "select":
      await (await elementForRef(page, command.ref)).selectOption(command.values);
      return { ok: true };
    case "check":
      await (await elementForRef(page, command.ref)).setChecked(command.checked ?? true);
      return { ok: true };
    case "drag": {
      const from = await pointFor(page, command.fromRef, command.from);
      const to = await pointFor(page, command.toRef, command.to);
      await withModifiers(page, command.modifiers, async () => dragPath(page, [from, to]));
      return { ok: true };
    }
    case "cuaDrag":
      await withModifiers(page, command.modifiers, async () => dragPath(page, command.path));
      return { ok: true };
    case "elementInfo": {
      const snapshot = await captureManagedCdpSnapshot(page);
      return {
        ok: true,
        element: snapshot.elements.find(
          (element) =>
            command.x >= element.rect.x &&
            command.x <= element.rect.x + element.rect.width &&
            command.y >= element.rect.y &&
            command.y <= element.rect.y + element.rect.height,
        ),
      };
    }
    case "evaluate":
      return {
        ok: true,
        value: await evaluatePage(page, command.expression, "string", undefined, 3_000),
      };
    case "waitFor": {
      const timeout = Math.min(3_000, Math.max(1, command.timeoutMs ?? 3_000));
      if (command.selector)
        await page.locator(command.selector).waitFor({ timeout, state: "visible" });
      else if (command.text)
        await page.getByText(command.text).waitFor({ timeout, state: "visible" });
      else if (command.textGone)
        await page.getByText(command.textGone).waitFor({ timeout, state: "hidden" });
      else throw new Error("waitFor requires selector, text, or textGone");
      return { ok: true };
    }
    case "playwright":
      return await executeManagedPlaywrightAction(page, command.action);
    case "playwrightWaitForTimeout":
      await new Promise<void>((resolve) => setTimeout(resolve, command.timeoutMs));
      return { ok: true };
    default:
      return {
        ok: false,
        error: {
          code: "capability_unsupported",
          message: `Browser command '${command.method}' is unavailable in the managed CDP page runtime`,
        },
      };
  }
}
