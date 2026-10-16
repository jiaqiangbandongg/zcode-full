/* eslint-disable max-lines -- Browser/Tab/Tabs facade 共享 selection、transport 与对象 identity；拆分前保持同一连接状态机。 */
import {
  BROWSER_VIEWPORT_LIMITS,
  type BrowserBackendDescriptor,
  type BrowserBackendType,
  type BrowserCapabilityDescriptor,
  type BrowserCommand,
  type BrowserCommandResult,
  type BrowserDialog,
  type BrowserKeyModifier,
  type BrowserMouseButton,
  type BrowserPageState,
  type BrowserRecordingJob,
  type BrowserRecordingOptions,
  type BrowserSnapshot,
  type BrowserSnapshotElement,
  type BrowserTabSummary,
  type BrowserUserTabInfo,
  type BrowserViewportSize,
} from "@zcode/contracts/browser-control";
import { loadBrowserDocumentation } from "./documentation.js";
import {
  BrowserApiPolicy,
  createBrowserApiProxy,
  loadBrowserApiManifest,
  type BrowserApiManifest,
} from "./manifest.js";
import { selectBrowserForUrl, selectDefaultBrowser, selectTabForUrl } from "./selection.js";
import {
  configurePlaywrightObjectWrapper,
  createPlaywrightAPI,
  type PlaywrightAPI,
} from "./playwright.js";
import { BrowserCommandError, base64ToBytes, expectOk, expectPayload } from "./result.js";

export type BrowserExecuteFn = (command: BrowserCommand) => Promise<BrowserCommandResult>;
export type BrowserAvailabilityGuard = () => void;
export type BrowserTransportExecuteFn = (
  browserId: string,
  browserGeneration: number,
  command: BrowserCommand,
) => Promise<BrowserCommandResult>;
export type { BrowserBackendType };
export type BrowserCapabilityInfo = BrowserCapabilityDescriptor;

/** 视口坐标点（cua 坐标路 / drag / elementInfo 用；与 CDP Input 同坐标系）。 */
export interface Point {
  x: number;
  y: number;
}

export type BrowserInfo = BrowserBackendDescriptor;
export type BrowserDescriptor = Omit<BrowserInfo, "generation">;

export interface BrowserTabInfo {
  id: string;
  active?: boolean;
  title?: string;
  url?: string;
  viewport: BrowserViewportSize;
}

export class BrowserCapability {
  readonly #readDocumentation: (name?: string) => string;

  constructor(
    readonly id: string,
    readonly description: string,
    readDocumentation: (name?: string) => string,
  ) {
    this.#readDocumentation = readDocumentation;
  }

  async documentation(): Promise<string> {
    return this.#readDocumentation(this.id);
  }
}

export class VisibilityBrowserCapability extends BrowserCapability {
  constructor(
    info: BrowserCapabilityInfo,
    readDocumentation: (name?: string) => string,
    private readonly execute: BrowserExecuteFn,
  ) {
    super(info.id, info.description, readDocumentation);
  }

  async get(): Promise<boolean> {
    const command: BrowserCommand = { method: "browserVisibilityGet" };
    const result = expectOk(command, await this.execute(command));
    if (typeof result.value !== "boolean") {
      throw new Error("Browser visibility result is missing a boolean value");
    }
    return result.value;
  }

  async set(visible: boolean): Promise<void> {
    if (typeof visible !== "boolean") throw new TypeError("visibility.set requires a boolean");
    const command: BrowserCommand = { method: "browserVisibilitySet", visible };
    expectOk(command, await this.execute(command));
  }
}

export class BrowserCapabilityCollection {
  readonly #read: () => readonly BrowserCapabilityInfo[];
  readonly #readDocumentation: (name?: string) => string;

  constructor(
    read: () => readonly BrowserCapabilityInfo[],
    readDocumentation: (name?: string) => string,
    private readonly execute?: BrowserExecuteFn,
    private readonly assertAvailable: BrowserAvailabilityGuard = () => undefined,
  ) {
    this.#read = read;
    this.#readDocumentation = readDocumentation;
  }

  async list(): Promise<BrowserCapabilityInfo[]> {
    this.assertAvailable();
    return this.#read().map((capability) => ({ ...capability }));
  }

