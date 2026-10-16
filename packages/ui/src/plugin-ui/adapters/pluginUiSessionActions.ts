import {
  buildPluginUiSessionKey,
  type PluginUiSessionScope,
  type PluginUiSessionActions,
} from "@/plugin-ui/contract.js";

const actionsBySession = new Map<string, PluginUiSessionActions>();

export function registerPluginUiSessionActions(
  target: PluginUiSessionScope,
  actions: PluginUiSessionActions,
): () => void {
  actionsBySession.set(buildPluginUiSessionKey(target), actions);
  return () => {
    if (actionsBySession.get(buildPluginUiSessionKey(target)) === actions)
      actionsBySession.delete(buildPluginUiSessionKey(target));
  };
}

export function getPluginUiSessionActions(
  target: PluginUiSessionScope,
): PluginUiSessionActions | null {
  return actionsBySession.get(buildPluginUiSessionKey(target)) ?? null;
}
