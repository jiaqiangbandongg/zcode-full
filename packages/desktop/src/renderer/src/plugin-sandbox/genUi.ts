import { App, PostMessageTransport } from "@modelcontextprotocol/ext-apps";
import { z } from "zod";
import {
  GEN_UI_GLOBALS_EVENT,
  GEN_UI_STATE_CONTEXT_KEY,
  GEN_UI_TWEAK_CONTEXT_KEY,
  GEN_UI_STATE_METHOD,
  GEN_UI_FOLLOW_UP_METHOD,
  GEN_UI_TWEAK_METHOD,
  GEN_UI_PRESENTATION_METHOD,
  genUiWidgetStateSchema,
  genUiFollowUpSchema,
  type GenUiWidgetState,
  genUiTweakMessageSchema,
  genUiTweakResultSchema,
  genUiTweakAnnotationSchema,
} from "@zcode/shared/gen-ui";
import { installGenUiTweakRuntime } from "./genUiTweakRuntime.js";

const initial = JSON.parse(
  document.getElementById("zcode-gen-ui-initial-state")?.textContent ?? "null",
) as unknown;
let state: GenUiWidgetState | null =
  initial === null ? null : genUiWidgetStateSchema.parse(initial);
const app = new App({ name: "zcode-gen-ui", version: "1" }, {}, { autoResize: false });

