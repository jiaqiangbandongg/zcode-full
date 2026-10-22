import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSqliteSessionStore } from "@zcode/adapters/storage";
import {
  createRegistryBackedTestApp,
  createTestProviderRegistry,
} from "./helpers/registry-backed-test-app.js";

describe("CLI 默认选择与 Session 续跑选择", () => {
  it("恢复已保存的 CLI 默认，忽略后来改变的全局默认与未持久化的闲时选择", async () => {
    const root = await mkdtemp(join(tmpdir(), "cli-default-resume-"));
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
    const idle = {
      providerId: "idle-provider",
      modelId: "idle-model",
      options: { reasoningLevel: "low" },
    };
    const common = {
      env: { ZCODE_HOME: root },
      skipUserConfig: true,
      modelSelectionMode: "cli-default" as const,
      providerRegistry: createTestProviderRegistry([initial, selected, idle]),
      runtimeConfig: { workingDirectory: root, mcp: { enabled: false } },
      modelExecutor: {
        async generateText() {
          return {
            finishReason: "stop" as const,
            text: "done",
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          };
        },
      },
    };
    let store = await createSqliteSessionStore({ dbPath: join(root, "sessions.sqlite") });
    let app = await createRegistryBackedTestApp({
      ...common,
      sessionStore: store,
      configuredDefaultModelSelection: initial,
    });
    try {
      await app.submitPrompt("Create session");
      const sessionId = app.sessionId;
      await app.setModel(selected);
      app.runtime.setSessionModelSelection(idle);
      await app.close?.();
      store.close();
      store = await createSqliteSessionStore({ dbPath: join(root, "sessions.sqlite") });
      app = await createRegistryBackedTestApp({
        ...common,
        sessionStore: store,
        sessionId,
        resume: true,
        configuredDefaultModelSelection: initial,
      });
      await app.resume();
      expect(app.getModel()).toBe("provider-b/model-b");
      expect(app.getThoughtLevel()).toBe("high");
      expect(app.runtime.getSessionModelSelection()).toEqual(selected);
    } finally {
      await app.close?.();
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("切换模型和档位不改变后台续跑，发送无显式选择的消息才采用 CLI 默认", async () => {
    const root = await mkdtemp(join(tmpdir(), "cli-default-selection-"));
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
    const idle = {
      providerId: "idle-provider",
      modelId: "idle-model",
      options: { reasoningLevel: "low" },
    };
    const requests: string[] = [];
    const app = await createRegistryBackedTestApp({
      env: { ZCODE_HOME: root },
      skipUserConfig: true,
      modelSelectionMode: "cli-default",
      providerRegistry: createTestProviderRegistry([initial, selected, idle]),
      runtimeConfig: { workingDirectory: root, mcp: { enabled: false }, modelSelection: initial },
      modelExecutor: {
        async generateText(request, execution) {
          requests.push(
            `${execution.providerId}/${execution.modelId}/${request.options?.reasoningLevel}`,
          );
          return {
            finishReason: "stop",
            text: "done",
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          };
        },
      },
    });
    try {
      await app.runtime.executeTurn("Create session");
      await app.setModel(selected);
      expect(app.runtime.getSessionModelSelection()).toEqual(initial);
      await app.setThoughtLevel("low");
      expect(app.runtime.getSessionModelSelection()).toEqual(initial);
      app.runtime.setSessionModelSelection(idle);
      expect(app.getModel()).toBe("provider-b/model-b");
      expect(app.getThoughtLevel()).toBe("low");
      requests.length = 0;
      await app.submitPrompt("Use the CLI default");
      expect(requests).toEqual(["provider-b/model-b/low"]);
      expect(app.runtime.getSessionModelSelection()).toEqual({
        ...selected,
        options: { reasoningLevel: "low" },
      });
    } finally {
      await app.close?.();
      await rm(root, { recursive: true, force: true });
    }
  });
});
