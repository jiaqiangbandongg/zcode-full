import type { Transport } from "@modelcontextprotocol/client";
import type { PluginSandboxHandle, PluginSandboxPlatformPort } from "@zcode/shared/mcp-apps";
import { MCP_APPS_TEARDOWN_TIMEOUT_MS } from "@zcode/shared/mcp-apps";
import type { PluginUiHostBridge } from "./pluginUiHostBridge.js";

/**
 * 实例卸载的收尾顺序：已握手的实例先给页面 `ui/resource-teardown` 的清理窗口（回包或超时），再关桥与端口、
 * 按捕获的 sandboxId/initId 释放旧登记，不能影响新凭证创建的页面。
 */
export function runPluginUiHostTeardown(input: {
  bridge: PluginUiHostBridge | null;
  transport: Transport | null;
  wasAttached: boolean;
  handle: PluginSandboxHandle | null;
  platform: Pick<PluginSandboxPlatformPort, "disposeSandbox">;
  setTimer: (callback: () => void, ms: number) => () => void;
  teardownTimeoutMs?: number;
}): Promise<void> {
  let resolveDone!: () => void;
  const donePromise = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });
  const release = () => {
    void input.bridge?.close().catch(() => undefined);
    void input.transport?.close().catch(() => undefined);
    if (input.handle) {
      void input.platform
        .disposeSandbox(input.handle.sandboxId, input.handle.initId)
        .catch(() => undefined)
        .finally(resolveDone);
    } else resolveDone();
  };
  if (!input.bridge || !input.wasAttached) {
    release();
    return donePromise;
  }
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    release();
  };
  const timeout = input.teardownTimeoutMs ?? MCP_APPS_TEARDOWN_TIMEOUT_MS;
  const cancelTimer = input.setTimer(finish, timeout + 100);
  input.bridge.teardownResource({}, { timeout }).then(
    () => {
      cancelTimer();
      finish();
    },
    () => {
      cancelTimer();
      finish();
    },
  );
  return donePromise;
}
