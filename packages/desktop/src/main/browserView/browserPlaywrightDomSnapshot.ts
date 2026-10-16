import type { ControlledView, ControlledViewCdp } from "./browserCommandTypes.js";
import { getPlaywrightInjectedScriptSource } from "./playwrightInjectedScriptSource.js";

const PLAYWRIGHT_WORLD_NAME = "zcode-playwright-dom-snapshot";
const PLAYWRIGHT_GLOBAL = "__zcodePlaywrightInjected";
// Playwright 操作预算：顶层 snapshot 3s；IAB iframe 额外总预算 1s。
const TOP_LEVEL_TIMEOUT_MS = 3_000;
const IAB_IFRAME_TOTAL_BUDGET_MS = 1_000;
const IAB_IFRAME_CHILD_BUDGET_MS = 500;

interface CdpTarget {
  sessionId?: string;
}

interface RuntimeResult {
  objectId?: string;
  subtype?: string;
  value?: unknown;
}

interface RuntimeEvaluateResponse {
  exceptionDetails?: {
    text?: string;
    exception?: { description?: string; value?: unknown };
  };
  result?: RuntimeResult;
}

interface PlaywrightAriaSnapshot {
  full: string;
  iframeDepths: Record<string, number>;
  iframeRefs: string[];
}

interface SnapshotFrameContext extends CdpTarget {
  contextId: number;
  frameId: string;
}

interface SnapshotTreeNode {
  children: SnapshotTreeNode[];
  indent: number;
  line: string;
}

function abortError(): DOMException {
  return new DOMException("Browser DOM snapshot aborted", "AbortError");
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

function remainingBudget(deadline: number, maximum: number): number {
  return Math.max(1, Math.min(maximum, deadline - Date.now()));
}

function runtimeExceptionMessage(response: RuntimeEvaluateResponse): string | undefined {
  const exception = response.exceptionDetails;
  if (!exception) return undefined;
  return (
    exception.exception?.description ??
    (exception.exception?.value == null ? undefined : String(exception.exception.value)) ??
    exception.text ??
    "Playwright DOM snapshot evaluation failed"
  );
}

function parseSnapshotTree(snapshot: string): SnapshotTreeNode[] {
  const root: SnapshotTreeNode = { children: [], indent: -1, line: "" };
  const stack = [root];
  for (const rawLine of snapshot.split("\n")) {
    if (rawLine.trim() === "") continue;
    const indent = rawLine.match(/^ */)?.[0].length ?? 0;
    const node: SnapshotTreeNode = {
      children: [],
      indent,
      line: rawLine.slice(indent),
    };
    while (stack.length > 1 && indent <= (stack.at(-1)?.indent ?? -1)) stack.pop();
    stack.at(-1)?.children.push(node);
    stack.push(node);
  }
  return root.children;
}

function cleanSnapshotLine(line: string): string {
  return line.replace(/ \[ref=[^\]]+\]/g, "").replace(/ \[cursor=[^\]]+\]/g, "");
}

function normalizeSnapshotNode(node: SnapshotTreeNode): SnapshotTreeNode[] {
  const children = node.children.flatMap(normalizeSnapshotNode);
  const line = cleanSnapshotLine(node.line);
  // 无名称或内容的图片无法提供可定位依据，因此从交互快照中移除。
  if (/^- img(?: \[[^\]]+\])*:?$/.test(line)) return [];
  // 匿名结构容器本身不提供定位信息；压平时必须保留其 children。
  if (/^- (generic|listitem|group)(?: \[[^\]]+\])*:?$/.test(line)) return children;
  return [{ children, indent: node.indent, line }];
}

function renderSnapshotTree(nodes: SnapshotTreeNode[], depth = 0): string {
  const lines: string[] = [];
  const indent = "  ".repeat(depth);
  for (const node of nodes) {
    lines.push(indent + node.line);
    const children = renderSnapshotTree(node.children, depth + 1);
    if (children) lines.push(children);
  }
  return lines.join("\n");
}

