import { describe, expect, it } from "vitest";
import { McpUiServerScopeError } from "./contract.js";
import { createExampleSessionAccess } from "./contract.example.js";

describe("mcp-ui contract", () => {
  it("示例 session 视图按 serverName 判定归属", async () => {
    const access = createExampleSessionAccess();
    await expect(access.hasMcpServer("plugin:example-plugin:widget")).resolves.toBe(true);
    await expect(access.hasMcpServer("plugin:other:srv")).resolves.toBe(false);
  });

  it("越权错误映射为 -32602", () => {
    const error = new McpUiServerScopeError("plugin:other:srv");
    expect(error.code).toBe(-32602);
    expect(error.message).toContain("is not available in this session");
  });
});
