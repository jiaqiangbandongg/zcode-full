import { ServiceChannels, hostPluginSandboxRegisterResultMessageSchema } from "@zcode/shared";
import type { PluginSandboxHandle } from "@zcode/shared/mcp-apps";
import { describe, expect, it } from "vitest";
import { examplePrepareAndMount, exampleReadBlob } from "./contract.example.js";
import { IPluginUiBridgeService } from "./contract.js";

describe("plugin-ui-bridge contract", () => {
  it("描述符绑定 plugin-ui-bridge 频道", () => {
    expect(IPluginUiBridgeService.channelName).toBe(ServiceChannels.PluginUiBridge);
    expect(ServiceChannels.PluginUiBridge).toBe("plugin-ui-bridge");
  });

  it("句柄能带的全部资源级字段都过 main → host 的 strict 回包 schema", () => {
    // 回包 schema 是 strict 的：PluginSandboxHandle.resourceMeta 新增字段没同步到 validation.ts，
    // 整条回包会被 host 拒收，桥永远等不到句柄，卡片卡在 preparing（2026-09-20 permissions 复现）。
    const handle: PluginSandboxHandle = {
      instance: {
        runtimeId: "test-agent",
        generation: 1,
        token: "test-token",
        appIdentity: "a".repeat(64),
      },
      sandboxId: "sb-01",
      initId: 1,
      shellUrl: "zcode-sandbox://shell-sb-01/",
      partition: "persist:plugin-sandbox-v1-0123456789abcdef",
      resourceMeta: {
        prefersBorder: true,
        heightHint: 320,
        minFrameHeight: 120,
        showInline: false,
        permissions: ["clipboardWrite"],
      },
    };
    expect(
      hostPluginSandboxRegisterResultMessageSchema.safeParse({
        type: "plugin-sandbox-register-result",
        requestId: "req-1",
        ok: true,
        ...handle,
      }).success,
    ).toBe(true);
  });

  it("示例只依赖契约方法", async () => {
    const bridge: IPluginUiBridgeService = {
      recycleInstance: async () => true,
      validateInstance: async () => undefined,
      closeInstance: async () => undefined,
      prepareSandbox: async (params) => ({
        instance: {
          runtimeId: "test-agent",
          generation: 1,
          token: "test-token",
          appIdentity: "a".repeat(64),
        },
        sandboxId: `sb-${params.scopeId}`,
        initId: 1,
        shellUrl: `zcode-sandbox://shell-sb-${params.scopeId}/`,
        partition: `plugin-sandbox:sb-${params.scopeId}`,
      }),
      callTool: async () => ({ content: [] }),
      cancelToolCall: async () => ({ cancelled: false }),
      readResource: async (params) => ({
        contents: [{ uri: params.uri, mimeType: "model/gltf-binary", blob: "AAAA" }],
      }),
      // 资源订阅接口扩展后，契约示例的替身也必须完整实现，避免类型检查被旧样例阻断。
      listResources: async () => ({ resources: [] }),
      listResourceTemplates: async () => ({ resourceTemplates: [] }),
      subscribeResource: async () => undefined,
      unsubscribeResource: async () => undefined,
      listSurfaces: async () => [],
    };
    await expect(examplePrepareAndMount(bridge)).resolves.toEqual({
      src: "zcode-sandbox://shell-sb-tool:call_1/",
      partition: "plugin-sandbox:sb-tool:call_1",
      initId: 1,
    });
    await expect(exampleReadBlob(bridge)).resolves.toBe("AAAA");
  });
});
