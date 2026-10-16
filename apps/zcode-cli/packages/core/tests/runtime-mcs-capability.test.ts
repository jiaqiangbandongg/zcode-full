import { describe, expect, it } from "vitest";
import { buildRuntimeProviderRequestMessages } from "../src/runtime/helpers/runtime-provider-request-messages.js";
import { createTestRuntimeModel } from "./test-runtime-model.js";

const entries = [
  { message: { role: "user" as const, content: "hello" } },
  {
    kind: "attachment" as const,
    content: "runtime reminder",
    metadata: { source: "output_style" as const },
  },
];

function model(supportsMidConversationSystem: boolean) {
  return createTestRuntimeModel({
    generateText: async () => ({ finishReason: "stop", text: "", usage: {} }),
    propertyOverrides: { supportsMidConversationSystem },
  });
}

describe("runtime mid-conversation system projection", () => {
  it("uses the current Active Model property without provider or endpoint inference", () => {
    const enabled = buildRuntimeProviderRequestMessages(
      { config: {} },
      { entries, model: model(true) },
    );
    const disabled = buildRuntimeProviderRequestMessages(
      { config: {} },
      { entries, model: model(false) },
    );

    expect(enabled.messages.some((message) => message.role === "system")).toBe(true);
    expect(disabled.messages.some((message) => message.role === "system")).toBe(false);
  });

  it("keeps the execution-scoped force override without changing Model properties", () => {
    const activeModel = model(false);
    const result = buildRuntimeProviderRequestMessages(
      { config: { midConversationSystem: { mode: "force" } } },
      { entries, model: activeModel },
    );

    expect(result.messages.some((message) => message.role === "system")).toBe(true);
    expect(activeModel.properties.supportsMidConversationSystem).toBe(false);
  });
});
