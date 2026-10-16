import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteSessionStore } from "@zcode/adapters/storage";
import { describe, expect, it, vi } from "vitest";
import {
  createRegistryBackedTestApp,
  createTestProviderRegistry,
} from "./helpers/registry-backed-test-app.js";

describe("Workflow 内显式 Subagent 的有效选择", () => {
  it.each(["yolo", "guarded"] as const)(
    "%s 的真实 Workflow child 调用 Agent 时继承公共解析端口",
    async (mode) => {
      const root = await mkdtemp(join(tmpdir(), "zcode-workflow-selection-"));
      const store = createSqliteSessionStore({ dbPath: ":memory:" });
      const parent = {
        providerId: "parent",
        modelId: "model",
        options: { reasoningLevel: "high" },
      };
      const original = {
        providerId: "old-account",
        modelId: "model",
        options: { reasoningLevel: "high" },
      };
      const effective = { ...original, providerId: "new-account" };
      const resolve = vi.fn(() => ({ effectiveSelection: effective }));
      const executed: string[] = [];
      let requestedChild = false;
      const app = await createRegistryBackedTestApp({
        env: { ZCODE_HOME: root },
        skipUserConfig: true,
        sessionStore: store,
        providerRegistry: createTestProviderRegistry([parent, effective]),
        resolveEffectiveModelSelection: resolve,
        runtimeConfig: {
          mode,
          workingDirectory: root,
          mcp: { enabled: false },
          modelSelection: parent,
          subagents: {
            profiles: [
              {
                name: "researcher",
                description: "Research",
                source: "user",
                tools: ["Read"],
                systemPrompt: "Return a result.",
                modelSelection: original,
              },
            ],
          },
        },
        modelExecutor: {
          async generateText(_request, execution) {
            executed.push(execution.providerId);
            const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
            if (!requestedChild) {
              requestedChild = true;
              return {
                finishReason: "tool-calls",
                text: "",
                usage,
                toolCalls: [
                  {
                    id: "workflow-research",
                    name: "Agent",
                    input: {
                      description: "Research",
                      prompt: "Research",
                      subagent_type: "researcher",
                    },
                  },
                ],
              };
            }
            return {
              finishReason: "stop",
              text: JSON.stringify({ reasoning: "ok", verdict: "pass" }),
              usage,
            };
          },
        },
      });
      try {
        await app.runExpertWorkflow({ task: "Research with the researcher." });
        expect(resolve).toHaveBeenCalledWith(original);
        expect(executed).toContain("new-account");
        expect(executed).not.toContain("old-account");
        expect(original.providerId).toBe("old-account");
        expect(app.runtime.getSessionModelSelection()).toEqual(parent);
        expect(app.runtime.getMode()).toBe(mode);
      } finally {
        await app.close?.();
        store.close();
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});
