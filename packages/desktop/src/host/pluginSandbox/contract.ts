import type { PluginSandboxHandle, PluginSandboxRegisterInput } from "@zcode/shared/mcp-apps";

/** Host 到 Main 的登记请求关联；只拥有 pending 传输，不保存沙箱或会话事实。 */
export interface PluginSandboxRegistrationBridge {
  register(input: PluginSandboxRegisterInput): Promise<PluginSandboxHandle>;
  accept(
    result: Partial<PluginSandboxHandle> & { requestId: string; ok: boolean; error?: string },
  ): void;
  dispose(): void;
}
