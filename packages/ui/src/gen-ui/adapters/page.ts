import {
  AppBridge,
  type McpUiStyles,
  type McpUiHostContext,
} from "@modelcontextprotocol/ext-apps/app-bridge";
import { z } from "zod";
import type { IGenUiService } from "@zcode/services";
import type { PluginSandboxPlatformPort, PluginSandboxHandle } from "@zcode/shared/mcp-apps";
import {
  GEN_UI_STATE_METHOD,
  GEN_UI_FOLLOW_UP_METHOD,
  GEN_UI_TWEAK_METHOD,
  GEN_UI_PRESENTATION_METHOD,
  GEN_UI_STATE_CONTEXT_KEY,
  GEN_UI_TWEAK_CONTEXT_KEY,
  buildGenUiStateKey,
  genUiWidgetStateSchema,
  genUiFollowUpSchema,
  genUiTweakMessageSchema,
  genUiTweakResultSchema,
  type GenUiTweakValues,
} from "@zcode/shared/gen-ui";
import {
  createPluginUiPagePlane,
  createPluginUiMessagePortTransport,
  getPluginUiSessionActions,
} from "@/plugin-ui/hostPrimitives.js";
import type { GenUiCardTarget, GenUiPage, GenUiPageSnapshot } from "../contract.js";
import { EMPTY_GEN_UI_SNAPSHOT } from "../contract.js";
import { readGenUiStyleVariables } from "./theme.js";
import { createGenUiTweakRegistry } from "../app/tweaks.js";

