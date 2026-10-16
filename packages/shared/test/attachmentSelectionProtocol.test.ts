import { describe, expect, it } from "vitest";
import { zcodeSessionSendParamsSchema } from "../src/zcode-protocol/index.js";
import { commandPayloadSchemas } from "../src/zcode-protocol-v4/command.js";

describe("附件与文本发送的模型合同", () => {
  const modelSelection = {
    providerId: "account:offpeak",
    modelId: "model",
    options: { reasoningLevel: "high" },
  };
  const modelExecution = {
    selectionScope: "execution",
    memoryExtraction: "skip",
    requestAuth: { headers: { "x-test-ticket": "fixture-only" } },
    subagents: { foregroundModel: "submission", background: "deny" },
  };
  it("两种发送保留相同 Selection 与执行约束", () => {
    const legacy = zcodeSessionSendParamsSchema.parse({
      sessionId: "session",
      content: "hi",
      attachments: [],
      modelSelection,
      modelExecution,
    });
    const current = commandPayloadSchemas.sendText.parse({
      text: "hi",
      modelSelection,
      modelExecution,
    });
    expect(legacy.modelSelection).toEqual(current.modelSelection);
    expect(legacy.modelExecution).toEqual(current.modelExecution);
  });
  it("缺 Selection 或非法执行范围不能通过附件入口绕过校验", () => {
    expect(
      zcodeSessionSendParamsSchema.safeParse({ sessionId: "s", content: "hi", modelExecution })
        .success,
    ).toBe(false);
    expect(
      zcodeSessionSendParamsSchema.safeParse({
        sessionId: "s",
        content: "hi",
        modelSelection,
        modelExecution: { ...modelExecution, selectionScope: "session" },
      }).success,
    ).toBe(false);
  });
});
