// @vitest-environment node
/**
 * MCP 结果投影：空 structuredContent 不再追加 "Structured content:" 文本块。
 *
 * 背景（2026-08-19 产品反馈）：CUA 等成功结果携带 structuredContent: undefined
 * 的空键时，通用 bridge 仍追加 "Structured content:\n"（stringify(undefined)
 * 为空串），模型每次都看到一段无信息量的尾巴。
 *
 * 同时锁住「有值必须投影」：上游 CUA toolError 的结构化 details（action_sent /
 * 恢复提示）只有 structuredContent 一个通道。Renderer 不解析这段文本触发副作用，
 * 但模型仍需要 delivery evidence 避免盲试或重放动作。
 */
import { describe, expect, it } from "vitest";

import { registerMcpTools } from "../src/mcp/index.js";
import { createToolRegistry } from "../src/tool/registry.js";
import type { McpPort } from "@zcode/shared";

describe("formatMcpToolResult structuredContent projection", () => {
  // 最小 mock port（与 mcp-tool-bridge.test.ts 的 createMockMcpPort 同形）；
  // 本用例组只消费 registerMcpTools 的 descriptor→entry 注册，port 不被调用。
  const createMockMcpPort = (): McpPort =>
    ({
      connectConfiguredServers: async () => ({ statuses: {}, tools: [] }),
      connectServer: async () => ({
        status: "connected",
        transport: "stdio",
        toolCount: 1,
        updatedAt: "now",
      }),
      disconnectServer: async () => undefined,
      status: async () => ({}),
      listTools: async () => [],
      callTool: async () => ({ content: [] }),
      close: async () => {},
    }) as McpPort;

  function structuredToolEntry() {
    const registry = createToolRegistry();
    registerMcpTools(registry, createMockMcpPort(), [
      {
        serverName: "modern",
        toolName: "structured",
        inputSchema: { type: "object" },
      },
    ]);
    return registry.get("mcp__modern__structured");
  }

  it("undefined 值不投影（CUA 成功结果空尾巴修复）", () => {
    const entry = structuredToolEntry();
    expect(
      entry?.formatModelContent?.({
        content: [{ type: "text", text: '{"pid":18067}' }],
        structuredContent: undefined,
      }),
    ).toBe('{"pid":18067}');
  });

  it("null / 空对象 / 空数组值同样不投影", () => {
    const entry = structuredToolEntry();
    for (const empty of [null, {}, []]) {
      expect(
        entry?.formatModelContent?.({
          content: [{ type: "text", text: "ok" }],
          structuredContent: empty,
        }),
      ).toBe("ok");
    }
  });

  it("有值的 structuredContent 仍完整投影（错误 delivery details 通道）", () => {
    const entry = structuredToolEntry();
    expect(
      entry?.formatModelContent?.({
        content: [{ type: "text", text: "blocked" }],
        isError: true,
        structuredContent: { action_sent: true, request_delivery_state: "possibly_sent" },
      }),
    ).toContain(
      'Structured content:\n{\n  "action_sent": true,\n  "request_delivery_state": "possibly_sent"\n}',
    );
  });
});
