import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelToolContract } from "@zcode/contracts";
import { TestAiSdkModelAdapter, TestProviderConfigFixture } from "./test-provider-config.js";
import { createTestModelProperties } from "./test-model-format.js";

describe("MFJS 使用固定执行模型的 properties", () => {
  afterEach(() => vi.unstubAllGlobals());
  for (const streaming of [false, true]) {
    it.each([false, true])(
      `stream=${streaming} / MFJS=%s 保持真实请求工具 schema`,
      async (enabled) => {
        const bodies: Array<{
          tools: Array<{
            input_schema: {
              properties: { alias: { $ref: string } };
              $defs?: Record<string, unknown>;
            };
          }>;
        }> = [];
        const registry = new TestProviderConfigFixture({
          providers: {
            mfjs: { kind: "anthropic", apiKey: "fake", baseURL: "https://mfjs.invalid/anthropic" },
          },
        });
        vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
          const request = new Request(input, init);
          bodies.push(await request.json());
          // 只抓出站载荷，明确终止；不消耗账号额度，也不伪造成功模型结果。
          return new Response(
            JSON.stringify({ error: { type: "invalid_request_error", message: "captured" } }),
            {
              status: 400,
              headers: { "content-type": "application/json" },
            },
          );
        });
        const properties = createTestModelProperties({}, { requiresMfjsToolSchema: enabled });
        const model = new TestAiSdkModelAdapter({ registry }).createModel({
          providerId: "mfjs",
          modelId: "test-model",
          properties,
        });
        const tool: ModelToolContract = {
          name: "Read",
          capability: "read_file",
          description: "Read",
          readOnly: true,
          inputSchema: {
            type: "object",
            properties: {
              source: { type: "object", properties: { path: { type: "string" } } },
              alias: { $ref: "#/properties/source" },
            },
          },
          outputSchema: { type: "object" },
        };
        const original = structuredClone(tool);
        const request = { messages: [{ role: "user" as const, content: "probe" }], tools: [tool] };
        if (streaming) {
          await expect(async () => {
            for await (const _event of model.streamText(request)) {
              /* 消费到明确错误。 */
            }
          }).rejects.toThrow();
        } else {
          await expect(model.generateText(request)).rejects.toThrow();
        }
        expect(bodies).toHaveLength(1);
        const schema = bodies[0]!.tools[0]!.input_schema;
        expect(schema.properties.alias.$ref).toBe(
          enabled ? "#/$defs/zcode_ref_0" : "#/properties/source",
        );
        if (enabled)
          expect(schema.$defs?.zcode_ref_0).toEqual({
            type: "object",
            properties: { path: { type: "string" } },
          });
        else expect(schema).not.toHaveProperty("$defs");
        expect(tool).toEqual(original);
        expect(model.properties.requiresMfjsToolSchema).toBe(enabled);
      },
    );
  }
});
