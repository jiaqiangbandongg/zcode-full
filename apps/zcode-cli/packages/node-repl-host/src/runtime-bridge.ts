import type { BrowserClientTransport } from "@zcode/core/browser-client";

export const NODE_REPL_BROWSER_BRIDGE_SYMBOL = Symbol.for("zcode.node-repl.browser-control-bridge");

export interface NodeReplBrowserRuntimeBridge extends BrowserClientTransport {
  documentationRoot: string;
  assertAvailable(): void;
}

export function readNodeReplBrowserRuntimeBridge(
  globals: Record<PropertyKey, unknown>,
): NodeReplBrowserRuntimeBridge {
  const bridge = globals[NODE_REPL_BROWSER_BRIDGE_SYMBOL];
  if (!bridge || typeof bridge !== "object") {
    throw new Error(
      "Browser runtime bridge is unavailable. Use Browser from a ZCode desktop or shared-host session.",
    );
  }
  return bridge as NodeReplBrowserRuntimeBridge;
}
