import { describe, expect, it } from "vitest";
import { parseOfficialMcpToolError } from "../src/official-mcp-tool-error.js";

describe("parseOfficialMcpToolError", () => {
  it("解析服务端下发的结构化标识", () => {
    expect(
      parseOfficialMcpToolError(
        '{"error_code":"quota_exceeded","message":"daily quota exceeded for bucket search_image (5/5), retry tomorrow or upgrade your coding plan","request_id":"req-1"}',
      ),
    ).toEqual({
      code: "quota_exceeded",
      message:
        "daily quota exceeded for bucket search_image (5/5), retry tomorrow or upgrade your coding plan",
      requestId: "req-1",
    });
    expect(
      parseOfficialMcpToolError('{"error_code":"coding_plan_required","message":"need a plan"}'),
    ).toEqual({ code: "coding_plan_required", message: "need a plan" });
  });

  it("容忍首尾空白与缺省的可选字段", () => {
    expect(parseOfficialMcpToolError('  {"error_code":"quota_exceeded"}  ')).toEqual({
      code: "quota_exceeded",
    });
    expect(
      parseOfficialMcpToolError('{"error_code":"quota_exceeded","message":"   ","request_id":""}'),
    ).toEqual({ code: "quota_exceeded" });
  });

  it("internal_error 与未知 code 一律不识别", () => {
    // internal_error 是服务端的兜底掩码，用户无法自助解决，不该驱动任何界面提示。
    expect(parseOfficialMcpToolError('{"error_code":"internal_error"}')).toBeUndefined();
    expect(parseOfficialMcpToolError('{"error_code":"whatever"}')).toBeUndefined();
    expect(parseOfficialMcpToolError('{"message":"no code"}')).toBeUndefined();
  });

  it("非 JSON 文本不做文案匹配兜底", () => {
    // 靠文案匹配会让服务端改一句话就静默失效。
    expect(parseOfficialMcpToolError("daily quota exceeded for bucket search_image")).toBeUndefined();
    expect(parseOfficialMcpToolError("")).toBeUndefined();
    expect(parseOfficialMcpToolError("{ not json")).toBeUndefined();
    expect(parseOfficialMcpToolError('["quota_exceeded"]')).toBeUndefined();
    expect(parseOfficialMcpToolError("null")).toBeUndefined();
  });
});
