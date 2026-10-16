/* eslint-disable max-lines -- Playwright isolated-world selector、frame target 与 CDP trusted input 必须共享同一会话状态。 */
import type {
  BrowserPlaywrightAction,
  BrowserPlaywrightModifier,
} from "@zcode/shared";
import { logger } from "../logger.js";
import {
  dispatchClickAt,
  dispatchKey,
  modifiersBitmask,
} from "./browserCommandInput.js";
import type { ControlledView } from "./browserCommandTypes.js";
import {
  assertFocusedInputTarget,
  createInputTargetToken,
  IAB_INPUT_TARGET_TOKEN_PROPERTY,
  pasteTextIntoFocusedTarget,
} from "./browserVirtualClipboard.js";
import { getPlaywrightInjectedScriptSource } from "./playwrightInjectedScriptSource.js";

type LocatorAction = Extract<BrowserPlaywrightAction, { name: "locator" }>;

const PLAYWRIGHT_WORLD_NAME = "zcode-playwright-locator";
const PLAYWRIGHT_GLOBAL = "__zcodePlaywrightInjected";
const POLL_INTERVAL_MS = 50;
// 响应式页面可能同时保留 desktop/mobile 两份 DOM。若仅因匹配数大于 1 就在 host
// 侧抛通用错误，会错过唯一可见元素，也会丢失 Playwright 提供的候选详情。
const STRICT_VISIBLE_SELECTOR_HELPER = `
function querySelectorStrictWithVisibleFallback(injected, parsedSelector, root) {
  const matches = injected.querySelectorAll(parsedSelector, root);
  if (!matches.length) {
    injected.checkDeprecatedSelectorUsage(parsedSelector, matches);
    return null;
  }

  if (matches.length === 1) {
    injected.checkDeprecatedSelectorUsage(parsedSelector, matches);
    return matches[0];
  }

  const visibleMatches = matches.filter((element) => {
    const state = injected.elementState(element, "visible");
    return !!state.matches;
  });
  if (visibleMatches.length === 1) return visibleMatches[0];

  throw injected.strictModeViolationError(parsedSelector, matches);
}
`;

function strictVisibleSelectorSetup(selector: string): string {
  return `${STRICT_VISIBLE_SELECTOR_HELPER}
      const parsedSelector = injected.parseSelector(${JSON.stringify(selector)});
      const resolvedElement = querySelectorStrictWithVisibleFallback(injected, parsedSelector, root);
      const elements = resolvedElement ? [resolvedElement] : [];`;
}

interface CdpTarget {
  frameId: string;
  sessionId?: string;
}

interface FrameContext extends CdpTarget {
  contextId: number;
}

interface RuntimeResult {
  objectId?: string;
  subtype?: string;
  value?: unknown;
}

interface RuntimeResponse {
  exceptionDetails?: {
    text?: string;
    exception?: { description?: string; value?: unknown };
  };
  result?: RuntimeResult;
}

interface LocatorTarget {
  boundaries: FrameBoundary[];
  frame: CdpTarget;
  selector: string;
}

interface FrameBoundary {
  childSize: { height: number; width: number };
  contentQuad: [number, number, number, number, number, number, number, number];
  ownerBackendNodeId: number;
  parent: CdpTarget;
}

interface PointerFramePoints {
  boundaryPoints: Map<FrameBoundary, { x: number; y: number }>;
  top: { x: number; y: number };
}

interface ActionProbe {
  count: number;
  actionable: boolean;
  checked?: boolean;
  reason?:
    | "disabled"
    | "hidden"
    | "not-editable"
    | "not-stable"
    | "outside-viewport"
    | "covered";
  obstruction?: string;
  x?: number;
  y?: number;
}

interface ScrollAlignment {
  block: "center" | "end" | "nearest" | "start";
  inline: "center" | "end" | "nearest" | "start";
}

const POINTER_SCROLL_ALIGNMENTS: readonly ScrollAlignment[] = [
  { block: "center", inline: "center" },
  { block: "end", inline: "end" },
  { block: "start", inline: "start" },
  { block: "nearest", inline: "nearest" },
];

type ActionProbeExecution =
  | { kind: "done"; value: ActionProbe }
  | { kind: "timeout" }
  | { kind: "cancelled" };

export type IabLocatorExecution =
  | { kind: "done"; value?: unknown }
  | { kind: "timeout"; reason: string }
  | { kind: "cancelled" };

function abortError(): DOMException {
  return new DOMException("Browser locator action aborted", "AbortError");
}

function runtimeError(response: RuntimeResponse): string | undefined {
  const exception = response.exceptionDetails;
  if (!exception) return undefined;
  return (
    exception.exception?.description ??
    (exception.exception?.value == null
      ? undefined
      : String(exception.exception.value)) ??
    exception.text ??
    "Playwright locator evaluation failed"
  );
}

function isRecoverableLocatorRace(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /execution context (?:was )?destroyed|cannot find context|frame (?:was )?detached|inspected target navigated/iu.test(
    error.message,
  );
}

