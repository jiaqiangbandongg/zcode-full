import { generateText } from "ai";
import { describe, expect, it } from "vitest";
import { mergeModelRequestHeaders } from "../src/model/model-request-headers.js";
import { AiSdkModelExecution } from "../src/model/model-execution.js";
import { createRegistryProviderConfig, parseProviderConfig } from "@zcode/provider";

describe("模型 Header 合并与绑定边界", () => {
  it("默认值、用户值、鉴权值依次覆盖，保留其他字段且不改变输入", () => {
    const defaults = { "X-Title": "Z Code@cli", "X-ZCode-App-Version": "3.12.0" };
    const personal = { "x-title": "User", authorization: "old" };
    const auth = { Authorization: "Bearer fresh", "X-Once": "once" };
    expect(mergeModelRequestHeaders(defaults, personal, auth)).toEqual({
      "X-ZCode-App-Version": "3.12.0",
      "x-title": "User",
      Authorization: "Bearer fresh",
      "X-Once": "once",
    });
    expect(defaults["X-Title"]).toBe("Z Code@cli");
    expect(personal.authorization).toBe("old");
  });

  it("绑定后默认值/Provider 修改不影响旧 Model，鉴权只覆盖本次请求", async () => {
    const defaults = { "X-Title": "Z Code@electron", "X-ZCode-App-Version": "3.12.0" };
    const requests: Request[] = [];
    const execution = new AiSdkModelExecution(
      { defaultHeaders: defaults, env: {} },
      {
        transport: async (input, init) => {
          requests.push(new Request(input, init));
          return Response.json({
            id: "msg_headers",
            type: "message",
            role: "assistant",
            model: "model-a",
            content: [{ type: "text", text: "ok" }],
            stop_reason: "end_turn",
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 1 },
          });
        },
      },
    );
    const providerFor = (title: string) => {
      const provider = createRegistryProviderConfig(
        parseProviderConfig({
          group: "standard-personal",
          access: { type: "api-key", apiKey: "key" },
          api: {
            type: "anthropic-messages",
            baseUrl: "https://openrouter.ai/api",
            headers: { "x-title": title, "x-once": "stale" },
          },
        }),
      );
      if (!provider.ok) throw new Error("invalid header fixture");
      return { providerId: "fixture", modelId: "model-a", providerConfig: provider.config };
    };
    const bind = (title: string) =>
      execution.bindModel({
        ...providerFor(title),
        supportsJsonSchemaOutput: false,
        optionSpecs: { reasoningLevel: { map: "{}" }, maxOutputTokens: { map: "{}" } },
      });
    const old = bind("Personal");
    defaults["X-ZCode-App-Version"] = "changed";
    const next = bind("New Personal");
    const options = { reasoningLevel: "disabled", maxOutputTokens: 1024 };
    const resolved = [
      old.resolveRequest({
        options,
        requestAuth: { apiKey: "fresh-key", headers: { "X-Once": "fresh" } },
      }),
      old.resolveRequest({ options }),
      next.resolveRequest({ options }),
    ];
    for (const model of resolved)
      await generateText({ model: model.model, prompt: "hello", maxRetries: 0 });
    expect(requests.map((r) => r.headers.get("x-title"))).toEqual([
      "Personal",
      "Personal",
      "New Personal",
    ]);
    expect(requests.map((r) => r.headers.get("x-zcode-app-version"))).toEqual([
      "3.12.0",
      "3.12.0",
      "3.12.0",
    ]);
    expect(requests.map((r) => r.headers.get("x-once"))).toEqual(["fresh", "stale", "stale"]);
    expect(requests.map((r) => r.headers.get("authorization"))).toEqual([
      "Bearer fresh-key",
      "Bearer key",
      "Bearer key",
    ]);
    expect(requests.every((r) => r.headers.get("x-openrouter-title") === "ZCode")).toBe(true);
  });
});
