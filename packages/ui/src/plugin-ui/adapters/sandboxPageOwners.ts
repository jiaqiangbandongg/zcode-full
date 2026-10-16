import { PluginUiPageManager, type ManagedPluginPage } from "../app/pluginUiPageManager.js";

export interface SandboxPageOwner extends ManagedPluginPage {
  readonly kind: "mcp" | "gen-ui";
}
const listeners = new Map<string, Set<() => void>>();
export const sandboxPages = new PluginUiPageManager<SandboxPageOwner>(
  (run, ms) => {
    const timer = setTimeout(run, ms);
    return () => clearTimeout(timer);
  },
  () => {},
  (key) => {
    for (const listener of listeners.get(key) ?? []) listener();
  },
);
export function onSandboxPageRemoved(key: string, listener: () => void): () => void {
  const set = listeners.get(key) ?? new Set();
  listeners.set(key, set);
  set.add(listener);
  return () => {
    set.delete(listener);
    if (!set.size) listeners.delete(key);
  };
}
if (typeof window !== "undefined")
  window.addEventListener("beforeunload", () => sandboxPages.clear());