export interface GenUiPageInput {
  target: GenUiCardTarget;
  files: IGenUiService;
  state: IGenUiService;
  platform: PluginSandboxPlatformPort;
  openExternal(url: string): void | Promise<void>;
  confirm(prompt: string): Promise<string | null>;
  onVisibility?(visible: boolean): void;
  onSettled?(): void;
}
export function createGenUiPage(input: GenUiPageInput): GenUiPage {
  const tweaks = createGenUiTweakRegistry();
  const { target, platform } = input;
  let stateTarget = {
    workspacePath: target.workspacePath,
    workspaceIdentity: target.workspaceIdentity,
    sessionId: target.sessionId,
    path: target.path,
  };
  const listeners = new Set<() => void>();
  let snapshot: GenUiPageSnapshot = { ...EMPTY_GEN_UI_SNAPSHOT };
  let disposed = false,
    visible = false,
    sending = false;
  let handle: PluginSandboxHandle | null = null;
  let bridge: AppBridge | null = null;
  let stopState: { dispose(): void } | null = null;
  let handshake: ReturnType<typeof setTimeout> | undefined;
  let saves: Promise<void> = Promise.resolve();
  let operations = 0;
  let preparing = true;
  const update = (next: Partial<GenUiPageSnapshot>) => {
    if (!disposed) {
      snapshot = { ...snapshot, ...next };
      for (const listener of listeners) listener();
    }
  };
  const fail = (error: unknown) =>
    update({ phase: "error", error: error instanceof Error ? error.message : String(error) });
  const plane = createPluginUiPagePlane({
    onVisibility: (value) => {
      visible = value;
      input.onVisibility?.(value);
    },
    onCrash: () => fail(new Error("Gen UI page stopped")),
  });
  const context: McpUiHostContext = {
    displayMode: "inline",
    theme: document.documentElement.classList.contains("dark") ? "dark" : "light",
    styles: { variables: readGenUiStyleVariables() as McpUiStyles },
  };
  const pushContext = () => {
    bridge?.setHostContext({ ...context });
  };
  const assertCurrent = () => {
    if (disposed || !visible || !handle || snapshot.phase !== "ready")
      throw new Error("Gen UI is no longer active");
  };
  const followUp = async (prompt: string, title?: string, hostGesture = false) => {
    assertCurrent();
    if (sending) throw new Error("A follow-up is already pending");
    const actions = getPluginUiSessionActions(target);
    if (!actions) throw new Error("This session is read-only or disconnected");
    sending = true;
    try {
      if (!hostGesture && !(await platform.consumeUserGesture(handle!.sandboxId))) {
        const confirmed = await input.confirm(prompt);
        if (!confirmed?.trim()) throw new Error("Follow-up cancelled");
        prompt = confirmed.trim();
      }
      await saves;
      assertCurrent();
      if (getPluginUiSessionActions(target) !== actions) throw new Error("Session binding changed");
      await actions.sendFollowUp({
        prompt,
        source: { kind: "genUi", path: stateTarget.path, title },
      });
    } finally {
      sending = false;
      input.onSettled?.();
    }
  };
  const offPorts = platform.onPorts((event) => {
    if (disposed || event.sandboxId !== handle?.sandboxId || event.initId !== handle.initId) return;
    void bridge?.close();
    // SDK 持有上一份上下文用于差异比较，不能与可写投影共享同一对象。
    const active = new AppBridge(
      null,
      { name: "zcode-gen-ui", version: "1" },
      { openLinks: {}, experimental: { "zcode/gen-ui": {} } },
      { hostContext: { ...context } },
    );
    bridge = active;
    active.onerror = fail;
    active.oninitialized = () => {
      clearTimeout(handshake);
      update({ phase: "ready" });
      pushContext();
    };
    active.onsizechange = ({ height }) => {
      // 预览使用独立视口；保持正文占位高度，避免遮罩下的时间线跳动。
      if (
        context.displayMode !== "fullscreen" &&
        typeof height === "number" &&
        Number.isFinite(height)
      )
        update({ height: Math.max(0, Math.min(10000, Math.ceil(height))) });
    };
    const current = () => {
      if (disposed || bridge !== active) throw new Error("Gen UI instance was closed");
    };
    active.onopenlink = async ({ url }) => {
      current();
      assertCurrent();
      const link = new URL(url);
      if (link.protocol !== "https:" && link.protocol !== "http:")
        throw new Error("External links require an absolute HTTP(S) URL");
      if (!(await platform.consumeUserGesture(handle!.sandboxId)))
        throw new Error("External links require a user gesture");
      // 手势校验跨进程返回时，卡片可能已隐藏或重建，不能执行旧页面的打开请求。
      current();
      assertCurrent();
      await input.openExternal(link.href);
      return {};
    };
    active.setRequestHandler(
      GEN_UI_STATE_METHOD,
      { params: z.object({ state: genUiWidgetStateSchema }).strict(), result: z.object({}) },
      async ({ state }) => {
        current();
        operations++;
        const save = saves
          .catch(() => undefined)
          .then(async () => {
            current();
            await input.state.setState({ target: stateTarget, state });
          });
        saves = save;
        try {
          await save;
        } finally {
          operations--;
          input.onSettled?.();
        }
        return {};
      },
    );
    active.setRequestHandler(
      GEN_UI_FOLLOW_UP_METHOD,
      { params: genUiFollowUpSchema, result: z.object({}) },
      async ({ prompt, title }) => {
        current();
        await followUp(prompt, title);
        return {};
      },
    );
    active.setRequestHandler(
      GEN_UI_TWEAK_METHOD,
      {
        params: genUiTweakMessageSchema,
        result: genUiTweakResultSchema,
      },
      async (message) => {
        current();
        const result = tweaks.handle(message);
        const groups = tweaks.groups();
        const values = Object.fromEntries(
          groups.flatMap((group) =>
            group.controls.map((control) => [
              control.id,
              snapshot.tweakValues[control.id] ?? control.value,
            ]),
          ),
        );
        update({ tweak: groups[0] ?? null, groups, tweakValues: values });
        projectTweaks();
        return result;
      },
    );
    active.setRequestHandler(
      GEN_UI_PRESENTATION_METHOD,
      {
        params: z
          .object({ hovered: z.boolean().optional(), escape: z.literal(true).optional() })
          .strict(),
        result: z.object({}),
      },
      async ({ hovered, escape }) => {
        current();
        update({
          ...(hovered !== undefined ? { hovered } : {}),
          ...(escape ? { escapeSequence: snapshot.escapeSequence + 1 } : {}),
        });
        return {};
      },
    );
    clearTimeout(handshake);
    // 超时只报告握手失败，不参与同步或恢复。
    handshake = setTimeout(() => fail(new Error("Gen UI handshake timed out")), 15_000);
    void active.connect(createPluginUiMessagePortTransport(event.port)).catch(fail);
  });
  const themes = new MutationObserver(() => {
    context.theme = document.documentElement.classList.contains("dark") ? "dark" : "light";
    context.styles = { variables: readGenUiStyleVariables() as McpUiStyles };
    pushContext();
  });
  themes.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class", "style", "data-theme"],
  });
  const preparation = (async () => {
    const document = await input.files.readDocument(stateTarget);
    stateTarget = { ...stateTarget, path: document.path };
    if (disposed) return;
    let stateRevision = 0;
    stopState = input.state.onStateChanged((change) => {
      if (buildGenUiStateKey(change.target) === buildGenUiStateKey(stateTarget)) {
        stateRevision++;
        context[GEN_UI_STATE_CONTEXT_KEY] = change.state;
        pushContext();
      }
    });
    const prepared = await input.state.prepareSandbox({
      ...stateTarget,
      html: document.html,
      instanceKey: target.instanceKey,
      ownerWebContentsId: await platform.getOwnerWebContentsId(),
    });
    if (disposed) {
      await platform.disposeSandbox(prepared.sandboxId, prepared.initId);
      return;
    }
    handle = prepared;
    // 登记 HTML 含状态快照；随后读取最新状态，且不以迟到查询覆盖期间已收到的通知。
    const revision = stateRevision;
    const latest = await input.state.getState(stateTarget);
    if (revision === stateRevision) context[GEN_UI_STATE_CONTEXT_KEY] = latest;
    if (disposed) return;
    plane.mount(prepared);
  })()
    .catch(fail)
    .finally(() => {
      preparing = false;
      input.onSettled?.();
    });
  const projectTweaks = () => {
    context[GEN_UI_TWEAK_CONTEXT_KEY] = tweaks.annotation(
      snapshot.previewOriginal ? {} : snapshot.tweakValues,
    );
    pushContext();
  };
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => snapshot,
    bind(node, expanded) {
      context.displayMode = expanded ? "fullscreen" : "inline";
      pushContext();
      return plane.bind({ node, kind: "flow" });
    },
    preview(node) {
      plane.preview(node);
      context.displayMode = node ? "fullscreen" : "inline";
      pushContext();
    },
    focus: () => plane.focus(),
    async copyImage() {
      assertCurrent();
      if (!platform.copyImage)
        throw new Error("Image capture is not supported by this desktop version");
      operations++;
      try {
        await platform.copyImage({
          sandboxId: handle!.sandboxId,
          initId: handle!.initId,
          ...plane.captureBounds(5),
        });
      } finally {
        operations--;
        input.onSettled?.();
      }
    },
    setTweaks(values) {
      update({ tweakValues: { ...snapshot.tweakValues, ...values }, previewOriginal: false });
      projectTweaks();
    },
    previewTweaks(original) {
      update({ previewOriginal: original });
      projectTweaks();
    },
    async submitTweaks(values: GenUiTweakValues) {
      const groups = snapshot.groups.map((group) => ({
        title: group.title,
        controls: group.controls
          .filter((control) => Object.hasOwn(values, control.id))
          .map((control) => ({
            label: control.label,
            reference: control.reference,
            original: control.value,
            value: values[control.id],
            ...(control.type === "slider" ? { unit: control.unit } : {}),
          })),
      }));
      await followUp(
        `Update the Gen UI file ${stateTarget.path} with these design settings:\n${JSON.stringify(groups)}`,
        snapshot.tweak?.title,
        true,
      );
    },
    isBusy: () => preparing || sending || operations > 0,
    async dispose() {
      disposed = true;
      clearTimeout(handshake);
      offPorts();
      stopState?.dispose();
      themes.disconnect();
      plane.prepareUnmount();
      await bridge?.close();
      await preparation;
      listeners.clear();
      try {
        if (handle) await platform.disposeSandbox(handle.sandboxId, handle.initId);
      } finally {
        plane.dispose();
      }
    },
  };
}
