import { ProtocolError } from "@modelcontextprotocol/client";
import type { IPluginUiSamplingService, PluginUiPluginScope } from "@zcode/services";
import { mcpAppsSamplingParamsSchema } from "@zcode/shared/mcp-apps";
import type { PluginUiHostBridge } from "./pluginUiHostBridge.js";

export function createPluginUiSampling(deps: {
  bridge: Pick<IPluginUiSamplingService, "sample" | "cancelSampling">;
  scope(): PluginUiPluginScope;
  canSample(): boolean;
  createCallId(): string;
  activeCalls: Set<string>;
  onBusyChange?(): void;
}) {
  const pending = new Set<() => void>();
  return {
    reset() {
      for (const cancel of pending) cancel();
      pending.clear();
    },
    install(bridge: PluginUiHostBridge, isCurrent: () => boolean) {
      bridge.oncreatesamplingmessage = async (params, context) => {
        if (!isCurrent() || !deps.canSample())
          throw new ProtocolError(-32601, "Sampling is unavailable for this task");
        const parsed = mcpAppsSamplingParamsSchema.safeParse(params);
        if (!parsed.success)
          throw new ProtocolError(-32602, "Unsupported or invalid sampling parameters", {
            issues: parsed.error.issues.map(({ path, message }) => ({ path, message })),
          });
        const signal = context.mcpReq?.signal;
        signal?.throwIfAborted();
        const scope = deps.scope();
        const operationId = deps.createCallId();
        let cancelled = false;
        const cancel = () => {
          if (cancelled) return;
          cancelled = true;
          void deps.bridge.cancelSampling({ ...scope, operationId }).catch(() => undefined);
        };
        // 先注册取消与 busy，再发请求，确保取消先于 Agent 接纳也能留下终态。
        pending.add(cancel);
        deps.activeCalls.add(operationId);
        deps.onBusyChange?.();
        signal?.addEventListener("abort", cancel, { once: true });
        try {
          const result = await deps.bridge.sample({ ...scope, operationId, request: parsed.data });
          if (cancelled || !isCurrent())
            throw new ProtocolError(-32000, "Sampling instance was closed");
          signal?.throwIfAborted();
          return result;
        } catch (error) {
          if (error instanceof ProtocolError) throw error;
          const code =
            error && typeof error === "object" && "code" in error && typeof error.code === "number"
              ? error.code
              : -32000;
          throw new ProtocolError(code, error instanceof Error ? error.message : String(error));
        } finally {
          signal?.removeEventListener("abort", cancel);
          pending.delete(cancel);
          deps.activeCalls.delete(operationId);
          deps.onBusyChange?.();
        }
      };
    },
  };
}
