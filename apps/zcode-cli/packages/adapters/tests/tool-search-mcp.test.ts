import { expect, it } from "vitest";
import { normalizeMcpToolDescriptor } from "../src/mcp/descriptor.js";

it("normalizes MCP search hints and respects server or tool alwaysLoad independently of trust", () => {
  const input = {
    name: "search",
    inputSchema: {},
    _meta: { "anthropic/searchHint": " find\n docs ", "anthropic/alwaysLoad": true },
  };
  expect(normalizeMcpToolDescriptor("test", input)).toMatchObject({
    alwaysLoad: true,
    searchHint: "find docs",
  });
  expect(normalizeMcpToolDescriptor("test", input).official).toBeUndefined();
  expect(
    normalizeMcpToolDescriptor("test", { ...input, _meta: {} }, undefined, false, true).alwaysLoad,
  ).toBe(true);
  expect(
    normalizeMcpToolDescriptor("test", {
      ...input,
      _meta: { "anthropic/alwaysLoad": "true", "anthropic/searchHint": 1 },
    }),
  ).toMatchObject({ alwaysLoad: false, searchHint: undefined });
});