/** Playwright DOM snapshot 的公开结果归一化：删除内部 ref/cursor 并压平无语义容器。 */
export function normalizeBrowserDomSnapshot(snapshot: string): string {
  if (!snapshot.startsWith("- ") && !snapshot.includes("\n- ") && !snapshot.includes("\n  - ")) {
    return snapshot;
  }
  return renderSnapshotTree(parseSnapshotTree(snapshot).flatMap(normalizeSnapshotNode));
}

function iframeRefFromLine(line: string): string | undefined {
  if (!line.trimStart().startsWith("- iframe")) return undefined;
  return line.match(/\[ref=([^\]]+)\]/)?.[1];
}

function mergeIframeSnapshots(snapshot: string, children: Map<string, string | undefined>): string {
  const output: string[] = [];
  for (const line of snapshot.split("\n")) {
    const ref = iframeRefFromLine(line);
    const child = ref ? children.get(ref) : undefined;
    if (!child) {
      output.push(line);
      continue;
    }
    const indent = line.match(/^ */)?.[0] ?? "";
    output.push(line.endsWith(":") ? line : `${line}:`);
    output.push(...child.split("\n").map((childLine) => `${indent}  ${childLine}`));
  }
  return output.join("\n");
}

class PlaywrightDomSnapshotSession {
  private readonly attachedSessionIds = new Set<string>();
  private readonly frameContexts = new Map<string, SnapshotFrameContext>();

  constructor(
    private readonly cdp: ControlledViewCdp,
    private readonly signal?: AbortSignal,
  ) {}

  async capture(): Promise<string> {
    throwIfAborted(this.signal);
    await this.send({}, "Page.enable");
    await this.send({}, "Runtime.enable");
    await this.send({}, "DOM.enable");
    const frameTree = (await this.send({}, "Page.getFrameTree")) as {
      frameTree?: { frame?: { id?: string } };
    };
    const mainFrameId = frameTree.frameTree?.frame?.id;
    if (!mainFrameId) throw new Error("Page.getFrameTree returned no main frame id");

    try {
      const snapshot = await this.readFrameSnapshot({ frameId: mainFrameId }, TOP_LEVEL_TIMEOUT_MS);
      if (!snapshot) return "";
      const deadline = Date.now() + IAB_IFRAME_TOTAL_BUDGET_MS;
      const expanded = await this.expandIframes(snapshot, { frameId: mainFrameId }, deadline);
      return normalizeBrowserDomSnapshot(expanded);
    } finally {
      await this.detachOwnedSessions();
    }
  }

  private async send(target: CdpTarget, method: string, params?: unknown): Promise<unknown> {
    throwIfAborted(this.signal);
    return this.cdp.send(method, params, target.sessionId);
  }

  private contextKey(target: CdpTarget, frameId: string): string {
    return `${target.sessionId ?? "root"}:${frameId}`;
  }

  private async ensureContext(
    target: CdpTarget & { frameId: string },
    timeoutMs: number,
  ): Promise<SnapshotFrameContext> {
    const key = this.contextKey(target, target.frameId);
    const existing = this.frameContexts.get(key);
    if (existing) return existing;
    const world = (await this.send(target, "Page.createIsolatedWorld", {
      frameId: target.frameId,
      grantUniveralAccess: false,
      worldName: PLAYWRIGHT_WORLD_NAME,
    })) as { executionContextId?: number };
    if (!world.executionContextId) {
      throw new Error(`Unable to create Playwright isolated world for frame ${target.frameId}`);
    }
    const context = { ...target, contextId: world.executionContextId };
    await this.ensureInjected(context, timeoutMs);
    this.frameContexts.set(key, context);
    return context;
  }

