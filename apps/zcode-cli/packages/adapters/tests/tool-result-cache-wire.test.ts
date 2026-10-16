import { createAnthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";
import { describe, expect, it } from "vitest";
import type { ModelInputMessage } from "@zcode/contracts";
import { toAiSdkMessages } from "../src/model/index.js";

const cases = [
  { count: 1, cachedIndex: 0, failed: false },
  { count: 2, cachedIndex: 1, failed: false },
  { count: 2, cachedIndex: 1, failed: true },
  { count: 2, cachedIndex: 0, failed: false },
  { count: 3, cachedIndex: 1, failed: true },
  { count: 3, cachedIndex: 2, failed: false },
];
describe("tool result cache breakpoint on final provider wire", () => {
  it.each(cases)(
    "preserves $count result(s), marker $cachedIndex, failed=$failed",
    async ({ count, cachedIndex, failed }) => {
      const cache = { type: "ephemeral" as const, ttl: "1h" as const };
      let captured: { messages: Array<{ role: string; content: unknown }> } | undefined;
      const provider = createAnthropic({
        apiKey: "fixture-key",
        baseURL: "https://provider.test/v1",
        fetch: async (_input, init) => {
          captured = JSON.parse(String(init?.body));
          return Response.json({
            id: "cache-fixture",
            type: "message",
            role: "assistant",
            model: "fixture",
            content: [{ type: "text", text: "done" }],
            stop_reason: "end_turn",
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 1 },
          });
        },
      });
      const calls = Array.from({ length: count }, (_, index) => ({
        id: `call_${index}`,
        name: "Read",
        input: { file_path: `/fixture/${index}` },
      }));
      const messages: ModelInputMessage[] = [
        { role: "user", content: "Read the requested files" },
        { role: "assistant", content: "", toolCalls: calls },
        ...calls.map(
          (call, index): ModelInputMessage => ({
            role: "tool",
            toolCallId: call.id,
            toolName: call.name,
            content: `result ${index}`,
            isError: failed && index === 0,
            ...(index === cachedIndex ? { cacheControl: cache } : {}),
          }),
        ),
      ];
      await generateText({
        model: provider("fixture"),
        messages: toAiSdkMessages(messages),
        maxRetries: 0,
      });
      expect(captured?.messages.at(-1)).toEqual({
        role: "user",
        content: calls.map((call, index) => ({
          type: "tool_result",
          tool_use_id: call.id,
          content: `result ${index}`,
          ...(failed && index === 0 ? { is_error: true } : {}),
          ...(index === cachedIndex ? { cache_control: cache } : {}),
        })),
      });
    },
  );
});