function observeContentSize() {
  const body = document.body;
  const range = document.createRange();
  let previous: { height: number; width: number; viewport: number } | undefined;
  let frame: number | undefined;
  let roots = new Set<Element>();
  const report = () => {
    frame = undefined;
    const style = getComputedStyle(body);
    const top = parseFloat(style.paddingTop) || 0;
    const bottom = parseFloat(style.paddingBottom) || 0;
    const contentTop = body.getBoundingClientRect().top + top;
    const children = [...roots];
    let extent = 0;
    // 旧 SDK 临时改写 html 高度来测量，测量自身会触发溢出布局；这里仅读取实际内容。
    if (children.length === 0) {
      range.selectNodeContents(body);
      extent = range.getBoundingClientRect().height;
    } else if (children.length === 1) {
      const child = children[0]!;
      const rect = child.getBoundingClientRect();
      extent = Math.max(child.scrollHeight, rect.height) + Math.max(0, rect.top - contentTop);
    } else {
      for (const child of children)
        extent = Math.max(extent, child.getBoundingClientRect().bottom - contentTop);
    }
    const next = { height: extent + top + bottom, width: innerWidth, viewport: innerHeight };
    const last = previous;
    previous = next;
    // vh / 百分比高度会跟随宿主视口等量增长；不把宿主调整再反馈成新的内容增高。
    if (
      last &&
      next.width === last.width &&
      next.height - last.height === next.viewport - last.viewport
    )
      return;
    void app
      .sendSizeChanged({ width: next.width, height: Math.ceil(next.height) })
      .catch((error) =>
        window.dispatchEvent(new CustomEvent("zcode:error", { detail: String(error) })),
      );
  };
  const schedule = () => {
    frame ??= requestAnimationFrame(report);
  };
  const sizes = new ResizeObserver(schedule);
  const refreshRoots = () => {
    const next = new Set(
      [...body.children].filter(
        (child) =>
          child.tagName !== "SCRIPT" &&
          child.tagName !== "STYLE" &&
          child.getAttribute("role") !== "tooltip",
      ),
    );
    for (const child of roots) if (!next.has(child)) sizes.unobserve(child);
    for (const child of next) if (!roots.has(child)) sizes.observe(child);
    roots = next;
    schedule();
  };
  sizes.observe(body);
  refreshRoots();
  const children = new MutationObserver(refreshRoots);
  children.observe(body, { childList: true });
  window.addEventListener("resize", schedule);
  window.addEventListener(
    "pagehide",
    () => {
      sizes.disconnect();
      children.disconnect();
      window.removeEventListener("resize", schedule);
      if (frame !== undefined) cancelAnimationFrame(frame);
    },
    { once: true },
  );
}
installGenUiTweakRuntime(async (_name, message) => {
  await ready;
  return app.request(
    { method: GEN_UI_TWEAK_METHOD, params: genUiTweakMessageSchema.parse(message) },
    genUiTweakResultSchema,
  );
});
const update = (context: Record<string, unknown>) => {
  if (Object.hasOwn(context, GEN_UI_STATE_CONTEXT_KEY)) {
    const next = context[GEN_UI_STATE_CONTEXT_KEY];
    state = next === null ? null : genUiWidgetStateSchema.parse(next);
  }
  if (context.theme === "dark" || context.theme === "light") {
    document.documentElement.dataset.theme = context.theme;
    document.documentElement.style.colorScheme = context.theme;
  }
  const variables = (context.styles as { variables?: Record<string, string> } | undefined)
    ?.variables;
  for (const [name, value] of Object.entries(variables ?? {}))
    if (name.startsWith("--")) document.documentElement.style.setProperty(name, value);
  window.dispatchEvent(
    new CustomEvent(GEN_UI_GLOBALS_EVENT, {
      detail: {
        globals: {
          widgetState: structuredClone(state),
          theme: document.documentElement.dataset.theme,
          visualizationAnnotation:
            context[GEN_UI_TWEAK_CONTEXT_KEY] === undefined
              ? null
              : genUiTweakAnnotationSchema.parse(context[GEN_UI_TWEAK_CONTEXT_KEY]),
        },
      },
    }),
  );
};
app.onhostcontextchanged = update;
const ready = app.connect(new PostMessageTransport(window.parent, window.parent)).then(() => {
  update(app.getHostContext() ?? {});
  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", observeContentSize, { once: true });
  else observeContentSize();
});
void ready.catch((error) =>
  window.dispatchEvent(new CustomEvent("zcode:error", { detail: String(error) })),
);
let saves = Promise.resolve();
const api = Object.freeze({
  get widgetState() {
    return structuredClone(state);
  },
  setWidgetState(value: unknown) {
    const next = genUiWidgetStateSchema.parse(value);
    const pending = saves
      .catch(() => undefined)
      .then(async () => {
        await ready;
        await app.request({ method: GEN_UI_STATE_METHOD, params: { state: next } }, z.object({}));
        // Service 通知是唯一状态投影；迟到的保存 ACK 不能覆盖另一窗口更新的快照。
      });
    saves = pending;
    return pending;
  },
  async sendFollowUpMessage(value: unknown) {
    const params = genUiFollowUpSchema.parse(value);
    await saves;
    await ready;
    await app.request({ method: GEN_UI_FOLLOW_UP_METHOD, params }, z.object({}));
  },
  async openExternal(value: unknown) {
    const { href } = z.object({ href: z.string() }).strict().parse(value);
    await ready;
    const result = await app.openLink({ url: href });
    if (result.isError) throw new Error("External link was denied");
  },
});
Object.defineProperty(window, "zcode", { value: api, writable: false, configurable: false });
const openAnchor = (event: MouseEvent) => {
  if (event.defaultPrevented || (event.button !== 0 && event.button !== 1)) return;
  const anchor = event.composedPath().find((node) => node instanceof HTMLAnchorElement);
  if (!(anchor instanceof HTMLAnchorElement)) return;
  const href = anchor.getAttribute("href")?.trim();
  if (!href || href.startsWith("#")) return;
  // 原生导航会被沙箱阻止；外链经宿主打开，下载和合成点击不借用剩余手势。
  event.preventDefault();
  if (!event.isTrusted || anchor.hasAttribute("download")) return;
  void api
    .openExternal({ href })
    .catch((error) =>
      window.dispatchEvent(new CustomEvent("zcode:error", { detail: String(error) })),
    );
};
window.addEventListener("click", openAnchor);
window.addEventListener("auxclick", openAnchor);
// guest 的 hover/键盘事件不会冒泡到宿主 DOM；只传展示事件，不增加 Agent 能力。
const presentation = (params: { hovered?: boolean; escape?: true }) => {
  void ready
    .then(() => app.request({ method: GEN_UI_PRESENTATION_METHOD, params }, z.object({})))
    .catch(() => {});
};
document.documentElement.addEventListener("pointerenter", () => presentation({ hovered: true }));
document.documentElement.addEventListener("pointerleave", () => presentation({ hovered: false }));
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !event.defaultPrevented) presentation({ escape: true });
});