  private async ensureInjected(context: SnapshotFrameContext, timeoutMs: number): Promise<void> {
    const present = await this.evaluate(context, `Boolean(globalThis.${PLAYWRIGHT_GLOBAL})`, {
      returnByValue: true,
      timeoutMs,
    });
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
    const injected = await this.evaluate(context, expression, { returnByValue: true, timeoutMs });
    if (injected.value !== true)
      throw new Error("Unable to initialize Playwright injected runtime");
  }

  private async evaluate(
    context: SnapshotFrameContext,
    expression: string,
    options: { returnByValue: boolean; timeoutMs: number },
  ): Promise<RuntimeResult> {
    const response = (await this.send(context, "Runtime.evaluate", {
      awaitPromise: true,
      contextId: context.contextId,
      expression,
      returnByValue: options.returnByValue,
      timeout: options.timeoutMs,
    })) as RuntimeEvaluateResponse;
    const exception = runtimeExceptionMessage(response);
    if (exception) throw new Error(exception);
    return response.result ?? {};
  }

  private async readFrameSnapshot(
    target: CdpTarget & { frameId: string },
    timeoutMs: number,
  ): Promise<PlaywrightAriaSnapshot | undefined> {
    const context = await this.ensureContext(target, timeoutMs);
    const expression = `(() => {
      const injected = globalThis.${PLAYWRIGHT_GLOBAL};
      const root = document.body || document.documentElement;
      if (!root) return { full: "", iframeDepths: {}, iframeRefs: [] };
      const snapshot = injected.incrementalAriaSnapshot(root, { mode: "ai" });
      const iframeRefs = snapshot.iframeRefs.filter((ref) => {
        if (!(ref in snapshot.iframeDepths)) return false;
        try {
          const [frame] = injected.querySelectorAll(injected.parseSelector("aria-ref=" + ref), root);
          return frame != null &&
            frame.getAttribute("aria-hidden") !== "true" &&
            injected.elementState(frame, "visible").matches === true;
        } catch {
          return false;
        }
      });
      return { ...snapshot, iframeRefs };
    })()`;
    const result = await this.evaluate(context, expression, { returnByValue: true, timeoutMs });
    const value = result.value as Partial<PlaywrightAriaSnapshot> | undefined;
    if (
      !value ||
      typeof value.full !== "string" ||
      !Array.isArray(value.iframeRefs) ||
      !value.iframeDepths ||
      typeof value.iframeDepths !== "object"
    ) {
      throw new Error("Playwright injected runtime returned an invalid DOM snapshot");
    }
    return value as PlaywrightAriaSnapshot;
  }

  private async frameIdForRef(
    target: CdpTarget & { frameId: string },
    ref: string,
    timeoutMs: number,
  ): Promise<string | undefined> {
    const context = await this.ensureContext(target, timeoutMs);
    const expression = `(() => {
      const injected = globalThis.${PLAYWRIGHT_GLOBAL};
      const root = document.body || document.documentElement;
      if (!root) return null;
      const [frame] = injected.querySelectorAll(
        injected.parseSelector(${JSON.stringify(`aria-ref=${ref}`)}),
        root
      );
      return frame || null;
    })()`;
    const handle = await this.evaluate(context, expression, { returnByValue: false, timeoutMs });
    if (!handle.objectId || handle.subtype === "null") return undefined;
    try {
      const description = (await this.send(target, "DOM.describeNode", {
        objectId: handle.objectId,
      })) as { node?: { frameId?: string } };
      return description.node?.frameId;
    } finally {
      await this.send(target, "Runtime.releaseObject", { objectId: handle.objectId }).catch(
        () => undefined,
      );
    }
  }