function splitSelectorTokens(selector: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote = "";
  let escaped = false;
  for (let index = 0; index < selector.length; index += 1) {
    const character = selector[index] ?? "";
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (character === "\\") {
      current += character;
      escaped = true;
      continue;
    }
    if (quote) {
      current += character;
      if (character === quote) quote = "";
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      current += character;
      quote = character;
      continue;
    }
    if (selector.slice(index, index + 4) === " >> ") {
      tokens.push(current.trim());
      current = "";
      index += 3;
      continue;
    }
    current += character;
  }
  if (current.trim()) tokens.push(current.trim());
  return tokens;
}

function frameSegments(selector: string): string[] {
  const segments: string[] = [];
  let current: string[] = [];
  for (const token of splitSelectorTokens(selector)) {
    if (token === "internal:control=enter-frame") {
      if (current.length === 0)
        throw new Error("frame locator is missing a frame selector");
      segments.push(current.join(" >> "));
      current = [];
      continue;
    }
    current.push(token);
  }
  if (current.length === 0)
    throw new Error("frame locator is missing a child selector");
  segments.push(current.join(" >> "));
  return segments;
}

function modifierNames(
  modifiers?: BrowserPlaywrightModifier[],
): Array<"Alt" | "Control" | "Meta" | "Shift"> {
  return (modifiers ?? []).map((modifier) => {
    if (modifier !== "ControlOrMeta") return modifier;
    return process.platform === "darwin" ? "Meta" : "Control";
  });
}

function pressParts(value: unknown, modifiers?: BrowserPlaywrightModifier[]) {
  const pieces = String(value ?? "")
    .split("+")
    .filter(Boolean);
  if (pieces.length === 0) throw new Error("locator.press requires a key");
  const key = pieces.pop()!;
  const embedded = pieces.filter((piece): piece is BrowserPlaywrightModifier =>
    ["Alt", "Control", "ControlOrMeta", "Meta", "Shift"].includes(piece),
  );
  return { key, modifiers: modifierNames([...(modifiers ?? []), ...embedded]) };
}

class IabPlaywrightLocatorSession {
  private readonly contexts = new Map<string, FrameContext>();
  private readonly attachedSessionIds = new Set<string>();
  private rootFrame?: CdpTarget;

  constructor(
    private readonly view: ControlledView,
    private readonly timeoutMs: number,
    private readonly signal?: AbortSignal,
  ) {}

  async dispose(): Promise<void> {
    await Promise.allSettled(
      [...this.attachedSessionIds].map((sessionId) =>
        this.view.cdp.send("Target.detachFromTarget", { sessionId }),
      ),
    );
    this.attachedSessionIds.clear();
  }

  async execute(action: LocatorAction): Promise<IabLocatorExecution> {
    let target = await this.resolveTarget(action.selector);
    if (action.operation === "count") {
      return {
        kind: "done",
        value: await this.queryValue(target, "elements.length"),
      };
    }
    if (action.operation === "allTextContents") {
      return {
        kind: "done",
        value: await this.queryValue(
          target,
          "elements.map(element => element.textContent ?? '')",
        ),
      };
    }
    if (action.operation === "isVisible") {
      return {
        kind: "done",
        value: await this.queryValue(
          target,
          "Boolean(elements[0] && injected.elementState(elements[0], 'visible').matches)",
        ),
      };
    }
    if (action.operation === "isEnabled") {
      return {
        kind: "done",
        value: await this.queryValue(
          target,
          "Boolean(elements[0] && injected.elementState(elements[0], 'enabled').matches)",
        ),
      };
    }
    if (action.operation === "waitFor")
      return this.waitForState(target, action);
    if (
      ["textContent", "innerText", "getAttribute", "evaluate"].includes(
        action.operation,
      )
    ) {
      const unique = await this.waitForUnique(target, action.selector);
      if (unique.kind !== "done") return unique;
      return {
        kind: "done",
        value: await this.perform(target, action, {
          count: 1,
          actionable: true,
        }),
      };
    }

    const deadline = Date.now() + this.timeoutMs;
    let lastReason = `locator ${action.selector}`;
    let pointerAttempt = 0;
    for (;;) {
      if (this.signal?.aborted) return { kind: "cancelled" };
      const remaining = deadline - Date.now();
      if (remaining <= 0) return { kind: "timeout", reason: lastReason };
      const needsEditable = action.operation === "fill";
      const needsPointer = ["click", "dblclick", "setChecked"].includes(
        action.operation,
      );
      const needsEnabled = [
        "click",
        "dblclick",
        "fill",
        "press",
        "selectOption",
        "setChecked",
      ].includes(action.operation);
      let probeExecution: ActionProbeExecution;
      try {
        probeExecution = await this.actionProbe(
          target,
          {
            // fill 始终检查 visible/enabled/editable，不接受 click 的 force 放宽。
            force: action.operation === "fill" ? false : action.force === true,
            needsEditable,
            needsEnabled,
            // fill/type 不等待 stable，也不做 click 的 hit-target 检查。
            // z.ai 输入框的持续动画会让 stable 永不成立，等待 stable 会卡到 MCP hard timeout。
            // force pointer action 仍等待稳定并滚动，但跳过 hit-target 校验。
            needsHitTarget: needsPointer && action.force !== true,
            needsStable: needsPointer,
            scrollAlignment:
              action.force === true
                ? POINTER_SCROLL_ALIGNMENTS[0]
                : POINTER_SCROLL_ALIGNMENTS[
                    pointerAttempt % POINTER_SCROLL_ALIGNMENTS.length
                  ],
          },
          remaining,
        );
      } catch (error) {
        if (!isRecoverableLocatorRace(error)) throw error;
        logger.debug("[browser-use] recovering locator after document race", {
          error: error instanceof Error ? error.message : String(error),
          operation: action.operation,
          selector: action.selector,
        });
        await this.resetDocumentContexts();
        target = await this.resolveTarget(action.selector);
        pointerAttempt += 1;
        continue;
      }
      if (probeExecution.kind === "cancelled") return { kind: "cancelled" };
      if (probeExecution.kind === "timeout")
        return { kind: "timeout", reason: lastReason };
      const probe = probeExecution.value;
      if (probe.count === 1 && probe.actionable) {
        const pointerPoints = needsPointer
          ? this.pointerFramePoints(target, probe)
          : undefined;
        if (needsPointer && action.force !== true) {
          const obstruction = await this.frameObstruction(
            target,
            pointerPoints!,
          );
          if (obstruction) {
            lastReason = `${action.operation} actionability (covered by ${obstruction}) for selector ${action.selector}`;
            pointerAttempt += 1;
            continue;
          }
        }
        return {
          kind: "done",
          value: await this.perform(
            target,
            action,
            pointerPoints
              ? { ...probe, x: pointerPoints.top.x, y: pointerPoints.top.y }
              : probe,
          ),
        };
      }
      lastReason =
        probe.count === 0
          ? `locator ${action.selector}`
          : `${action.operation} actionability (${probe.reason ?? "not-actionable"}${probe.obstruction ? ` by ${probe.obstruction}` : ""}) for selector ${action.selector}`;
      pointerAttempt += 1;
      const delayBudget = deadline - Date.now();
      if (delayBudget <= 0) return { kind: "timeout", reason: lastReason };
      if (!(await this.delay(Math.min(POLL_INTERVAL_MS, delayBudget))))
        return { kind: "cancelled" };
    }
  }

