import { describe, expect, it } from "vitest";
import {
  MCP_APPS_EXTENSION_ID,
  MCP_APPS_RESOURCE_MIME_TYPE,
  MCP_APPS_UI_RESOURCE_SCHEME,
  MCP_APPS_LEGACY_RESOURCE_URI_META_KEY,
  buildMcpAppsClientCapabilities,
  isMcpAppsUiReadResourceMimeAllowed,
} from "./contract.js";
import { normalizeMcpAppCspRelaxations, normalizeMcpToolUiMeta } from "./toolMeta.js";
import {
  exampleClientCapabilities,
  exampleResourceMetaWithRelaxations,
  exampleSandboxHandle,
  exampleToolUiDescriptor,
} from "./contract.example.js";

describe("mcp-apps-protocol contract", () => {
  it.each([
    ["PDF 文档", " Application/PDF ; version=1.7 "],
    ["办公文档", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
    ["电子表格", "application/vnd.ms-excel"],
    ["开放演示文档", "application/vnd.oasis.opendocument.presentation"],
    ["矢量图片", "image/svg+xml; charset=utf-8"],
    ["相机图片", "image/heic"],
    ["动画图片", "image/gif"],
    ["音频", "audio/mpeg"],
    ["WAV 别名", "audio/x-wav"],
    ["视频", "video/mp4"],
    ["归档", "application/zip"],
    ["GZIP 别名", "application/x-gzip"],
    ["字体", "font/woff2"],
    ["结构化数据", "application/yaml"],
    ["JSON 模型", "model/gltf+json"],
    ["已有文本前缀", "text/csv; charset=utf-8"],
    ["已有二进制", "application/octet-stream"],
    ["已有模型", "model/gltf-binary"],
  ])("页面资源接纳%s（%s）", (_label, mimeType) => {
    expect(isMcpAppsUiReadResourceMimeAllowed(mimeType)).toBe(true);
  });

  it.each([
    "application/x-msdownload",
    "application/x-executable",
    "application/vnd.example.unknown",
    "image/x-example-unknown",
    "application/pdf-malware",
    "application/pdf,application/x-msdownload",
    "",
    " ; charset=utf-8",
  ])("资源扩容仍拒绝未知或不合法 MIME：%s", (mimeType) => {
    expect(isMcpAppsUiReadResourceMimeAllowed(mimeType)).toBe(false);
  });

  it("扩展标识与 UI 资源 mimeType 与官方 SDK 常量一致", () => {
    expect(MCP_APPS_EXTENSION_ID).toBe("io.modelcontextprotocol/ui");
    expect(MCP_APPS_RESOURCE_MIME_TYPE).toBe("text/html;profile=mcp-app");
    expect(MCP_APPS_LEGACY_RESOURCE_URI_META_KEY).toBe("ui/resourceUri");
    expect(buildMcpAppsClientCapabilities()).toEqual(exampleClientCapabilities);
  });

  it("resourceUri 同时接受标准键、弃用扁平键与 openai/outputTemplate", () => {
    expect(normalizeMcpToolUiMeta({ ui: { resourceUri: "ui://a/b" } })?.resourceUri).toBe(
      "ui://a/b",
    );
    expect(normalizeMcpToolUiMeta({ "ui/resourceUri": "ui://a/c" })?.resourceUri).toBe("ui://a/c");
    expect(normalizeMcpToolUiMeta({ "openai/outputTemplate": "ui://a/d" })?.resourceUri).toBe(
      "ui://a/d",
    );
    expect(normalizeMcpToolUiMeta({ ui: { resourceUri: "https://a/b" } })).toBeNull();
  });

  it("zcode/csp 只认已知布尔键", () => {
    expect(normalizeMcpAppCspRelaxations(exampleResourceMetaWithRelaxations)).toEqual({
      unsafeEval: true,
    });
    expect(normalizeMcpAppCspRelaxations({ "zcode/csp": { unsafeEval: false, other: true } })).toBe(
      null,
    );
  });

  it("示例描述与句柄满足契约形状", () => {
    expect(exampleToolUiDescriptor.resourceUri.startsWith(MCP_APPS_UI_RESOURCE_SCHEME)).toBe(true);
    expect(exampleSandboxHandle.shellUrl).toBe(
      `zcode-sandbox://shell-${exampleSandboxHandle.sandboxId}/`,
    );
    expect(exampleSandboxHandle.partition.startsWith("persist:plugin-sandbox-")).toBe(true);
  });
});