  private async attachFrameTarget(frameId: string): Promise<CdpTarget | undefined> {
    const existing = [...this.attachedSessionIds].find((sessionId) =>
      this.frameContexts.has(this.contextKey({ sessionId }, frameId)),
    );
    if (existing) return { sessionId: existing };
    try {
      const attached = (await this.send({}, "Target.attachToTarget", {
        flatten: true,
        targetId: frameId,
      })) as { sessionId?: string };
      if (!attached.sessionId) return undefined;
      this.attachedSessionIds.add(attached.sessionId);
      const target = { sessionId: attached.sessionId };
      await this.send(target, "Page.enable");
      await this.send(target, "Runtime.enable");
      await this.send(target, "DOM.enable");
      return target;
    } catch {
      return undefined;
    }
  }

  private async childTarget(
    parent: CdpTarget & { frameId: string },
    childFrameId: string,
    timeoutMs: number,
  ): Promise<(CdpTarget & { frameId: string }) | undefined> {
    const sameTarget = { ...parent, frameId: childFrameId };
    try {
      await this.ensureContext(sameTarget, timeoutMs);
      return sameTarget;
    } catch {
      const attached = await this.attachFrameTarget(childFrameId);
      if (!attached) return undefined;
      const oopifTarget = { ...attached, frameId: childFrameId };
      try {
        await this.ensureContext(oopifTarget, timeoutMs);
        return oopifTarget;
      } catch {
        return undefined;
      }
    }
  }

  private async readChildSnapshot(
    parent: CdpTarget & { frameId: string },
    ref: string,
    deadline: number,
  ): Promise<string | undefined> {
    if (Date.now() >= deadline) return undefined;
    const timeoutMs = remainingBudget(deadline, IAB_IFRAME_CHILD_BUDGET_MS);
    let frameId = await this.frameIdForRef(parent, ref, timeoutMs).catch(() => undefined);
    if (!frameId || Date.now() >= deadline) return undefined;
    let target = await this.childTarget(parent, frameId, timeoutMs);
    if (!target && Date.now() < deadline) {
      // OOPIF 导航时 iframe node 的 frameId 可能短暂指向已经销毁的 target。
      // 先让 Chromium 刷新 target 列表，再从同一个 Playwright aria-ref 重新解析；否则
      // 主快照会偶发只剩 iframe 空壳，真实 Electron/CDP 页面可以稳定复现。
      await this.send(parent, "Target.getTargets").catch(() => undefined);
      frameId = await this.frameIdForRef(
        parent,
        ref,
        remainingBudget(deadline, IAB_IFRAME_CHILD_BUDGET_MS),
      ).catch(() => undefined);
      if (frameId) {
        target = await this.childTarget(
          parent,
          frameId,
          remainingBudget(deadline, IAB_IFRAME_CHILD_BUDGET_MS),
        );
      }
    }
    if (!target || Date.now() >= deadline) return undefined;
    const child = await this.readFrameSnapshot(
      target,
      remainingBudget(deadline, IAB_IFRAME_CHILD_BUDGET_MS),
    ).catch(() => undefined);
    if (!child) return undefined;
    return this.expandIframes(child, target, deadline);
  }

  private async expandIframes(
    snapshot: PlaywrightAriaSnapshot,
    target: CdpTarget & { frameId: string },
    deadline: number,
  ): Promise<string> {
    const refs = snapshot.iframeRefs.filter((ref) => ref in snapshot.iframeDepths);
    if (refs.length === 0 || Date.now() >= deadline) return snapshot.full;
    const children = new Map(
      await Promise.all(
        refs.map(
          async (ref) => [ref, await this.readChildSnapshot(target, ref, deadline)] as const,
        ),
      ),
    );
    return mergeIframeSnapshots(snapshot.full, children);
  }

  private async detachOwnedSessions(): Promise<void> {
    await Promise.allSettled(
      [...this.attachedSessionIds].map((sessionId) =>
        this.cdp.send("Target.detachFromTarget", { sessionId }),
      ),
    );
    this.attachedSessionIds.clear();
  }
}

export async function captureBrowserDomSnapshot(
  view: ControlledView,
  signal?: AbortSignal,
): Promise<string> {
  return new PlaywrightDomSnapshotSession(view.cdp, signal).capture();
}