  private async perform(
    target: LocatorTarget,
    action: LocatorAction,
    probe: ActionProbe,
  ): Promise<unknown> {
    switch (action.operation) {
      case "textContent":
        return this.querySingleValue(target, "elements[0].textContent");
      case "innerText":
        return this.querySingleValue(target, "elements[0].innerText");
      case "getAttribute":
        return this.querySingleValue(
          target,
          `elements[0].getAttribute(${JSON.stringify(action.attribute)})`,
        );
      case "click":
      case "dblclick": {
        await dispatchClickAt(
          this.view,
          { cx: probe.x!, cy: probe.y! },
          action.button ?? "left",
          action.operation === "dblclick",
          modifiersBitmask(modifierNames(action.modifiers)),
        );
        return null;
      }
      case "fill": {
        const value = String(action.value ?? "");
        const inputTargetToken = createInputTargetToken();
        if (action.replace !== false) {
          const result = await this.querySingleValue(
            target,
            `(() => {
              const result = injected.fill(elements[0], ${JSON.stringify(value)});
              if (result === "needsinput") {
                const input = injected.retarget(elements[0], "follow-label") ?? elements[0];
                Object.defineProperty(input, ${JSON.stringify(IAB_INPUT_TARGET_TOKEN_PROPERTY)}, {
                  configurable: true,
                  value: ${JSON.stringify(inputTargetToken)},
                  writable: true,
                });
              }
              return result;
            })()`,
          );
          if (result === "done") return null;
          if (result !== "needsinput")
            throw new Error(`locator.fill failed: ${String(result)}`);
        } else {
          await this.focusForInput(target, inputTargetToken);
        }
        const context = await this.context(target.frame);
        await pasteTextIntoFocusedTarget(this.view, value, {
          includeRichText: false,
          initialTarget: {
            contextId: context.contextId,
            sessionId: context.sessionId,
          },
          inputTargetToken,
          replaceInputValue: action.replace !== false,
        });
        return null;
      }
      case "press": {
        const inputTargetToken = createInputTargetToken();
        await this.focusForInput(target, inputTargetToken, false);
        const context = await this.context(target.frame);
        await assertFocusedInputTarget(this.view, context, inputTargetToken);
        const press = pressParts(action.value, action.modifiers);
        await dispatchKey(
          this.view,
          press.key,
          modifiersBitmask(press.modifiers),
          context.sessionId,
        );
        return null;
      }
      case "setChecked": {
        if (probe.checked !== action.checked) {
          await dispatchClickAt(
            this.view,
            { cx: probe.x!, cy: probe.y! },
            "left",
            false,
          );
        }
        const checked = await this.querySingleValue(
          target,
          "Boolean(elements[0].checked)",
        );
        if (checked !== action.checked) {
          throw new Error(
            `locator.setChecked(${String(action.checked)}) did not change the element state`,
          );
        }
        return null;
      }
      case "selectOption":
        return this.selectOption(target, action);
      case "downloadMedia": {
        // IAB 的 locator.downloadMedia 不是普通 click：它在 Playwright isolated world 中
        // 提取 media/link URL，再用临时 download anchor 触发浏览器下载。直接点元素会在
        // 普通链接上导航，并把“未下载”伪装成成功。
        await this.querySingleValue(
          target,
          `(() => {
            const element = elements[0];
            element.scrollIntoView({ block: "center", inline: "nearest" });
            const media = element.closest?.("img, video, source, a[href]") ??
              element.querySelector?.("img, video, source, a[href]") ?? element;
            const read = (value, name) => typeof value?.[name] === "string" ? value[name] : null;
            const url = read(media, "currentSrc") ?? read(media, "src") ?? read(media, "href") ?? "";
            if (!url) throw new Error("Matched element does not expose a downloadable URL");
            const anchor = document.createElement("a");
            anchor.href = url;
            anchor.download = url.split("/").pop()?.split("?")[0] || "download";
            anchor.rel = "noopener";
            anchor.style.display = "none";
            document.body.appendChild(anchor);
            anchor.click();
            anchor.remove();
            return true;
          })()`,
        );
        return null;
      }
      case "evaluate":
        return this.evaluateLocator(target, action);
      default:
        throw new Error(`unsupported locator operation: ${action.operation}`);
    }
  }