  get(id: "visibility"): Promise<VisibilityBrowserCapability>;
  get(id: string): Promise<BrowserCapability>;
  async get(id: string): Promise<BrowserCapability> {
    this.assertAvailable();
    const capability = this.#read().find((candidate) => candidate.id === id);
    if (!capability) throw new Error(`Browser capability '${id}' is unavailable`);
    if (id === "visibility" && this.execute) {
      return new VisibilityBrowserCapability(capability, this.#readDocumentation, this.execute);
    }
    return new BrowserCapability(capability.id, capability.description, this.#readDocumentation);
  }
}

/**
 * browser-client 只依赖 backend-neutral transport。IAB、Chrome extension 和 CDP provider
 * 都通过相同 descriptor/execute 接口接入，facade 不再自行伪造某个 backend 可用。
 */
export interface BrowserClientTransport {
  list(): Promise<BrowserInfo[]>;
  execute: BrowserTransportExecuteFn;
}

export interface CuaTab {
  click(options: Point & { button?: number; keypress?: string[] }): Promise<void>;
  double_click(options: Point & { keypress?: string[] }): Promise<void>;
  downloadMedia(options: Point & { timeoutMs?: number }): Promise<void>;
  drag(options: { keys?: string[]; path: Point[] }): Promise<void>;
  keypress(options: { keys: string[] }): Promise<void>;
  move(options: Point & { keys?: string[] }): Promise<void>;
  scroll(options: Point & { keypress?: string[]; scrollX: number; scrollY: number }): Promise<void>;
  type(options: { text: string }): Promise<void>;
}

export interface DomCuaTab {
  get_visible_dom(): Promise<BrowserSnapshot>;
  click(options: { node_id: string }): Promise<void>;
  double_click(options: { node_id: string }): Promise<void>;
  downloadMedia(options: { node_id: string; timeoutMs?: number }): Promise<void>;
  type(options: { text: string }): Promise<void>;
  scroll(options: { node_id?: string; x: number; y: number }): Promise<void>;
  keypress(options: { keys: string[] }): Promise<void>;
}

export class BrowserRecordingAPI {
  constructor(private readonly run: (command: BrowserCommand) => Promise<BrowserCommandResult>) {}

  async start(options: BrowserRecordingOptions = {}): Promise<BrowserRecordingJob> {
    const command: BrowserCommand = { method: "recordingStart", options };
    const result = await this.run(command);
    return expectPayload(command, result, result.recording, "recording");
  }

  async status(
    recordingId: string,
    options: { outputPath?: string } = {},
  ): Promise<BrowserRecordingJob> {
    if (!recordingId) throw new TypeError("recording.status requires a recording id");
    const command: BrowserCommand = {
      method: "recordingStatus",
      recordingId,
      ...options,
    };
    const result = await this.run(command);
    return expectPayload(command, result, result.recording, "recording");
  }

  async cancel(recordingId: string): Promise<BrowserRecordingJob> {
    if (!recordingId) throw new TypeError("recording.cancel requires a recording id");
    const command: BrowserCommand = { method: "recordingCancel", recordingId };
    const result = await this.run(command);
    return expectPayload(command, result, result.recording, "recording");
  }
}

function validateViewportSize(viewportSize: BrowserViewportSize): void {
  if (
    !Number.isInteger(viewportSize?.width) ||
    viewportSize.width < BROWSER_VIEWPORT_LIMITS.minWidth ||
    viewportSize.width > BROWSER_VIEWPORT_LIMITS.maxWidth ||
    !Number.isInteger(viewportSize?.height) ||
    viewportSize.height < BROWSER_VIEWPORT_LIMITS.minHeight ||
    viewportSize.height > BROWSER_VIEWPORT_LIMITS.maxHeight
  ) {
    throw new TypeError(
      `setViewportSize requires integer width ${BROWSER_VIEWPORT_LIMITS.minWidth}..${BROWSER_VIEWPORT_LIMITS.maxWidth} ` +
        `and height ${BROWSER_VIEWPORT_LIMITS.minHeight}..${BROWSER_VIEWPORT_LIMITS.maxHeight}`,
    );
  }
}

function cuaButton(button = 1): BrowserMouseButton {
  if (button === 2) return "middle";
  if (button === 3) return "right";
  if (button === 1) return "left";
  throw new Error(`Unsupported CUA mouse button: ${button}`);
}

function cuaModifiers(keys: string[] = []): BrowserKeyModifier[] {
  return keys.filter((key): key is BrowserKeyModifier =>
    ["Alt", "Control", "ControlOrMeta", "Meta", "Shift"].includes(key),
  );
}

export class RawTab {
  constructor(private readonly run: (command: BrowserCommand) => Promise<BrowserCommandResult>) {}

  navigate(url: string): Promise<BrowserCommandResult> {
    return this.run({ method: "navigate", url });
  }

  getState(): Promise<BrowserCommandResult> {
    return this.run({ method: "getState" });
  }

  screenshot(opts?: {
    ref?: string;
    fullPage?: boolean;
    clip?: { x: number; y: number; width: number; height: number };
  }): Promise<BrowserCommandResult> {
    return this.run({ method: "screenshot", ...opts });
  }

  back(): Promise<BrowserCommandResult> {
    return this.run({ method: "back" });
  }

  forward(): Promise<BrowserCommandResult> {
    return this.run({ method: "forward" });
  }

  reload(): Promise<BrowserCommandResult> {
    return this.run({ method: "reload" });
  }

  snapshot(opts?: {
    maxElements?: number;
    includeHidden?: boolean;
  }): Promise<BrowserCommandResult> {
    return this.run({ method: "snapshot", ...opts });
  }

  click(
    target:
      | string
      | (Point & {
          button?: BrowserMouseButton;
          doubleClick?: boolean;
          modifiers?: BrowserKeyModifier[];
        }),
    opts?: {
      button?: BrowserMouseButton;
      doubleClick?: boolean;
      modifiers?: BrowserKeyModifier[];
    },
  ): Promise<BrowserCommandResult> {
    if (typeof target === "string") {
      return this.run({ method: "click", ref: target, ...opts });
    }
    const { x, y, ...rest } = target;
    return this.run({ method: "click", x, y, ...rest, ...opts });
  }

  type(text: string, opts?: { ref?: string }): Promise<BrowserCommandResult> {
    return this.run({ method: "type", text, ref: opts?.ref });
  }

  press(
    key: string,
    opts?: { ref?: string; modifiers?: BrowserKeyModifier[] },
  ): Promise<BrowserCommandResult> {
    return this.run({ method: "press", key, ref: opts?.ref, modifiers: opts?.modifiers });
  }

  scroll(opts: { ref?: string; x?: number; y?: number }): Promise<BrowserCommandResult> {
    return this.run({ method: "scroll", ...opts });
  }

  hover(target: string | Point): Promise<BrowserCommandResult> {
    if (typeof target === "string") {
      return this.run({ method: "hover", ref: target });
    }
    return this.run({ method: "hover", x: target.x, y: target.y });
  }

  select(ref: string, values: string[]): Promise<BrowserCommandResult> {
    return this.run({ method: "select", ref, values });
  }

  check(ref: string, checked = true): Promise<BrowserCommandResult> {
    return this.run({ method: "check", ref, checked });
  }

  drag(
    from: string | Point,
    to: string | Point,
    opts?: { modifiers?: BrowserKeyModifier[] },
  ): Promise<BrowserCommandResult> {
    const fromPart = typeof from === "string" ? { fromRef: from } : { from };
    const toPart = typeof to === "string" ? { toRef: to } : { to };
    return this.run({ method: "drag", ...fromPart, ...toPart, ...opts });
  }

  close(): Promise<BrowserCommandResult> {
    return this.run({ method: "close" });
  }

  elementInfo(x: number, y: number): Promise<BrowserCommandResult> {
    return this.run({ method: "elementInfo", x, y });
  }

  evaluate(
    expressionOrFn: string | ((...args: unknown[]) => unknown),
  ): Promise<BrowserCommandResult> {
    const expression =
      typeof expressionOrFn === "function" ? `(${expressionOrFn.toString()})()` : expressionOrFn;
    return this.run({ method: "evaluate", expression });
  }

  getDialog(): Promise<BrowserCommandResult> {
    return this.run({ method: "getDialog" });
  }

  handleDialog(accept: boolean, promptText?: string): Promise<BrowserCommandResult> {
    return this.run({ method: "handleDialog", accept, promptText });
  }
}

export type JsDialog = AlertDialog | ConfirmDialog | PromptDialog | BeforeUnloadDialog;

class DialogBase {
  constructor(
    readonly type: BrowserDialog["type"],
    protected readonly respond: (accept: boolean, promptText?: string) => Promise<void>,
  ) {}

  dismiss(): Promise<void> {
    return this.respond(false);
  }
}

export class AlertDialog extends DialogBase {
  declare readonly type: "alert";
}

export class BeforeUnloadDialog extends DialogBase {
  declare readonly type: "beforeunload";
}

export class ConfirmDialog extends DialogBase {
  declare readonly type: "confirm";

  accept(): Promise<void> {
    return this.respond(true);
  }
}

export class PromptDialog extends DialogBase {
  declare readonly type: "prompt";

  accept(text: string): Promise<void> {
    return this.respond(true, text);
  }
}

function createJsDialog(
  dialog: BrowserDialog,
  respond: (accept: boolean, promptText?: string) => Promise<void>,
): JsDialog {
  switch (dialog.type) {
    case "confirm":
      return new ConfirmDialog("confirm", respond);
    case "prompt":
      return new PromptDialog("prompt", respond);
    case "beforeunload":
      return new BeforeUnloadDialog("beforeunload", respond);
    default:
      return new AlertDialog("alert", respond);
  }
}

export class Tab {
  readonly id: string;
  readonly raw: RawTab;
  readonly capabilities: BrowserCapabilityCollection;
  playwright: PlaywrightAPI;
  recording: BrowserRecordingAPI;
  private wrapObject = <T extends object>(value: T, _objectName: string): T => value;
  private viewportSizeValue: BrowserViewportSize | null;

  constructor(
    private readonly execute: BrowserExecuteFn,
    readonly tabId?: string,
    summary?: Pick<BrowserTabSummary, "url" | "title" | "active" | "viewport">,
    capabilityDescriptors: readonly BrowserCapabilityInfo[] = [],
    readCapabilityDocumentation: (name?: string) => string = () => "",
  ) {
    this.id = tabId ?? "";
    this.raw = new RawTab((command) => this.run(command));
    this.capabilities = new BrowserCapabilityCollection(
      () => capabilityDescriptors,
      readCapabilityDocumentation,
    );
    this.playwright = createPlaywrightAPI((command) => this.run(command));
    this.recording = new BrowserRecordingAPI((command) => this.run(command));
    this.viewportSizeValue = summary?.viewport ? { ...summary.viewport } : null;
  }

  private run(command: BrowserCommand): Promise<BrowserCommandResult> {
    const withTab = this.tabId ? { ...command, tabId: this.tabId } : command;
    return this.execute(withTab);
  }

  /** Browser connection capability policy 在对象建好后注入，并保持 Playwright 对象 identity。 */
  applyPlaywrightPolicy(policy: BrowserApiPolicy): this {
    const wrap = <T extends object>(value: T, objectName: string): T =>
      createBrowserApiProxy(value, objectName, policy, { hideUnknown: true });
    this.wrapObject = wrap;
    this.playwright = configurePlaywrightObjectWrapper(this.playwright, wrap);
    this.recording = wrap(this.recording, "BrowserRecordingAPI");
    return this;
  }

  private async action(command: BrowserCommand): Promise<void> {
    expectOk(command, await this.run(command));
  }

  async goto(url: string): Promise<void> {
    await this.action({ method: "navigate", url });
  }

  async url(): Promise<string | undefined> {
    return (await this.getState()).url || undefined;
  }

  async title(): Promise<string | undefined> {
    return (await this.getState()).title || undefined;
  }

  async navigate(url: string): Promise<void> {
    await this.goto(url);
  }

  async getState(): Promise<BrowserPageState> {
    const command: BrowserCommand = { method: "getState" };
    const result = await this.run(command);
    return expectPayload(command, result, result.state, "state");
  }

  /** 对齐 Playwright Page.setViewportSize；ZCode 额外施加内置自由尺寸的安全边界。 */
  async setViewportSize(viewportSize: BrowserViewportSize): Promise<void> {
    validateViewportSize(viewportSize);
    await this.action({ method: "browserViewportSet", ...viewportSize });
    this.viewportSizeValue = { ...viewportSize };
  }

  /** 对齐 Playwright Page.viewportSize；返回本次 tab binding 最近一次观察到的实际值。 */
  viewportSize(): BrowserViewportSize | null {
    return this.viewportSizeValue ? { ...this.viewportSizeValue } : null;
  }

  async screenshot(opts?: {
    fullPage?: boolean;
    clip?: { x: number; y: number; width: number; height: number };
  }): Promise<Uint8Array> {
    const command: BrowserCommand = { method: "screenshot", ...opts };
    const result = await this.run(command);
    const image = expectPayload(command, result, result.image, "image");
    return base64ToBytes(image.base64);
  }

  async back(): Promise<void> {
    await this.action({ method: "back" });
  }

  async forward(): Promise<void> {
    await this.action({ method: "forward" });
  }

  async reload(): Promise<void> {
    await this.action({ method: "reload" });
  }

  async snapshot(opts?: {
    maxElements?: number;
    includeHidden?: boolean;
  }): Promise<BrowserSnapshot> {
    const command: BrowserCommand = { method: "snapshot", ...opts };
    const result = await this.run(command);
    return expectPayload(command, result, result.snapshot, "snapshot");
  }

  async click(
    target:
      | string
      | (Point & {
          button?: BrowserMouseButton;
          doubleClick?: boolean;
          modifiers?: BrowserKeyModifier[];
        }),
    opts?: {
      button?: BrowserMouseButton;
      doubleClick?: boolean;
      modifiers?: BrowserKeyModifier[];
    },
  ): Promise<void> {
    await this.action(
      typeof target === "string"
        ? { method: "click", ref: target, ...opts }
        : (() => {
            const { x, y, ...rest } = target;
            return { method: "click", x, y, ...rest, ...opts };
          })(),
    );
  }

  async type(text: string, opts?: { ref?: string }): Promise<void> {
    await this.action({ method: "type", text, ref: opts?.ref });
  }

  async press(
    key: string,
    opts?: { ref?: string; modifiers?: BrowserKeyModifier[] },
  ): Promise<void> {
    await this.action({ method: "press", key, ref: opts?.ref, modifiers: opts?.modifiers });
  }

  async scroll(opts: { ref?: string; x?: number; y?: number }): Promise<void> {
    await this.action({ method: "scroll", ...opts });
  }

  async hover(target: string | Point): Promise<void> {
    await this.action(
      typeof target === "string"
        ? { method: "hover", ref: target }
        : { method: "hover", x: target.x, y: target.y },
    );
  }

  async select(ref: string, values: string[]): Promise<void> {
    await this.action({ method: "select", ref, values });
  }

  async check(ref: string, checked = true): Promise<void> {
    await this.action({ method: "check", ref, checked });
  }

  async drag(
    from: string | Point,
    to: string | Point,
    opts?: { modifiers?: BrowserKeyModifier[] },
  ): Promise<void> {
    const fromPart = typeof from === "string" ? { fromRef: from } : { from };
    const toPart = typeof to === "string" ? { toRef: to } : { to };
    await this.action({ method: "drag", ...fromPart, ...toPart, ...opts });
  }

  async close(): Promise<void> {
    await this.action({ method: "close" });
  }

  async finalize(opts?: { deliverable?: boolean }): Promise<void> {
    await this.action({ method: "finalize", deliverable: opts?.deliverable });
  }

  async markDeliverable(): Promise<void> {
    await this.action({ method: "markDeliverable", tabId: this.id });
  }

  async markHandoff(): Promise<void> {
    await this.action({ method: "markHandoff", tabId: this.id });
  }

  async elementInfo(x: number, y: number): Promise<BrowserSnapshotElement | undefined> {
    const command: BrowserCommand = { method: "elementInfo", x, y };
    const result = expectOk(command, await this.run(command));
    return result.element;
  }

  async evaluate(expressionOrFn: string | ((...args: unknown[]) => unknown)): Promise<unknown> {
    const expression =
      typeof expressionOrFn === "function" ? `(${expressionOrFn.toString()})()` : expressionOrFn;
    const command: BrowserCommand = { method: "evaluate", expression };
    const result = expectOk(command, await this.run(command));
    return result.value;
  }

  async getDialog(): Promise<BrowserDialog | null> {
    const command: BrowserCommand = { method: "getDialog" };
    const result = expectOk(command, await this.run(command));
    return result.dialog ?? null;
  }

  async getJsDialog(): Promise<JsDialog | undefined> {
    const dialog = await this.getDialog();
    if (!dialog) return undefined;
    const value = createJsDialog(dialog, (accept, promptText) =>
      this.handleDialog(accept, promptText),
    );
    const objectName =
      dialog.type === "confirm"
        ? "ConfirmDialog"
        : dialog.type === "prompt"
          ? "PromptDialog"
          : dialog.type === "beforeunload"
            ? "BeforeUnloadDialog"
            : "AlertDialog";
    return this.wrapObject(value, objectName);
  }

  async handleDialog(accept: boolean, promptText?: string): Promise<void> {
    await this.action({ method: "handleDialog", accept, promptText });
  }

  get cua(): CuaTab {
    return this.wrapObject(
      {
        click: ({ x, y, button, keypress }) => {
          const modifiers = cuaModifiers(keypress);
          return this.action({
            method: "click",
            x,
            y,
            button: cuaButton(button),
            ...(modifiers.length > 0 ? { modifiers } : {}),
          });
        },
        double_click: ({ x, y, keypress }) => {
          const modifiers = cuaModifiers(keypress);
          return this.action({
            method: "click",
            x,
            y,
            doubleClick: true,
            ...(modifiers.length > 0 ? { modifiers } : {}),
          });
        },
        downloadMedia: ({ x, y }) => this.action({ method: "click", x, y }),
        drag: ({ keys, path }) => {
          if (path.length === 0) throw new Error("cua.drag requires a non-empty path");
          const modifiers = cuaModifiers(keys);
          return this.action({
            method: "cuaDrag",
            path,
            ...(modifiers.length > 0 ? { modifiers } : {}),
          });
        },
        keypress: ({ keys }) => this.action({ method: "cuaKeypress", keys }),
        move: ({ x, y, keys }) => {
          const modifiers = cuaModifiers(keys);
          return this.action({
            method: "hover",
            x,
            y,
            ...(modifiers.length > 0 ? { modifiers } : {}),
          });
        },
        scroll: ({ x, y, keypress, scrollX, scrollY }) => {
          const modifiers = cuaModifiers(keypress);
          return this.action({
            method: "cuaScroll",
            x,
            y,
            scrollX,
            scrollY,
            ...(modifiers.length > 0 ? { modifiers } : {}),
          });
        },
        type: ({ text }) => this.action({ method: "type", text }),
      },
      "CUAAPI",
    );
  }

  get dom_cua(): DomCuaTab {
    return this.wrapObject(
      {
        get_visible_dom: () => this.snapshot(),
        click: ({ node_id }) => this.action({ method: "click", ref: node_id }),
        double_click: ({ node_id }) =>
          this.action({ method: "click", ref: node_id, doubleClick: true }),
        downloadMedia: ({ node_id }) => this.action({ method: "click", ref: node_id }),
        type: ({ text }) => this.action({ method: "type", text }),
        scroll: ({ node_id, x, y }) =>
          this.action({ method: "domCuaScroll", nodeId: node_id, scrollX: x, scrollY: y }),
        keypress: ({ keys }) => this.action({ method: "cuaKeypress", keys }),
      },
      "DomCUAAPI",
    );
  }
}

export class BrowserTabs {
  constructor(
    private readonly execute: BrowserExecuteFn,
    private readonly wrapTab: (tab: Tab) => Tab = (tab) => tab,
    private readonly capabilities: readonly BrowserCapabilityInfo[] = [],
    private readonly readCapabilityDocumentation: (name?: string) => string = () => "",
  ) {}

  private tab(summary: BrowserTabSummary): Tab {
    return this.wrapTab(
      new Tab(
        this.execute,
        summary.tabId,
        summary,
        this.capabilities,
        this.readCapabilityDocumentation,
      ),
    );
  }

  private async summaries(): Promise<BrowserTabSummary[]> {
    const command: BrowserCommand = { method: "list" };
    const result = await this.execute(command);
    expectOk(command, result);
    return result.tabs ?? [];
  }

  async list(): Promise<BrowserTabInfo[]> {
    return (await this.summaries()).map((summary) => ({
      id: summary.tabId,
      viewport: { ...summary.viewport },
      ...(summary.active ? { active: true } : {}),
      ...(summary.title ? { title: summary.title } : {}),
      ...(summary.url ? { url: summary.url } : {}),
    }));
  }

  async selected(): Promise<Tab | undefined> {
    const summaries = await this.summaries();
    const selected = summaries.find((summary) => summary.active === true) ?? summaries.at(-1);
    return selected ? this.tab(selected) : undefined;
  }

  async get(tabId: string): Promise<Tab> {
    const summary = (await this.summaries()).find((candidate) => candidate.tabId === tabId);
    if (!summary) {
      throw new BrowserCommandError(
        { method: "list" },
        {
          ok: false,
          elapsedMs: 0,
          error: { code: "backend_unavailable", message: `Browser tab '${tabId}' is unavailable` },
        },
        "backend_unavailable",
      );
    }
    const command: BrowserCommand = { method: "activateTab", tabId };
    const result = await this.execute(command);
    const activated = expectPayload(command, result, result.tab, "tab");
    return this.tab(activated);
  }

  async new(): Promise<Tab> {
    const command: BrowserCommand = { method: "newTab" };
    const result = await this.execute(command);
    const summary = expectPayload(command, result, result.tab, "tab");
    return this.tab(summary);
  }

  /**
   * open(url) 的复用入口：按 URL 匹配已有 agent-owned tab，命中则激活（activateTab，
   * 用户立即看到该 tab）并返回，未命中返回 undefined。list/activate 的失败向调用方抛出，
   * 由 open() 统一降级为 newTab，复用链路绝不阻断任务。
   */
  async reuse(url: string): Promise<Tab | undefined> {
    const summaries = await this.summaries();
    const matched = selectTabForUrl(url, summaries);
    if (!matched) return undefined;
    const command: BrowserCommand = { method: "activateTab", tabId: matched.tabId };
    const result = await this.execute(command);
    const activated = expectPayload(command, result, result.tab, "tab");
    return this.tab(activated);
  }

  async finalize(
    options: {
      keep?: Array<{
        tab: string | Tab | { id: string };
        status: "handoff" | "deliverable";
      }>;
    } = {},
  ): Promise<void> {
    const keep = (options.keep ?? []).map(({ tab, status }) => ({
      tabId: typeof tab === "string" ? tab : tab.id,
      status,
    }));
    const command: BrowserCommand = { method: "finalizeTabs", keep };
    expectOk(command, await this.execute(command));
  }
}

export interface BrowserHistoryOptions {
  from?: string | Date;
  limit?: number;
  queries?: string[];
  to?: string | Date;
}

export interface BrowserHistoryEntry {
  dateVisited: string;
  title?: string;
  url: string;
}

export class BrowserUser {
  constructor(
    private readonly execute: BrowserExecuteFn,
    private readonly wrapTab: (tab: Tab) => Tab,
    private readonly capabilities: readonly BrowserCapabilityInfo[] = [],
    private readonly readCapabilityDocumentation: (name?: string) => string = () => "",
  ) {}

  async openTabs(): Promise<BrowserUserTabInfo[]> {
    const command: BrowserCommand = { method: "listUserTabs" };
    const result = expectOk(command, await this.execute(command));
    return result.userTabs ?? [];
  }

  async claimTab(tab: string | BrowserUserTabInfo): Promise<Tab> {
    const command: BrowserCommand = {
      method: "claimTab",
      tabId: typeof tab === "string" ? tab : tab.id,
    };
    const result = await this.execute(command);
    const summary = expectPayload(command, result, result.tab, "tab");
    return this.wrapTab(
      new Tab(
        this.execute,
        summary.tabId,
        summary,
        this.capabilities,
        this.readCapabilityDocumentation,
      ),
    );
  }

  async history(_options: BrowserHistoryOptions = {}): Promise<BrowserHistoryEntry[]> {
    // IAB 没有 Chromium History provider。该 member 会由 IAB manifest override 隐藏；保留方法
    // 只用于未来 extension backend 复用同一对象类型，避免当前 backend 伪造历史记录。
    throw new Error("Browser history is unavailable for the iab backend");
  }
}

export class Browser {
  readonly tabs: BrowserTabs;
  readonly user: BrowserUser;
  readonly capabilities: BrowserCapabilityCollection;
  private readonly defaultTab: Tab;
  private info: BrowserInfo;
  private readonly execute: BrowserExecuteFn;
  private readonly policy: BrowserApiPolicy;
  private readonly runtimeObject: Browser;

  constructor(
    info: BrowserInfo,
    execute: BrowserTransportExecuteFn,
    private readonly readDocumentation: (name?: string, descriptor?: BrowserInfo) => string,
    manifest: BrowserApiManifest,
    assertAvailable: BrowserAvailabilityGuard = () => undefined,
  ) {
    this.info = info;
    this.policy = new BrowserApiPolicy(manifest, info);
    this.execute = (command) => execute(this.info.id, this.info.generation, command);
    const capabilityDocumentation = (name?: string) => this.readDocumentation(name, this.info);
    const wrapTab = (tab: Tab) =>
      createBrowserApiProxy(tab.applyPlaywrightPolicy(this.policy), "Tab", this.policy);
    this.capabilities = new BrowserCapabilityCollection(
      () => this.info.capabilities.browser ?? [],
      capabilityDocumentation,
      this.execute,
      assertAvailable,
    );
    this.tabs = createBrowserApiProxy(
      new BrowserTabs(
        this.execute,
        wrapTab,
        this.info.capabilities.tab ?? [],
        capabilityDocumentation,
      ),
      "Tabs",
      this.policy,
    );
    this.user = createBrowserApiProxy(
      new BrowserUser(
        this.execute,
        wrapTab,
        this.info.capabilities.tab ?? [],
        capabilityDocumentation,
      ),
      "BrowserUser",
      this.policy,
    );
    this.defaultTab = wrapTab(
      new Tab(
        this.execute,
        undefined,
        undefined,
        this.info.capabilities.tab ?? [],
        capabilityDocumentation,
      ),
    );
    this.runtimeObject = createBrowserApiProxy(this, "Browser", this.policy);
  }

  get browserId(): string {
    return this.info.id;
  }

  get type(): BrowserBackendType {
    return this.info.type;
  }

  get generation(): number {
    return this.info.generation;
  }

  /** @deprecated 迁移兼容；新代码使用 browserId。 */
  get id(): string {
    return this.browserId;
  }

  /** @deprecated 迁移兼容；新代码使用 descriptor.type。 */
  get backend(): BrowserBackendType {
    return this.type;
  }

  get default(): Tab {
    return this.defaultTab;
  }

  async documentation(): Promise<string> {
    return this.readDocumentation(undefined, this.info);
  }

  async nameSession(name: string): Promise<void> {
    if (!name.trim()) throw new Error("browser.nameSession requires a non-empty name");
    const command: BrowserCommand = { method: "nameSession", name };
    expectOk(command, await this.execute(command));
  }

  /** registry refresh 后保留对象 identity，同时更新 capability/metadata。 */
  updateInfo(info: BrowserInfo): void {
    this.info = info;
    this.policy.updateDescriptor(info);
  }

  executeCommand(command: BrowserCommand): Promise<BrowserCommandResult> {
    return this.execute(command);
  }

  createTab(tabId: string): Tab {
    return createBrowserApiProxy(
      new Tab(this.execute, tabId, undefined, this.info.capabilities.tab ?? [], (name) =>
        this.readDocumentation(name, this.info),
      ),
      "Tab",
      this.policy,
    );
  }

  asRuntimeObject(): Browser {
    return this.runtimeObject;
  }
}

export class BrowsersFacade {
  private readonly assertAvailable: BrowserAvailabilityGuard;
  private readonly transport: BrowserClientTransport;
  private readonly readDocumentation: (name?: string, descriptor?: BrowserInfo) => string;
  private readonly manifest: BrowserApiManifest;
  private readonly browsers = new Map<string, { raw: Browser; runtime: Browser }>();
  private readonly runtimeObject: BrowsersFacade;

  constructor(
    transport: BrowserClientTransport,
    options: {
      documentationRoot?: string;
      assertAvailable?: BrowserAvailabilityGuard;
    } = {},
  ) {
    const assertAvailable = options.assertAvailable ?? (() => undefined);
    this.assertAvailable = assertAvailable;
    // Browser 对象是持久引用，内核 reset 后旧绑定必须失效。guard 必须包住持久对象的每次
    // transport/doc 调用，不能只在初始化时判断。
    this.transport = {
      list: async () => {
        assertAvailable();
        return await transport.list();
      },
      execute: async (browserId, browserGeneration, command) => {
        assertAvailable();
        return await transport.execute(browserId, browserGeneration, command);
      },
    };
    this.manifest = loadBrowserApiManifest(options.documentationRoot);
    this.readDocumentation = (name, descriptor) => {
      assertAvailable();
      return loadBrowserDocumentation(options.documentationRoot, name, descriptor);
    };
    const topLevelPolicy = new BrowserApiPolicy(this.manifest, {
      id: "browser-client",
      generation: 0,
      type: "iab",
      name: "Browser client",
      capabilities: {},
    });
    this.runtimeObject = createBrowserApiProxy(this, "Browsers", topLevelPolicy, {
      hideUnknown: true,
    });
  }

  asRuntimeObject(): BrowsersFacade {
    return this.runtimeObject;
  }

  private async listAvailable(): Promise<BrowserInfo[]> {
    return await this.transport.list();
  }

  async list(): Promise<BrowserDescriptor[]> {
    return (await this.listAvailable()).map(
      ({ generation: _generation, ...descriptor }) => descriptor,
    );
  }

  async get(idOrType: string): Promise<Browser> {
    const infos = await this.listAvailable();
    const info =
      infos.find((candidate) => candidate.id === idOrType) ??
      infos.find((candidate) => candidate.type === idOrType);
    if (!info) {
      const available = infos.map((candidate) => `${candidate.type}:${candidate.id}`).join(", ");
      throw new BrowserCommandError(
        { method: "list" },
        {
          ok: false,
          elapsedMs: 0,
          error: {
            code: "backend_unavailable",
            message: `Browser backend '${idOrType}' is unavailable${available ? `; available: ${available}` : ""}`,
          },
        },
        "backend_unavailable",
      );
    }
    return this.browserFor(info);
  }

  async getDefault(): Promise<Browser> {
    const info = selectDefaultBrowser(await this.listAvailable());
    if (!info) {
      return this.get("__no_browser_backend__");
    }
    return this.browserFor(info);
  }

  async getForUrl(url: string): Promise<Browser> {
    const infos = await this.listAvailable();
    if (infos.length === 0) {
      return this.get("__no_browser_backend__");
    }
    if (infos.length === 1) {
      return this.browserFor(infos[0]);
    }

    const tabsByBrowserId = new Map<string, readonly string[]>();
    await Promise.all(
      infos.map(async (info) => {
        try {
          const tabs = await this.browserFor(info).tabs.list();
          tabsByBrowserId.set(
            info.id,
            tabs.flatMap((tab) => (tab.url ? [tab.url] : [])),
          );
        } catch {
          tabsByBrowserId.set(info.id, []);
        }
      }),
    );
    return this.browserFor(selectBrowserForUrl(infos, url, tabsByBrowserId));
  }

  async open(url?: string, options: { reuseTab?: boolean } = {}): Promise<Tab> {
    const browser = await this.getDefault();
    if (url && options.reuseTab !== false) {
      // 已知问题：模型每次 open() 都新开 tab，任务结束后内置浏览器堆满标签页。
      // 默认按 URL 复用已有 agent-owned tab（tabs.list 只含本 scope 的 owned tabs，
      // 不会误接管用户 tab）：激活给用户并在原地 goto 刷新；复用链路任何失败都
      // 降级 newTab。需要并排独立 tab 时模型可显式传 reuseTab: false。
      const reusable = await browser.tabs.reuse(url).catch(() => undefined);
      if (reusable) {
        await reusable.goto(url);
        return reusable;
      }
    }
    const tab = await browser.tabs.new();
    if (url) {
      await tab.goto(url);
    }
    return tab;
  }

  async current(): Promise<Tab> {
    const browser = await this.getDefault();
    return (await browser.tabs.selected()) ?? browser.tabs.new();
  }

  async listTabs(): Promise<Tab[]> {
    const browser = await this.getDefault();
    // 兼容 listTabs 只枚举 binding，不能逐个调用 tabs.get()；get 现在有显式激活语义，
    // 批量 get 会依次抢占 active tab，且并发执行时最终选中项不确定。
    return (await browser.tabs.list()).map((tab) => browser.createTab(tab.id));
  }

  tab(tabId: string): Tab {
    // 兼容入口仍需冻结创建时选中的 browser；不能在每条命令时重跑 default，
    // 否则 backend 上下线后同一个 tabId 可能被错误发送到另一连接。
    const browser = this.getDefault();
    return new Tab(async (command) => (await browser).executeCommand(command), tabId);
  }

  documentation(name?: string): string {
    return this.readDocumentation(name);
  }

  private browserFor(info: BrowserInfo): Browser {
    const existing = this.browsers.get(info.id);
    if (existing && existing.raw.generation === info.generation) {
      existing.raw.updateInfo(info);
      return existing.runtime;
    }
    const raw = new Browser(
      info,
      this.transport.execute,
      this.readDocumentation,
      this.manifest,
      this.assertAvailable,
    );
    const runtime = raw.asRuntimeObject();
    this.browsers.set(info.id, { raw, runtime });
    return runtime;
  }
}
