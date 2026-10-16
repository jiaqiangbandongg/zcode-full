import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  InMemorySessionEventStore,
  createModelId,
  createModelProviderId,
  createSessionId,
  type ModelOptions,
} from "@zcode/contracts";
import { AgentRuntime } from "../../core/src/runtime.js";
import { createModel } from "../src/model/model.js";
import { createSqliteSessionStore } from "../src/storage/session-store/sqlite-session-store.js";
import { createTestModelProperties } from "./test-model-format.js";

describe("Goal Verifier bound model options", () => {
  it.each([
    ["high", 64_000, false],
    ["max", 128_000, false],
    ["disabled", 4_000, false],
    [undefined, 64_000, false],
    ["high", 64_000, true],
  ] as const)("inherits %s and the %i output limit (retry=%s)", async (level, limit, retry) => {
    const root = await mkdtemp(join(tmpdir(), "zcode-verifier-options-"));
    const sessionId = createSessionId("verifier-options");
    const store = createSqliteSessionStore({ dbPath: join(root, "session.sqlite") });
    const requests: Required<ModelOptions>[] = [];
    const selection = {
      providerId: retry ? "account:bigmodel-start-plan" : "fixture",
      modelId: "model",
      ...(level ? { options: { reasoningLevel: level } } : {}),
    };
    let runtime: AgentRuntime | undefined;
    try {
      runtime = new AgentRuntime(
        sessionId,
        {
          mode: "build",
          modelStreaming: "off",
          workingDirectory: root,
          modelSelection: selection,
          memory: { enabled: false },
          compact: { enabled: false },
        },
        {
          eventStore: new InMemorySessionEventStore(),
          sessionStore: store,
          modelFactory: ({ selection: current }) =>
            createModel({
              providerId: createModelProviderId(current.providerId),
              modelId: createModelId(current.modelId),
              properties: createTestModelProperties(),
              optionSpecs: {
                maxOutputTokens: { max: limit },
                reasoningLevel: { values: ["disabled", "low", "high", "max"] },
              },
              options: { reasoningLevel: current.options?.reasoningLevel ?? "max" },
              executor: {
                async generateText(request) {
                  // 捕获真实 Model 合并、校验之后的参数，而非仅观察 Factory 输入。
                  requests.push(request.options);
                  if (retry && requests.length === 2) {
                    runtime!.setSessionModelSelection({ providerId: "other", modelId: "other" });
                    throw Object.assign(new Error("model admission concurrency limit exceeded"), {
                      code: "model_rate_limited",
                      context: {
                        providerCode: "3010",
                        providerId: current.providerId,
                        reason: "rate_limited",
                        retryable: false,
                      },
                    });
                  }
                  return {
                    finishReason: "stop",
                    text:
                      requests.length === 1
                        ? "work completed"
                        : JSON.stringify({ passed: true, reason: "verified" }),
                    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
                  };
                },
                async *streamText() {
                  throw new Error("Unexpected streaming request");
                },
              },
            }),
        },
      );
      await runtime.ensureSessionPersistedForExternalActivity("/goal verify options");
      await store.setTarget({ sessionID: sessionId, objective: "Complete fixture work" });
      await runtime.executeTurn("complete work");
      await runtime.continueActiveTargetIfIdle({ verifyBeforeContinue: true });
      expect(requests).toHaveLength(retry ? 3 : 2);
      for (const request of requests.slice(1)) {
        expect(request).toEqual({ maxOutputTokens: limit, reasoningLevel: level ?? "max" });
      }
      expect(runtime.getSessionModelSelection()).toEqual(
        retry ? { providerId: "other", modelId: "other" } : selection,
      );
      expect((await store.readTarget({ sessionID: sessionId }))?.status).toBe("complete");
    } finally {
      runtime?.beginShutdown();
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