  private async waitForState(
    target: LocatorTarget,
    action: LocatorAction,
  ): Promise<IabLocatorExecution> {
    const state = action.state ?? "visible";
    const deadline = Date.now() + this.timeoutMs;
    for (;;) {
      if (this.signal?.aborted) return { kind: "cancelled" };
      const value = (await this.queryValue(
        target,
        `({ exists: elements.length > 0, visible: Boolean(elements[0] && injected.elementState(elements[0], 'visible').matches) })`,
      )) as { exists: boolean; visible: boolean };
      const matched =
        state === "attached"
          ? value.exists
          : state === "detached"
            ? !value.exists
            : state === "visible"
              ? value.visible
              : !value.visible;
      if (matched) return { kind: "done" };
      const remaining = deadline - Date.now();
      if (remaining <= 0)
        return { kind: "timeout", reason: `${action.selector} to be ${state}` };
      if (!(await this.delay(Math.min(POLL_INTERVAL_MS, remaining))))
        return { kind: "cancelled" };
    }
  }

  private async waitForUnique(
    target: LocatorTarget,
    selector: string,
  ): Promise<IabLocatorExecution> {
    const deadline = Date.now() + this.timeoutMs;
    for (;;) {
      if (this.signal?.aborted) return { kind: "cancelled" };
      const exists = await this.querySingleValue(
        target,
        "Boolean(elements[0])",
        { allowMissing: true },
      );
      if (exists === true) return { kind: "done" };
      const remaining = deadline - Date.now();
      if (remaining <= 0)
        return { kind: "timeout", reason: `locator ${selector}` };
      if (!(await this.delay(Math.min(POLL_INTERVAL_MS, remaining))))
        return { kind: "cancelled" };
    }
  }

