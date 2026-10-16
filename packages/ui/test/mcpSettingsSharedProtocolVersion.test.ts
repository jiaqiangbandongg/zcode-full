import { describe, expect, it } from "vitest";
import {
  EMPTY_FORM,
  formToConfig,
  jsonDraftToForm,
  serverToForm,
} from "@/settings/mcpSettingsShared.js";
import type { ZCodeMcpServer } from "@zcode/shared";

describe("mcp settings shared protocolVersion round-trip", () => {
  it("preserves a configured protocolVersion across serverToForm -> formToConfig", () => {
    const server: ZCodeMcpServer = {
      config: { protocolVersion: "legacy", type: "http", url: "https://mcp.example.com/mcp" },
      name: "feishu",
      scope: "user",
    } as ZCodeMcpServer;
    const form = serverToForm(server);
    expect(form.protocolVersion).toBe("legacy");
    expect(formToConfig(form)).toMatchObject({ protocolVersion: "legacy", type: "http" });
  });

  it("omits protocolVersion from the config when the form leaves it unset (auto)", () => {
    const form = { ...EMPTY_FORM, type: "http" as const, url: "https://mcp.example.com/mcp" };
    expect(form.protocolVersion).toBe("");
    expect("protocolVersion" in formToConfig(form)).toBe(false);
  });

  it("preserves protocolVersion when a JSON draft is converted back to the form", () => {
    const form = jsonDraftToForm(
      JSON.stringify({
        feishu: { protocolVersion: "2026-07-28", type: "http", url: "https://mcp.example.com/mcp" },
      }),
      EMPTY_FORM,
    );
    expect(form.protocolVersion).toBe("2026-07-28");
  });

  // SG-01：config/JSON 里的非法枚举值在进表单时归一为未设置（等价 auto），
  // 与 shared DTO 的 isMcpProtocolVersion 静默丢弃行为对齐，避免下拉显示空白。
  it("normalizes an invalid protocolVersion to unset instead of surfacing it in the form", () => {
    const server = {
      config: { protocolVersion: "invalid", type: "http", url: "https://mcp.example.com/mcp" },
      name: "feishu",
      scope: "user",
    } as unknown as ZCodeMcpServer;
    expect(serverToForm(server).protocolVersion).toBe("");

    const draft = jsonDraftToForm(
      JSON.stringify({
        feishu: { protocolVersion: 42, type: "http", url: "https://mcp.example.com/mcp" },
      }),
      EMPTY_FORM,
    );
    expect(draft.protocolVersion).toBe("");
  });
});
