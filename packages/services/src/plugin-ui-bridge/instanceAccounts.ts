import type { McpAppInstance } from "@zcode/shared/mcp-apps";
import { createHash } from "node:crypto";
import type { PluginUiPluginScope, PluginUiPrepareSandboxParams } from "./contract.js";

/** Host 的账号上下文来自凭据 owner；不接收页面传入的账号或访问令牌。 */
export function createPluginUiAccountBindings(deps: {
  readAccount(): Promise<unknown>;
  open(params: PluginUiPrepareSandboxParams & { accountContext: string }): Promise<McpAppInstance>;
  close(params: PluginUiPluginScope): Promise<void>;
}) {
  let revision = 0;
  const active = new Map<string, PluginUiPluginScope>();
  const close = async (params: PluginUiPluginScope) => {
    active.delete(params.instance.token);
    await deps.close(params);
  };
  return {
    async open(params: PluginUiPrepareSandboxParams) {
      const captured = revision;
      const accountContext = createHash("sha256")
        .update(JSON.stringify(await deps.readAccount()))
        .digest("hex");
      if (captured !== revision) throw new Error("MCP App account changed during initialization");
      const instance = await deps.open({ ...params, accountContext });
      const bound = { ...params, instance };
      if (captured !== revision) {
        await deps.close(bound);
        throw new Error("MCP App account changed during initialization");
      }
      active.set(instance.token, bound);
      return instance;
    },
    close,
    invalidate() {
      // 先使在途 open 失效；注销旧凭证只作用于它自己的 Agent 代际。
      revision++;
      for (const bound of active.values()) void deps.close(bound).catch(() => undefined);
      active.clear();
    },
  };
}