  private async actionProbe(
    target: LocatorTarget,
    options: {
      force: boolean;
      needsEditable: boolean;
      needsEnabled: boolean;
      needsHitTarget: boolean;
      needsStable: boolean;
      scrollAlignment: ScrollAlignment;
    },
    timeoutMs: number,
  ): Promise<ActionProbeExecution> {
    const operation = (async (): Promise<ActionProbe> => {
      const context = await this.context(target.frame);
      const expression = `(async () => {
      const injected = globalThis.${PLAYWRIGHT_GLOBAL};
      const root = document;
      ${STRICT_VISIBLE_SELECTOR_HELPER}
      const parsedSelector = injected.parseSelector(${JSON.stringify(target.selector)});
      const resolveCurrentElement = () =>
        querySelectorStrictWithVisibleFallback(injected, parsedSelector, root);
      let element = resolveCurrentElement();
      if (!element) return { count: 0, actionable: false };
      const stateNames = [];
      if (!${String(options.force)}) stateNames.push("visible");
      if (${String(options.needsEnabled && !options.force)}) stateNames.push("enabled");
      if (${String(options.needsEditable)}) stateNames.push("editable");
      const checkStates = (candidate) => {
        if (!candidate.isConnected) return "detached";
        for (const stateName of stateNames) {
          const result = injected.elementState(candidate, stateName);
          if (result.received === "error:notconnected") return "detached";
          if (!result.matches) return stateName;
        }
        return null;
      };
      const initialState = checkStates(element);
      if (initialState) {
        const reason = initialState === "visible" ? "hidden" :
          initialState === "enabled" ? "disabled" :
          initialState === "editable" ? "not-editable" : "not-stable";
        return { count: initialState === "detached" ? 0 : 1, actionable: false, reason };
      }
      element.scrollIntoView({
        block: ${JSON.stringify(options.scrollAlignment.block)},
        inline: ${JSON.stringify(options.scrollAlignment.inline)},
        behavior: "instant"
      });
      const waitForAnimationFrame = () => new Promise(resolve => {
        const view = element.ownerDocument?.defaultView;
        if (typeof view?.requestAnimationFrame === "function") view.requestAnimationFrame(() => resolve(undefined));
        else globalThis.setTimeout(() => resolve(undefined), 0);
      });
      let rect = element.getBoundingClientRect();
      if (${String(options.needsStable)}) {
        let stableFrames = 0;
        for (let index = 0; index < 10 && stableFrames < 2; index += 1) {
          await waitForAnimationFrame();
          // Bug 根因：el-table 等页面会在 rAF 间用同 locator、同几何的新 DOM node 替换旧 node。
          // locator 描述当前匹配目标，不绑定首次 node identity；detach 后应重解析再比较几何。
          const currentElement = element.isConnected ? element : resolveCurrentElement();
          if (!currentElement) return { count: 0, actionable: false };
          const next = currentElement.getBoundingClientRect();
          const unchanged = rect.left === next.left && rect.top === next.top &&
            rect.width === next.width && rect.height === next.height;
          stableFrames = unchanged ? stableFrames + 1 : 0;
          rect = next;
          element = currentElement;
        }
        if (stableFrames < 2) return { count: 1, actionable: false, reason: "not-stable" };
      }
      const finalState = checkStates(element);
      if (finalState) {
        const reason = finalState === "visible" ? "hidden" :
          finalState === "enabled" ? "disabled" :
          finalState === "editable" ? "not-editable" : "not-stable";
        return { count: finalState === "detached" ? 0 : 1, actionable: false, reason };
      }
      const checked = "checked" in element ? Boolean(element.checked) : undefined;
      if (!${String(options.needsHitTarget)}) return { count: 1, actionable: true, checked };
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      const inViewport = rect.width > 0 && rect.height > 0 && x >= 0 && y >= 0 &&
        x <= globalThis.innerWidth && y <= globalThis.innerHeight;
      const hitResult = inViewport ? injected.expectHitTarget({ x, y }, element) : "outside-viewport";
      const receivesEvents = hitResult === "done";
      if (!inViewport) return { count: 1, actionable: false, reason: "outside-viewport", checked };
      if (!receivesEvents) {
        const obstruction = typeof hitResult === "string" ? hitResult :
          hitResult?.hitTargetDescription ?? "another element";
        return { count: 1, actionable: false, reason: "covered", obstruction, checked };
      }
      return { count: 1, actionable: true, x, y, checked };
      })()`;
      const rawValue = (
        await this.evaluate(context, expression, true, timeoutMs)
      ).value;
      const value = this.requireActionProbe(rawValue, target.selector);
      return value;
    })();
    return this.raceActionProbe(operation, target.frame, timeoutMs);
  }

  private requireActionProbe(value: unknown, selector: string): ActionProbe {
    if (
      !value ||
      typeof value !== "object" ||
      !Number.isInteger((value as { count?: unknown }).count) ||
      Number((value as { count?: unknown }).count) < 0 ||
      Number((value as { count?: unknown }).count) > 1 ||
      typeof (value as { actionable?: unknown }).actionable !== "boolean"
    ) {
      // 直接读取异步 Runtime.evaluate 返回值的 count 会在 CDP 空 payload 时泄漏
      // “Cannot read properties of undefined”。这里保留 backend 故障语义，禁止伪装成零匹配。
      logger.debug("[browser-use] invalid pointer probe payload", {
        selector,
        valueKeys: value && typeof value === "object" ? Object.keys(value) : [],
        valueType: value === null ? "null" : typeof value,
      });
      throw new Error(
        `Playwright pointer probe returned an invalid payload for selector ${selector}`,
      );
    }
    const probe = value as ActionProbe;
    if (
      (probe.x !== undefined && !Number.isFinite(probe.x)) ||
      (probe.y !== undefined && !Number.isFinite(probe.y))
    ) {
      throw new Error(
        `Playwright pointer probe returned invalid coordinates for selector ${selector}`,
      );
    }
    return probe;
  }

  private pointerFramePoints(
    target: LocatorTarget,
    probe: ActionProbe,
  ): PointerFramePoints {
    if (probe.x === undefined || probe.y === undefined) {
      throw new Error(
        `Playwright pointer probe returned no click point for selector ${target.selector}`,
      );
    }
    let point = { x: probe.x, y: probe.y };
    const boundaryPoints = new Map<FrameBoundary, { x: number; y: number }>();
    for (const boundary of target.boundaries.toReversed()) {
      const [x0, y0, x1, y1, x2, y2, x3, y3] = boundary.contentQuad;
      const u = point.x / boundary.childSize.width;
      const v = point.y / boundary.childSize.height;
      point = {
        x:
          x0 * (1 - u) * (1 - v) +
          x1 * u * (1 - v) +
          x2 * u * v +
          x3 * (1 - u) * v,
        y:
          y0 * (1 - u) * (1 - v) +
          y1 * u * (1 - v) +
          y2 * u * v +
          y3 * (1 - u) * v,
      };
      boundaryPoints.set(boundary, point);
    }
    return { boundaryPoints, top: point };
  }

