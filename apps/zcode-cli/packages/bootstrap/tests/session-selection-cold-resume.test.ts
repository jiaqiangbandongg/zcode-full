import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteSessionStore } from "@zcode/adapters/storage";
import { describe, expect, it } from "vitest";
import {
  createRegistryBackedTestApp,
  createTestProviderRegistry,
} from "./helpers/registry-backed-test-app.js";

describe("Session 完整选择的实际保存与冷恢复", () => {
  it.each(["guarded", "yolo"] as const)(
    "%s 与完整选择落 SQLite；新 App 冷恢复不降级",
    async (mode) => {
      const root = await mkdtemp(join(tmpdir(), "zcode-selection-resume-"));
      const dbPath = join(root, "sessions.sqlite");
      const initial = {
        providerId: "provider-a",
        modelId: "model-a",
        options: { reasoningLevel: "low" },
      };
      const selected = {
        providerId: "provider-b",
        modelId: "model-b",
        options: { reasoningLevel: "high" },
      };
      const registry = createTestProviderRegistry([initial, selected]);
      const executions: Array<{ providerId: string; modelId: string; reasoningLevel: unknown }> =
        [];
      const common = {
        env: { ZCODE_HOME: root },
        skipUserConfig: true,
        providerRegistry: registry,
        runtimeConfig: { workingDirectory: root, mcp: { enabled: false }, modelSelection: initial },
        modelExecutor: {
          async generateText(
            request: import("@zcode/contracts").ModelRequest,
            execution: { providerId: string; modelId: string },
          ) {
            executions.push({ ...execution, reasoningLevel: request.options?.reasoningLevel });
            return {
              finishReason: "stop" as const,
              text: "done",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            };
          },
        },
      };
      let store = createSqliteSessionStore({ dbPath });
      let app = await createRegistryBackedTestApp({ ...common, sessionStore: store });
      try {
        const sessionId = app.sessionId;
        // Bot /model 操作的是已创建的 Session，不是尚未 materialize 的草稿 App。
        await app.runtime.executeTurn("Create the bound Session.");
        executions.length = 0;
        await app.setModel(selected);
        await app.setMode(mode);
        expect(app.getMode()).toBe(mode);
        expect(app.runtime.getSessionModelSelection()).toEqual(selected);
        await expect(
          app.setModel({ ...initial, options: { reasoningLevel: "invalid" } }),
        ).rejects.toThrow();
        expect(app.runtime.getSessionModelSelection()).toEqual(selected);
        await app.close?.();
        store.close();
        store = createSqliteSessionStore({ dbPath });
        app = await createRegistryBackedTestApp({
          ...common,
          sessionStore: store,
          sessionId,
          resume: true,
        });
        await app.resume();
        expect(app.getMode()).toBe(mode);
        expect(app.runtime.getSessionModelSelection()).toEqual(selected);
        await app.runtime.executeTurn("E2E_W99_SAVED_SELECTION_REQUEST");
        expect(executions).toEqual([
          { providerId: selected.providerId, modelId: selected.modelId, reasoningLevel: "high" },
        ]);
      } finally {
        await app.close?.();
        store.close();
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});
