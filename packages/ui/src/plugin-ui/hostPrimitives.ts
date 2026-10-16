/** Shared sandbox transport/presentation and existing session admission binding. */
export { createPluginUiMessagePortTransport } from "./adapters/messagePortTransport.js";
export { createPluginUiPagePlane } from "./adapters/pluginUiPagePlane.js";
export { readPluginUiStyleVariables } from "./adapters/readPluginUiStyleVariables.js";
export {
  sandboxPages,
  onSandboxPageRemoved,
  type SandboxPageOwner,
} from "./adapters/sandboxPageOwners.js";
export {
  getPluginUiSessionActions,
  registerPluginUiSessionActions,
} from "./adapters/pluginUiSessionActions.js";
