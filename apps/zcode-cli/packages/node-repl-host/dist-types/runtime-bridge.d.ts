import type { BrowserClientTransport } from "@zcode/core/browser-client";
export declare const NODE_REPL_BROWSER_BRIDGE_SYMBOL: unique symbol;
export interface NodeReplBrowserRuntimeBridge extends BrowserClientTransport {
    documentationRoot: string;
    assertAvailable(): void;
}
export declare function readNodeReplBrowserRuntimeBridge(globals: Record<PropertyKey, unknown>): NodeReplBrowserRuntimeBridge;
//# sourceMappingURL=runtime-bridge.d.ts.map