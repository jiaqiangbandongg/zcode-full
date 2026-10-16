import { describe, expect, it } from "vitest";
import {
  commandCompatibilityAttributes,
  httpResponseCompatibilityAttributes,
  modelAttemptCompatibilityAttributes,
  modelResponseCompatibilityAttributes,
  toolCompatibilityAttributes,
} from "../src/compatibility-adapters.js";

describe("telemetry compatibility adapters", () => {
  it("projects tool facts to GenAI aliases without inventing a second canonical schema", () => {
    expect(
      toolCompatibilityAttributes({
        toolCallId: "tool-1",
        toolName: "Bash",
      }),
    ).toEqual({
      "gen_ai.operation.name": "execute_tool",
      "gen_ai.tool.call.id": "tool-1",
      "gen_ai.tool.name": "Bash",
    });
  });

  it("projects a sanitized model target to GenAI and standard server aliases", () => {
    expect(
      modelAttemptCompatibilityAttributes({
        providerId: "anthropic-prod",
        providerKind: "anthropic",
        providerOrigin: "https://api.example.com:8443",
        reasoning: {
          capability: "supported",
          requestedControl: "fixed_level",
          requestedLevel: "high",
          requestedState: "enabled",
        },
        requestedModel: "claude-sonnet-4",
      }),
    ).toEqual({
      "gen_ai.provider.name": "anthropic",
      "gen_ai.request.model": "claude-sonnet-4",
      "server.address": "api.example.com",
      "server.port": 8443,
    });
  });

  it("projects response, usage and HTTP facts to their standard aliases", () => {
    expect(
      modelResponseCompatibilityAttributes({
        finishReason: "tool_calls",
        inputTokens: 120,
        outputTokens: 30,
        responseModel: "claude-sonnet-4-20260701",
      }),
    ).toEqual({
      "gen_ai.response.finish_reasons": ["tool_calls"],
      "gen_ai.response.model": "claude-sonnet-4-20260701",
      "gen_ai.usage.input_tokens": 120,
      "gen_ai.usage.output_tokens": 30,
    });
    expect(httpResponseCompatibilityAttributes(429)).toEqual({
      "http.response.status_code": 429,
    });
    expect(commandCompatibilityAttributes({ exitCode: 127, signal: "SIGTERM" })).toEqual({
      "process.exit.code": 127,
      "process.signal.name": "SIGTERM",
    });
  });
});
