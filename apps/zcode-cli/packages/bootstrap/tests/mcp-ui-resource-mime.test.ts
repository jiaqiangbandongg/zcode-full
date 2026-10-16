import { describe, expect, it, vi } from "vitest";
import { MCP_APPS_UI_READ_RESOURCE_MAX_BYTES } from "@zcode/shared/mcp-apps";
import { createExampleSessionAccess } from "../src/zcode-protocol/mcp-ui/contract.example.js";
import type { McpUiReadResourceParams } from "../src/zcode-protocol/mcp-ui/contract.js";
import { createMcpUiHandlers } from "../src/zcode-protocol/mcp-ui/handlers.js";

const params: McpUiReadResourceParams = {
  instance: { runtimeId: "test", token: "test-token", generation: 1, appIdentity: "a".repeat(64) },
  sessionId: "test-session",
  pluginId: "example-plugin",
  serverName: "plugin:example-plugin:widget",
  uri: "fixture://document.pdf",
};

describe("MCP App 常见资源读取", () => {
  it("PDF 与 SVG 返回原始内容和 MIME，但不泄露资源元数据", async () => {
    const access = createExampleSessionAccess();
    const contents = [
      { uri: params.uri, mimeType: "Application/PDF; version=1.7", blob: "JVBERi0xLjcK" },
      {
        uri: "fixture://vector.svg",
        mimeType: "image/svg+xml",
        text: '<svg xmlns="http://www.w3.org/2000/svg"/>',
      },
    ];
    access.readResourceForUi = vi.fn(async () => ({
      contents: contents.map((content) => ({ ...content, _meta: { private: "server-only" } })),
    }));
    await expect(createMcpUiHandlers().readResourceForUi(access, params)).resolves.toEqual({
      contents,
    });
    expect(access.readResourceForUi).toHaveBeenCalledWith(params.serverName, params.uri, undefined);
  });

  it.each(["application/x-msdownload", "application/vnd.example.unknown", undefined])(
    "仍拒绝不支持或缺失 MIME 的 blob：%s",
    async (mimeType) => {
      const access = createExampleSessionAccess();
      access.readResourceForUi = async () => ({
        contents: [{ uri: params.uri, mimeType, blob: "YQ==" }],
      });
      await expect(createMcpUiHandlers().readResourceForUi(access, params)).rejects.toMatchObject({
        reason: "mime_not_allowed",
      });
    },
  );

  it("新增格式仍按全部内容累计 8 MiB，边界通过、超出整次拒绝", async () => {
    const access = createExampleSessionAccess();
    const blob = Buffer.alloc(MCP_APPS_UI_READ_RESOURCE_MAX_BYTES / 2).toString("base64");
    const contents = [
      { uri: params.uri, mimeType: "application/pdf", blob },
      { uri: "fixture://archive.zip", mimeType: "application/zip", blob },
    ];
    access.readResourceForUi = async () => ({ contents });
    await expect(createMcpUiHandlers().readResourceForUi(access, params)).resolves.toEqual({
      contents,
    });
    access.readResourceForUi = async () => ({
      contents: [...contents, { uri: "fixture://extra", text: "a" }],
    });
    await expect(createMcpUiHandlers().readResourceForUi(access, params)).rejects.toMatchObject({
      reason: "too_large",
    });
  });

  it("允许的 MIME 不绕过服务器归属检查", async () => {
    const access = createExampleSessionAccess();
    access.readResourceForUi = vi.fn(async () => ({
      contents: [{ uri: params.uri, mimeType: "application/pdf", blob: "YQ==" }],
    }));
    await expect(
      createMcpUiHandlers().readResourceForUi(access, {
        ...params,
        serverName: "plugin:other:srv",
      }),
    ).rejects.toMatchObject({ code: -32602 });
    expect(access.readResourceForUi).not.toHaveBeenCalled();
  });
});
