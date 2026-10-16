import { sandboxPages, onSandboxPageRemoved } from "./sandboxPageOwners.js";
import type { Page } from "./pluginUiHostTypes.js";
export const pluginUiPages = {
  get(key: string): Page | undefined {
    const page = sandboxPages.get(key);
    return page?.kind === "mcp" ? (page as Page) : undefined;
  },
  add: (page: Page) => sandboxPages.add(page),
  reserve: (page: Page) => sandboxPages.reserve(page),
  released: (page: Page) => sandboxPages.released(page),
  visibility: (page: Page, visible: boolean) => sandboxPages.visibility(page, visible),
  settled: (page: Page) => sandboxPages.settled(page),
  removeTask: (task: string) => sandboxPages.removeTask(task),
  clear: () => sandboxPages.clear(),
};

const pageSubscribers = new Map<string, Set<() => void>>();
export function subscribePage(key: string, listener: () => void): () => void {
  const set = pageSubscribers.get(key) ?? new Set();
  set.add(listener);
  pageSubscribers.set(key, set);
  let off: (() => void) | undefined;
  const connect = () => {
    off?.();
    off = pluginUiPages.get(key)?.subscribe(listener);
    listener();
  };
  set.delete(listener);
  set.add(connect);
  const offRemoved = onSandboxPageRemoved(key, connect);
  connect();
  return () => {
    off?.();
    offRemoved();
    set.delete(connect);
    if (!set.size) pageSubscribers.delete(key);
  };
}
export function bindPluginUiPage(key: string, node: HTMLElement, sidebar: boolean): () => void {
  let off: (() => void) | undefined;
  let bound: Page | undefined;
  const connect = () => {
    const page = pluginUiPages.get(key);
    if (page === bound) return;
    off?.();
    bound = page;
    off = page?.bind(node, sidebar);
  };
  const unsubscribe = subscribePage(key, connect);
  return () => {
    unsubscribe();
    off?.();
  };
}

export function notifyPluginUiPageCreated(key: string): void {
  for (const listener of pageSubscribers.get(key) ?? []) listener();
}

const creating = new Map<string, Promise<Page>>();
export function acquirePluginUiPage(key: string, create: () => Page): Promise<Page> {
  const current = pluginUiPages.get(key);
  if (current) return Promise.resolve(current);
  const existing = creating.get(key);
  if (existing) return existing;
  const page = create();
  const pending = pluginUiPages
    .add(page)
    .then(
      () => {
        notifyPluginUiPageCreated(key);
        return page;
      },
      (error) => {
        page.destroy();
        throw error;
      },
    )
    .finally(() => {
      if (creating.get(key) === pending) creating.delete(key);
    });
  creating.set(key, pending);
  return pending;
}
