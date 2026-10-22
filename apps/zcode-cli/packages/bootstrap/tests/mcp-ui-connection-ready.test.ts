import { describe, expect, it, vi } from "vitest";
import { mcpUiInstances } from "../src/zcode-protocol/mcp-ui/instances.js";
import { openMcpUiInstance } from "../src/zcode-protocol/mcp-ui/protocol.js";
const binding = {
  workspace: "w",
  sessionId: "s",
  pluginId: "p",
  serverName: "m",
  scopeId: "v",
  resourceUri: "ui://app",
  ownerWebContentsId: 1,
};
describe("MCP App connection readiness", () => {
  it.each(["ready", "session-closed", "session-replaced", "connection-replaced", "failed"])(
    "waits for startup and validates ownership before opening: %s",
    async (outcome) => {
      const source = { identity: "source", generation: 1 };
      let current: typeof source | null = null;
      const gate = Promise.withResolvers<typeof source | null>();
      const record = {
        app: {
          getMcpAppConnectionSnapshot: () => current,
          waitForMcpAppConnection: () => gate.promise,
          onMcpAppConnectionInvalidated: () => () => {},
          unsubscribeMcpResourcesForUi: async () => {},
        },
      };
      const sessions = new Map([[binding.sessionId, record]]);
      const context = { sessions } as unknown as Parameters<typeof openMcpUiInstance>[0];
      const params = {
        ...binding,
        workspace: { workspacePath: binding.workspace, workspaceKey: binding.workspace },
      };
      const settled = vi.fn();
      const opening = openMcpUiInstance(context, params);
      void opening.then(settled, settled);
      await Promise.resolve();
      expect(settled).not.toHaveBeenCalled();
      current = source;
      if (outcome === "session-closed") sessions.clear();
      if (outcome === "session-replaced") sessions.set(binding.sessionId, { ...record });
      if (outcome === "connection-replaced") current = { ...source, generation: 2 };
      if (outcome === "failed") current = null;
      gate.resolve(outcome === "failed" ? null : source);
      if (outcome === "ready") {
        const lease = await opening;
        expect(mcpUiInstances.validate(lease, params, source).lease).toEqual(lease);
        mcpUiInstances.close(lease);
      } else {
        await expect(opening).rejects.toThrow();
      }
    },
  );
});
