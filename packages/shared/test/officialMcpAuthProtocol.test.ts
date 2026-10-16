/* OMCP-011 相关 —— 官方 MCP 身份头协议 schema（spec §7.2）。
   请求侧不得携带任何秘密；响应侧失败原因必须可枚举且无自由文本。 */
import { describe, expect, it } from "vitest";
import {
  zcodeOfficialMcpAuthHeadersRequestParamsSchema,
  zcodeOfficialMcpAuthHeadersResponseSchema,
  zcodeProtocolMethods,
} from "../src/zcode-protocol/index.js";

const VALID_REQUEST = {
  mcpKey: "image-search",
  pluginId: "zcode-tools@zcode-plugins-official",
  requestId: "mcp-auth-1",
  targetOrigin: "https://mcp.zcode.example",
  workspace: { workspaceKey: "local:/repo", workspacePath: "/repo" },
};

describe("official mcp auth headers protocol", () => {
  it("registers the reverse request under the interaction namespace", () => {
    expect(zcodeProtocolMethods.interactionRequestOfficialMcpAuthHeaders).toBe(
      "interaction/requestOfficialMcpAuthHeaders",
    );
  });

  it("accepts a minimal request and a remote workspace identity", () => {
    expect(zcodeOfficialMcpAuthHeadersRequestParamsSchema.parse(VALID_REQUEST)).toMatchObject({
      mcpKey: "image-search",
      targetOrigin: "https://mcp.zcode.example",
    });
    expect(
      zcodeOfficialMcpAuthHeadersRequestParamsSchema.safeParse({
        ...VALID_REQUEST,
        workspace: {
          workspaceIdentity: "ssh:host/repo",
          workspaceKey: "ssh:host/repo",
          workspacePath: "/repo",
        },
      }).success,
    ).toBe(true);
  });

  it("is strict, so a smuggled credential field is rejected", () => {
    for (const extra of [
      { jwt: "leaked" },
      { headers: { Authorization: "Bearer leaked" } },
      { codingPlanApiKey: "leaked" },
    ]) {
      expect(
        zcodeOfficialMcpAuthHeadersRequestParamsSchema.safeParse({ ...VALID_REQUEST, ...extra })
          .success,
      ).toBe(false);
    }
  });

  it("requires every identifying field to be a non-empty string", () => {
    for (const field of ["mcpKey", "pluginId", "requestId", "targetOrigin"]) {
      expect(
        zcodeOfficialMcpAuthHeadersRequestParamsSchema.safeParse({
          ...VALID_REQUEST,
          [field]: "",
        }).success,
      ).toBe(false);
    }
  });

  it("accepts both response branches", () => {
    expect(
      zcodeOfficialMcpAuthHeadersResponseSchema.parse({
        headers: { Authorization: "Bearer jwt", "Bigmodel-Target-Type": "TEAM" },
        ok: true,
      }),
    ).toMatchObject({ ok: true });
    for (const reason of ["official_auth_unavailable", "official_auth_plan_required"]) {
      expect(
        zcodeOfficialMcpAuthHeadersResponseSchema.parse({ ok: false, reason }),
      ).toMatchObject({ ok: false, reason });
    }
  });

  it("rejects unknown reasons, free-text errors and cross-branch fields", () => {
    const invalid = [
      { ok: false, reason: "start_plan_not_supported" },
      { ok: false, reason: "official_auth_rejected" },
      { errorMessage: "something went wrong", ok: false, reason: "official_auth_unavailable" },
      { headers: {}, ok: false, reason: "official_auth_unavailable" },
      { ok: true, reason: "official_auth_unavailable" },
      { ok: true },
    ];
    for (const value of invalid) {
      expect(zcodeOfficialMcpAuthHeadersResponseSchema.safeParse(value).success).toBe(false);
    }
  });
});
