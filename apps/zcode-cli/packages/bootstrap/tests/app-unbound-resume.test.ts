import { describe, expect, it, vi } from "vitest";
import { createLegacySelectionStoreFixture } from "./helpers/legacy-selection-store.js";
import {
  SESSION_ENTRY_MODEL_SELECTION,
  createMessageId,
  createPartId,
  createProjectId,
  createSessionId,
  type Logger,
  type LoggerFactory,
  type ModelSelection,
} from "@zcode/contracts";
import {
  createRegistryBackedTestApp,
  createTestProviderRegistry,
} from "./helpers/registry-backed-test-app.js";

const identity = { providerId: "provider-a", modelId: "model-a" };
const complete = { ...identity, options: { reasoningLevel: "high" } };

describe("App 从真实存储恢复未绑定选择", () => {
  it.each<{
    stored?: unknown;
    candidate?: ModelSelection;
    bound?: ModelSelection;
    readFailure?: boolean;
  }>([
    { stored: undefined, candidate: undefined },
    { stored: undefined, candidate: undefined, readFailure: true },
    { stored: identity, candidate: identity },
    {
      stored: { ...identity, options: { reasoningLevel: "removed" } },
      candidate: { ...identity, options: { reasoningLevel: "removed" } },
    },
    { stored: { ...identity, options: { reasoningLevel: 3 } }, candidate: identity },
    { stored: { ...identity, options: null }, candidate: identity },
    { stored: { providerId: "provider-a" }, candidate: undefined },
    {
      stored: { ...complete, providerId: "builtin:bigmodel" },
      candidate: { ...complete, providerId: "bigmodel-api" },
      bound: { ...complete, providerId: "bigmodel-api" },
    },
    {
      stored: { ...complete, providerId: "builtin:bigmodel-coding-plan" },
      candidate: { ...complete, providerId: "account:bigmodel-individual-coding-plan" },
      bound: { ...complete, providerId: "account:bigmodel-individual-coding-plan" },
    },
    {
      stored: { ...complete, providerId: "removed" },
      candidate: { ...complete, providerId: "removed" },
    },
    { stored: { ...complete, modelId: "removed" }, candidate: { ...complete, modelId: "removed" } },
    { stored: complete, candidate: complete, bound: complete },
  ])(
    "保留迁移后的意图 $stored，Registry 只影响运行绑定",
    async ({ stored, candidate, bound, readFailure }) => {
      const fixture = await createLegacySelectionStoreFixture();
      let { store } = fixture;
      const sessionID = createSessionId("app-unbound-resume");
      const messageID = createMessageId("history-message");
      await store.createSession({
        id: sessionID,
        projectID: createProjectId("app-unbound"),
        directory: process.cwd(),
        slug: "app-unbound",
        title: "History survives",
        version: "test",
      });
      await store.saveMessage({
        id: messageID,
        sessionID,
        role: "user",
        agent: "zcode-agent",
        time: { created: 1 },
        modelSelection: complete,
      });
      await store.savePart({
        id: createPartId("history-text"),
        messageID,
        sessionID,
        type: "text",
        text: "History must remain visible",
      });
      const oldSelection = stored as ModelSelection | undefined;
      if (oldSelection?.providerId?.startsWith("builtin:")) {
        fixture.seedLegacy(sessionID, {
          providerId: oldSelection.providerId,
          modelId: oldSelection.modelId,
          thoughtLevel: oldSelection.options?.reasoningLevel,
        });
        store = fixture.store;
      } else if (stored !== undefined)
        await store.saveSessionEntry({
          id: `${sessionID}:runtime-model-selection`,
          sessionID,
          type: SESSION_ENTRY_MODEL_SELECTION,
          touchSession: false,
          time: { created: 2, updated: 2 },
          data: stored,
        });
      const generateText = vi.fn(async () => ({
        text: "Continued",
        finishReason: "stop" as const,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      }));
      const app = await createRegistryBackedTestApp({
        env: {},
        skipUserConfig: true,
        resume: true,
        sessionId: sessionID,
        sessionStore: store,
        providerRegistry: createTestProviderRegistry([
          identity,
          { ...identity, providerId: "bigmodel-api" },
          { ...identity, providerId: "account:bigmodel-individual-coding-plan" },
        ]),
        configuredDefaultModelSelection: complete,
        runtimeConfig: { workingDirectory: process.cwd() },
        modelExecutor: { generateText },
      });
      try {
        if (readFailure)
          vi.spyOn(store, "sessionEntries").mockRejectedValueOnce(
            new Error("Broken selection entry"),
          );
        const result = await app.resume();
        expect(result.messageCount).toBe(1);
        expect(result.modelSelection).toEqual(candidate);
        expect(app.runtime.getSessionModelSelection()).toEqual(bound);
        if ((stored as ModelSelection | undefined)?.providerId.startsWith("builtin:")) {
          expect(
            (await store.sessionEntries({ sessionID, type: SESSION_ENTRY_MODEL_SELECTION })).at(-1)
              ?.data,
          ).toEqual(candidate);
        }
        expect((await app.resume()).modelSelection).toEqual(readFailure ? undefined : candidate);
        expect(generateText).not.toHaveBeenCalled();
        expect(JSON.stringify(await app.loadSessionTranscript())).toContain(
          "History must remain visible",
        );

        await app.setModel(`${identity.providerId}/${identity.modelId}`);
        await app.setThoughtLevel("high");
        expect((await app.submitPrompt("Continue after choosing")).response).toBe("Continued");
        expect(generateText).toHaveBeenCalledOnce();
        expect(app.runtime.getSessionModelSelection()).toEqual(complete);
      } finally {
        await app.close();
        await fixture.dispose();
      }
    },
  );

  it("恢复选择在 Registry 中不可解析时不绑定，但必须留下 restore_unbound 告警", async () => {
    // 回归（2026-10-09 日志复盘）：冷恢复落在 Registry 刚就绪、账号权益未解析的窗口时，持久化选择按
    // provider-not-found 静默置空；之后只发加速轮不会再绑定，加速失败时找不到退回目标。此前这一步没有日志。
    const fixture = await createLegacySelectionStoreFixture();
    const { store } = fixture;
    const sessionID = createSessionId("app-unbound-resume-warn");
    const stored = { ...complete, providerId: "account:bigmodel-team-coding-plan" };
    await store.createSession({
      id: sessionID,
      projectID: createProjectId("app-unbound"),
      directory: process.cwd(),
      slug: "app-unbound-warn",
      title: "Restore warns",
      version: "test",
    });
    await store.saveSessionEntry({
      id: `${sessionID}:runtime-model-selection`,
      sessionID,
      type: SESSION_ENTRY_MODEL_SELECTION,
      touchSession: false,
      time: { created: 2, updated: 2 },
      data: stored,
    });
    const warn = vi.fn();
    const logger: Logger = { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn(), child: () => logger };
    const loggerFactory: LoggerFactory = {
      createLogger: () => logger,
      withContext: () => logger,
      setLevel: () => {},
    };
    const app = await createRegistryBackedTestApp({
      env: {},
      skipUserConfig: true,
      resume: true,
      sessionId: sessionID,
      sessionStore: store,
      loggerFactory,
      // Registry 里没有持久化选择指向的 provider（权益未解析时账号 provider 不发布）。
      providerRegistry: createTestProviderRegistry([identity]),
      configuredDefaultModelSelection: complete,
      runtimeConfig: { workingDirectory: process.cwd() },
    });
    try {
      const result = await app.resume();
      expect(result.modelSelection).toEqual(stored);
      expect(app.runtime.getSessionModelSelection()).toBeUndefined();
      expect(warn).toHaveBeenCalledWith(
        "Session model selection restored but not bound to the runtime",
        expect.objectContaining({
          event: "session.model_selection.restore_unbound",
          providerId: stored.providerId,
          modelId: stored.modelId,
          validationCode: "provider-not-found",
        }),
      );
    } finally {
      await app.close();
      await fixture.dispose();
    }
  });
});