  private async frameObstruction(
    target: LocatorTarget,
    points: PointerFramePoints,
  ): Promise<string | undefined> {
    for (const boundary of target.boundaries.toReversed()) {
      const point = points.boundaryPoints.get(boundary);
      if (!point)
        throw new Error("Playwright pointer frame chain is incomplete");
      const x = Math.round(point.x);
      const y = Math.round(point.y);
      try {
        const hit = (await this.send(
          boundary.parent,
          "DOM.getNodeForLocation",
          {
            includeUserAgentShadowDOM: true,
            x,
            y,
          },
        )) as { backendNodeId?: number };
        if (
          !hit.backendNodeId ||
          hit.backendNodeId === boundary.ownerBackendNodeId
        )
          continue;
        const described = (await this.send(
          boundary.parent,
          "DOM.describeNode",
          {
            backendNodeId: hit.backendNodeId,
          },
        )) as {
          node?: {
            attributes?: string[];
            localName?: string;
            nodeName?: string;
          };
        };
        const node = described.node;
        const name =
          node?.localName || node?.nodeName?.toLowerCase() || "another element";
        return `<${name}>`;
      } catch {
        // frame boundary 的辅助遮挡探测失败不覆盖主 selector/actionability 结果。
      }
    }
    return undefined;
  }

