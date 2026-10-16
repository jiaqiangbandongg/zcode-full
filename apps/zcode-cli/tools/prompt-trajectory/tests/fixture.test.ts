import { deepStrictEqual, equal, throws } from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createRuntimeModelConfig,
  resolveModelSelection,
  resolveUpstreamBaseURL,
} from "../src/fixture.js";

describe("prompt trajectory model config", () => {
  it("builds an execution-scoped model config from an explicit fixture model", () => {
    const modelConfig = createRuntimeModelConfig({
      env: {},
      fixture: {
        name: "config-model",
        model: {
          apiKey: "secret",
          apiKeyRequired: true,
          headers: { "X-Test": "1" },
          id: "glm/glm-4.6",
          kind: "openai-compatible",
          upstreamBaseURL: "https://api.example.test/v1",
        },
        steps: [{ type: "submitPrompt", text: "hello" }],
      },
      proxyBaseURL: "http://127.0.0.1:1234/v1",
    });

    const fixture = {
      name: "x",
      model: {
        id: "glm/glm-4.6",
        upstreamBaseURL: "https://api.example.test/v1",
      },
      steps: [],
    };
    equal(resolveUpstreamBaseURL({ fixture }), "https://api.example.test/v1");
    equal(resolveModelSelection(fixture), "glm/glm-4.6");
    deepStrictEqual(modelConfig.main, {
      apiKey: "secret",
      apiKeyRequired: true,
      baseURL: "http://127.0.0.1:1234/v1",
      headers: { "X-Test": "1" },
      kind: "openai-compatible",
      model: "glm-4.6",
      provider: "glm",
    });
  });

  it("requires an explicit fixture model", () => {
    throws(
      () =>
        createRuntimeModelConfig({
          env: {},
          fixture: { name: "config-model", steps: [] },
          proxyBaseURL: "http://127.0.0.1:1234/v1",
        }),
      /Model config is missing/u,
    );
  });
});
