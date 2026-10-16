import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { NodeReplRequestMeta, NodeReplSession } from "@zcode/core";
import { setupBrowserRuntime } from "../src/browser-client.js";
import { createBrowserBridgeGlobals, type ActiveNodeReplCall } from "@zcode/node-repl-host/browser-bridge";
import { readNodeReplBrowserRuntimeBridge } from "@zcode/node-repl-host/runtime-bridge";

describe("subagent browser boundary", () => {
  it("keeps browser bridge access and initialization available in subagent scope", async () => {
    let requestMeta: NodeReplRequestMeta = {
      runtime_scope: "main",
      session_id: "main-session",
    };
    const activeCall = (): ActiveNodeReplCall => ({
      generation: 1,
      requestMeta,
      signal: new AbortController().signal,
    });
    const globals = createBrowserBridgeGlobals({
      documentationRoot: resolve(process.cwd(), "docs"),
      generation: 1,
      getActiveCall: activeCall,
      // 本用例只走本地 documentation guard，不会执行需要 response meta 的 transport。
      session: () => undefined as unknown as NodeReplSession,
    });

    await setupBrowserRuntime({ globals });
    const documentation = (
      globals.agent as { documentation: { get(name: string): Promise<string> } }
    ).documentation;
    await expect(documentation.get("overview")).resolves.toContain("Browser");
    const bridge = readNodeReplBrowserRuntimeBridge(globals);

    requestMeta = { runtime_scope: "subagent", session_id: "subagent-session" };
    expect(() => bridge.assertAvailable()).not.toThrow();
    await expect(setupBrowserRuntime({ globals })).resolves.toBeUndefined();
    await expect(documentation.get("overview")).resolves.toContain("Browser");
  });
});