  private raceActionProbe(
    operation: Promise<ActionProbe>,
    target: CdpTarget,
    timeoutMs: number,
  ): Promise<ActionProbeExecution> {
    if (this.signal?.aborted) return Promise.resolve({ kind: "cancelled" });
    return new Promise<ActionProbeExecution>((resolve, reject) => {
      let settled = false;
      const finish = (result: ActionProbeExecution) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.signal?.removeEventListener("abort", onAbort);
        resolve(result);
      };
      const terminate = () => {
        void this.view.cdp
          .send("Runtime.terminateExecution", undefined, target.sessionId)
          .catch(() => undefined);
      };
      // Runtime.evaluate.timeout 在 injected checkElementStates 等待 rAF 时不足以保证
      // host 侧截止。用剩余 locator 预算竞速，避免 3s routine timeout 外溢成 30s MCP AbortError。
      const timer = setTimeout(
        () => {
          terminate();
          finish({ kind: "timeout" });
        },
        Math.max(0, timeoutMs),
      );
      const onAbort = () => {
        terminate();
        finish({ kind: "cancelled" });
      };
      this.signal?.addEventListener("abort", onAbort, { once: true });
      if (this.signal?.aborted) onAbort();
      operation.then(
        (value) => finish({ kind: "done", value }),
        (error: unknown) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          this.signal?.removeEventListener("abort", onAbort);
          reject(error);
        },
      );
    });
  }

  private async resetDocumentContexts(): Promise<void> {
    await Promise.allSettled(
      [...this.attachedSessionIds].map((sessionId) =>
        this.view.cdp.send("Target.detachFromTarget", { sessionId }),
      ),
    );
    this.attachedSessionIds.clear();
    this.contexts.clear();
    this.rootFrame = undefined;
  }

  private async focusForInput(
    target: LocatorTarget,
    inputTargetToken: string,
    retargetInput = true,
  ): Promise<void> {
    const focused = await this.querySingleValue(
      target,
      `(() => {
        const element = ${String(retargetInput)}
          ? injected.retarget(elements[0], "follow-label") ?? elements[0]
          : elements[0];
        const result = element.matches(":focus") ? "done" : injected.focusNode(element, false);
        if (result !== "done") return result;
        Object.defineProperty(element, ${JSON.stringify(IAB_INPUT_TARGET_TOKEN_PROPERTY)}, {
          configurable: true,
          value: ${JSON.stringify(inputTargetToken)},
          writable: true,
        });
        return "done";
      })()`,
    );
    if (focused !== "done")
      throw new Error(`locator could not focus element: ${String(focused)}`);
  }

  private async selectOption(
    target: LocatorTarget,
    action: LocatorAction,
  ): Promise<unknown> {
    const selections = JSON.stringify(action.selections ?? []);
    const result = await this.querySingleValue(
      target,
      `injected.selectOptions(elements[0], ${selections})`,
    );
    if (typeof result === "string" && result.startsWith("error:")) {
      throw new Error(`locator.selectOption failed: ${result}`);
    }
    return result;
  }

  private async evaluateLocator(
    target: LocatorTarget,
    action: LocatorAction,
  ): Promise<unknown> {
    const context = await this.context(target.frame);
    const handle = await this.evaluate(
      context,
      `(() => {
        const injected = globalThis.${PLAYWRIGHT_GLOBAL};
        const root = document;
        ${strictVisibleSelectorSetup(target.selector)}
        if (!resolvedElement) throw new Error("No element matched selector");
        return resolvedElement;
      })()`,
      false,
    );
    if (!handle.objectId || handle.subtype === "null")
      throw new Error("locator resolved to no elements");
    const functionDeclaration =
      action.expressionKind === "function"
        ? `function(arg) { return (${action.expression})(this, arg); }`
        : `function(arg) { const element = this; return (${action.expression}); }`;
    try {
      const response = (await this.send(context, "Runtime.callFunctionOn", {
        objectId: handle.objectId,
        functionDeclaration,
        arguments: [{ value: action.arg }],
        awaitPromise: true,
        returnByValue: true,
      })) as RuntimeResponse;
      const error = runtimeError(response);
      if (error) throw new Error(`playwright.evaluate failed: ${error}`);
      return response.result?.value;
    } finally {
      await this.send(context, "Runtime.releaseObject", {
        objectId: handle.objectId,
      }).catch(() => undefined);
    }
  }

  private async queryValue(
    target: LocatorTarget,
    body: string,
  ): Promise<unknown> {
    const context = await this.context(target.frame);
    const expression = `(() => {
      const injected = globalThis.${PLAYWRIGHT_GLOBAL};
      const root = document;
      const elements = injected.querySelectorAll(injected.parseSelector(${JSON.stringify(target.selector)}), root);
      return ${body};
    })()`;
    return (await this.evaluate(context, expression, true)).value;
  }

  private async querySingleValue(
    target: LocatorTarget,
    body: string,
    options: { allowMissing?: boolean } = {},
  ): Promise<unknown> {
    const context = await this.context(target.frame);
    const missingGuard = options.allowMissing
      ? ""
      : 'if (!resolvedElement) throw new Error("No element matched selector");';
    const expression = `(() => {
      const injected = globalThis.${PLAYWRIGHT_GLOBAL};
      const root = document;
      ${strictVisibleSelectorSetup(target.selector)}
      ${missingGuard}
      return ${body};
    })()`;
    return (await this.evaluate(context, expression, true)).value;
  }

  private async resolveTarget(selector: string): Promise<LocatorTarget> {
    const segments = frameSegments(selector);
    let frame = await this.mainFrame();
    const boundaries: FrameBoundary[] = [];
    for (const frameSelector of segments.slice(0, -1)) {
      const context = await this.context(frame);
      const handle = await this.evaluate(
        context,
        `(() => {
          const injected = globalThis.${PLAYWRIGHT_GLOBAL};
          const root = document;
          ${strictVisibleSelectorSetup(frameSelector)}
          if (!resolvedElement) {
            throw new Error(${JSON.stringify(`frame locator resolved to no elements: ${frameSelector}`)});
          }
          return resolvedElement;
        })()`,
        false,
      );
      if (!handle.objectId || handle.subtype === "null")
        throw new Error("frame locator became detached");
      try {
        const described = (await this.send(context, "DOM.describeNode", {
          objectId: handle.objectId,
        })) as { node?: { backendNodeId?: number; frameId?: string } };
        const frameId = described.node?.frameId;
        if (!frameId)
          throw new Error("frame locator did not resolve to a frame owner");
        const ownerBackendNodeId = described.node?.backendNodeId;
        if (!ownerBackendNodeId)
          throw new Error("frame locator returned no backend node identity");
        const contentQuads = (await this.send(frame, "DOM.getContentQuads", {
          backendNodeId: ownerBackendNodeId,
        })) as { quads?: number[][] };
        const contentQuad = contentQuads.quads?.[0];
        if (
          !contentQuad ||
          contentQuad.length !== 8 ||
          !contentQuad.every((coordinate) => Number.isFinite(coordinate))
        ) {
          throw new Error("frame owner returned no valid content quad");
        }
        const child = await this.childFrame(frame, frameId);
        const childContext = await this.context(child);
        const childSizeValue = (
          await this.evaluate(
            childContext,
            `({ width: globalThis.innerWidth, height: globalThis.innerHeight })`,
            true,
          )
        ).value as { height?: unknown; width?: unknown } | undefined;
        if (
          !childSizeValue ||
          typeof childSizeValue.width !== "number" ||
          typeof childSizeValue.height !== "number" ||
          !Number.isFinite(childSizeValue.width) ||
          !Number.isFinite(childSizeValue.height) ||
          childSizeValue.width <= 0 ||
          childSizeValue.height <= 0
        ) {
          throw new Error("child frame returned no valid viewport size");
        }
        boundaries.push({
          childSize: {
            height: childSizeValue.height,
            width: childSizeValue.width,
          },
          contentQuad: contentQuad as FrameBoundary["contentQuad"],
          ownerBackendNodeId,
          parent: frame,
        });
        frame = child;
      } finally {
        await this.send(context, "Runtime.releaseObject", {
          objectId: handle.objectId,
        }).catch(() => undefined);
      }
    }
    return { boundaries, frame, selector: segments.at(-1)! };
  }

  private async mainFrame(): Promise<CdpTarget> {
    if (this.rootFrame) return this.rootFrame;
    await this.view.cdp.send("Page.enable");
    await this.view.cdp.send("Runtime.enable");
    await this.view.cdp.send("DOM.enable");
    const tree = (await this.view.cdp.send("Page.getFrameTree")) as {
      frameTree?: { frame?: { id?: string } };
    };
    const frameId = tree.frameTree?.frame?.id;
    if (!frameId)
      throw new Error("Page.getFrameTree returned no main frame id");
    this.rootFrame = { frameId };
    return this.rootFrame;
  }

  private async childFrame(
    parent: CdpTarget,
    frameId: string,
  ): Promise<CdpTarget> {
    const sameTarget = {
      frameId,
      sessionId: parent.sessionId,
    };
    try {
      await this.context(sameTarget);
      return sameTarget;
    } catch {
      const attached = (await this.view.cdp
        .send("Target.attachToTarget", { flatten: true, targetId: frameId })
        .catch(() => undefined)) as { sessionId?: string } | undefined;
      if (!attached?.sessionId)
        throw new Error(`unable to attach frame target ${frameId}`);
      this.attachedSessionIds.add(attached.sessionId);
      const target = { ...sameTarget, sessionId: attached.sessionId };
      await this.send(target, "Page.enable");
      await this.send(target, "Runtime.enable");
      await this.send(target, "DOM.enable");
      await this.context(target);
      return target;
    }
  }

  private contextKey(target: CdpTarget): string {
    return `${target.sessionId ?? "root"}:${target.frameId}`;
  }

  private async context(target: CdpTarget): Promise<FrameContext> {
    if (this.signal?.aborted) throw abortError();
    const key = this.contextKey(target);
    const existing = this.contexts.get(key);
    if (existing) return existing;
    const world = (await this.send(target, "Page.createIsolatedWorld", {
      frameId: target.frameId,
      grantUniveralAccess: false,
      worldName: PLAYWRIGHT_WORLD_NAME,
    })) as { executionContextId?: number };
    if (!world.executionContextId)
      throw new Error(`unable to create locator world for ${target.frameId}`);
    const context = { ...target, contextId: world.executionContextId };
    await this.inject(context);
    this.contexts.set(key, context);
    return context;
  }

  private async inject(context: FrameContext): Promise<void> {
    const present = await this.evaluate(
      context,
      `Boolean(globalThis.${PLAYWRIGHT_GLOBAL})`,
      true,
    );
    if (present.value === true) return;
    const options = {
      browserName: "chromium",
      customEngines: [],
      isUnderTest: false,
      sdkLanguage: "javascript",
      stableRafCount: 1,
      testIdAttributeName: "data-testid",
    };
    const source = getPlaywrightInjectedScriptSource();
    const expression = `(() => {
      const module = {};
      ${source}
      globalThis.${PLAYWRIGHT_GLOBAL} = new (module.exports.InjectedScript())(
        globalThis,
        ${JSON.stringify(options)}
      );
      return true;
    })()`;
    const injected = await this.evaluate(context, expression, true);
    if (injected.value !== true)
      throw new Error("unable to initialize Playwright locator runtime");
  }

  private async evaluate(
    context: FrameContext,
    expression: string,
    returnByValue: boolean,
    timeoutMs = this.timeoutMs,
  ): Promise<RuntimeResult> {
    if (this.signal?.aborted) throw abortError();
    const terminate = () => {
      void this.view.cdp
        .send("Runtime.terminateExecution", undefined, context.sessionId)
        .catch(() => undefined);
    };
    this.signal?.addEventListener("abort", terminate, { once: true });
    try {
      const response = (await this.send(context, "Runtime.evaluate", {
        awaitPromise: true,
        contextId: context.contextId,
        expression,
        returnByValue,
        timeout: timeoutMs,
      })) as RuntimeResponse;
      const error = runtimeError(response);
      if (error) throw new Error(error);
      return response.result ?? {};
    } finally {
      this.signal?.removeEventListener("abort", terminate);
    }
  }

  private send(
    target: { sessionId?: string },
    method: string,
    params?: unknown,
  ): Promise<unknown> {
    if (this.signal?.aborted) return Promise.reject(abortError());
    return this.view.cdp.send(method, params, target.sessionId);
  }

  private delay(timeoutMs: number): Promise<boolean> {
    if (this.signal?.aborted) return Promise.resolve(false);
    return new Promise((resolve) => {
      const finish = (completed: boolean) => {
        clearTimeout(timer);
        this.signal?.removeEventListener("abort", onAbort);
        resolve(completed);
      };
      const timer = setTimeout(() => finish(true), timeoutMs);
      const onAbort = () => finish(false);
      this.signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
}

/**
 * 使用与 domSnapshot 相同固定版本的 Playwright injected selector runtime；动作由 CDP Input
 * 下发，避免页面主 world 手写 selector 与 synthetic event 造成“快照可见但无法操作”。
 */
export async function executeIabPlaywrightLocator(
  view: ControlledView,
  action: LocatorAction,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<IabLocatorExecution> {
  const session = new IabPlaywrightLocatorSession(view, timeoutMs, signal);
  try {
    return await session.execute(action);
  } finally {
    await session.dispose();
  }
}
