import { buildGenUiScopeKey } from "@zcode/shared/gen-ui";
import { sandboxPages, type SandboxPageOwner } from "@/plugin-ui/hostPrimitives.js";
import { EMPTY_GEN_UI_SNAPSHOT, type GenUiPage, type GenUiPageSnapshot } from "../contract.js";
import { createGenUiPage, type GenUiPageInput } from "./page.js";

export interface RetainedGenUiPage extends GenUiPage, SandboxPageOwner {
  readonly kind: "gen-ui";
  attachConfirmation(confirm: GenUiPageInput["confirm"]): () => void;
  retry(): void;
}
const creating = new Map<string, Promise<RetainedGenUiPage>>();
export function acquireGenUiPage(
  input: Omit<GenUiPageInput, "confirm"> & {
    watchTaskRemoved(run: () => void): () => void;
  },
): Promise<RetainedGenUiPage> {
  const task = buildGenUiScopeKey(input.target);
  const key = `gen-ui:${JSON.stringify([task, input.target.path, input.target.instanceKey])}`;
  const existing = sandboxPages.get(key);
  if (existing?.kind === "gen-ui") return Promise.resolve(existing as RetainedGenUiPage);
  const pending = creating.get(key);
  if (pending) return pending;
  const owner = createOwner(key, task, input);
  const admission = sandboxPages
    .add(owner)
    .then(
      () => owner,
      (error) => {
        owner.destroy();
        throw error;
      },
    )
    .finally(() => creating.delete(key));
  creating.set(key, admission);
  return admission;
}
function createOwner(
  key: string,
  task: string,
  input: Omit<GenUiPageInput, "confirm"> & { watchTaskRemoved(run: () => void): () => void },
): RetainedGenUiPage {
  const anchors = new Map<symbol, { node: HTMLElement; visible: boolean; off?: () => void }>();
  const confirmations = new Map<symbol, GenUiPageInput["confirm"]>();
  const listeners = new Set<() => void>();
  let core: GenUiPage | null = null;
  let snapshot: GenUiPageSnapshot = { ...EMPTY_GEN_UI_SNAPSHOT };
  let disposed = false,
    starting = false,
    epoch = 0;
  let releasing: Promise<unknown> = Promise.resolve();
  let offCore: (() => void) | undefined;
  const notify = () => {
    for (const listener of listeners) listener();
  };
  const fail = (error: unknown) => {
    snapshot = { ...snapshot, phase: "error", error: String(error) };
    notify();
  };
  // 回收的是 guest；锚点观察属于窗口 owner，离屏回收后重新滚入视口仍能唤醒。
  const intersection = new IntersectionObserver((entries) => {
    for (const entry of entries)
      for (const anchor of anchors.values())
        if (anchor.node === entry.target) anchor.visible = entry.isIntersecting;
    if (!core && !disposed) {
      const visible = [...anchors.values()].some(
        (anchor) => anchor.visible && anchor.node.isConnected,
      );
      sandboxPages.visibility(owner, visible);
      if (visible) void ensure();
    }
  });
  async function ensure() {
    if (disposed || starting || core || snapshot.phase === "error") return;
    starting = true;
    const generation = ++epoch;
    try {
      await releasing;
      if (disposed || generation !== epoch) return;
      await sandboxPages.reserve(owner);
      if (disposed || generation !== epoch || !anchors.size) {
        sandboxPages.released(owner);
        return;
      }
      core = createGenUiPage({
        ...input,
        confirm: (prompt) => [...confirmations.values()].at(-1)?.(prompt) ?? Promise.resolve(null),
        onVisibility: (visible) => {
          if (owner.visible !== visible) sandboxPages.visibility(owner, visible);
        },
        onSettled: () => sandboxPages.settled(owner),
      });
      const active = core;
      offCore = core.subscribe(() => {
        snapshot = active.getSnapshot();
        notify();
      });
      for (const anchor of anchors.values()) anchor.off = core.bind(anchor.node);
      snapshot = core.getSnapshot();
      notify();
    } catch (error) {
      if (!disposed && generation === epoch) fail(error);
    } finally {
      if (generation === epoch) starting = false;
    }
  }
  const stopTask = input.watchTaskRemoved(() => sandboxPages.removeTask(task));
  async function suspend(force = false) {
    if (!force && (starting || core?.isBusy())) return false;
    epoch++;
    starting = false;
    const previous = core;
    core = null;
    offCore?.();
    offCore = undefined;
    for (const anchor of anchors.values()) {
      anchor.off?.();
      anchor.off = undefined;
    }
    snapshot = { ...EMPTY_GEN_UI_SNAPSHOT, height: snapshot.height };
    notify();
    releasing = Promise.all([releasing, previous?.dispose()]).finally(() =>
      sandboxPages.released(owner),
    );
    await releasing;
    if (!force && owner.visible && !disposed) void ensure();
    return true;
  }
  const owner: RetainedGenUiPage = {
    kind: "gen-ui",
    key,
    task,
    visible: false,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => snapshot,
    attachConfirmation(confirm) {
      const id = Symbol();
      confirmations.set(id, confirm);
      return () => {
        confirmations.delete(id);
      };
    },
    bind(node) {
      const id = Symbol(),
        anchor = { node, visible: true, off: core?.bind(node) };
      anchors.set(id, anchor);
      intersection.observe(node);
      sandboxPages.visibility(owner, true);
      void ensure();
      return () => {
        // layout cleanup 在 React 移除祖先前把活页面停放；passive cleanup 会先断开 guest。
        anchor.off?.();
        anchors.delete(id);
        if (![...anchors.values()].some((item) => item.node === node)) intersection.unobserve(node);
        if (!anchors.size) sandboxPages.visibility(owner, false);
      };
    },
    preview: (node) => core?.preview(node),
    focus: () => core?.focus(),
    copyImage: () => (core ? core.copyImage() : Promise.reject(new Error("Gen UI is not ready"))),
    setTweaks: (values) => core?.setTweaks(values),
    previewTweaks: (original) => core?.previewTweaks(original),
    submitTweaks: (values) =>
      core ? core.submitTweaks(values) : Promise.reject(new Error("Gen UI is not ready")),
    isBusy: () => starting || (core?.isBusy() ?? false),
    busy: () => owner.isBusy(),
    running: () => starting || core !== null,
    suspend,
    retry() {
      void suspend(true).then(() => {
        if (!disposed) {
          snapshot = { ...snapshot, phase: "loading", error: undefined };
          void ensure();
        }
      });
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      stopTask();
      intersection.disconnect();
      confirmations.clear();
      await suspend(true);
      anchors.clear();
      listeners.clear();
    },
    destroy() {
      void owner.dispose();
    },
  };
  return owner;
}
