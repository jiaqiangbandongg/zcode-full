import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createSqliteSessionStore } from "@zcode/adapters/storage";
import type { PermissionBrokerRequest } from "@zcode/contracts";
import {
  createRegistryBackedTestApp,
  createTestProviderRegistry,
} from "./helpers/registry-backed-test-app.js";

describe("guarded workflow runtime ingress", () => {
  it.each(["expert", "script"] as const)(
    "%s child stays YOLO while its parent remains guarded",
    async (kind) => {
      const root = await mkdtemp(join(tmpdir(), "guarded-workflow-"));
      const store = createSqliteSessionStore({ dbPath: ":memory:" });
      const selection = {
        providerId: "parent",
        modelId: "model",
        options: { reasoningLevel: "high" },
      };
      const requests: PermissionBrokerRequest[] = [];
      const modelRequests: string[] = [];
      const execute = vi.fn(async () => ({
        status: "completed" as const,
        stdout: { text: "controlled execution", bytes: 20, truncated: false },
        stderr: { text: "", bytes: 0, truncated: false },
        exitCode: 0,
        durationMs: 1,
        timedOut: false,
        cancelled: false,
        startedAt: new Date(),
        completedAt: new Date(),
      }));
      let sent = false;
      const app = await createRegistryBackedTestApp({
        env: { ZCODE_HOME: root },
        skipUserConfig: true,
        sessionStore: store,
        providerRegistry: createTestProviderRegistry([selection]),
        executionPort: { run: execute },
        permissionBroker: {
          requestPermission: async (request) => {
            requests.push(request);
            return { decision: "deny", reason: "guarded fixture denial" };
          },
        },
        runtimeConfig: {
          mode: "guarded",
          workingDirectory: root,
          mcp: { enabled: false },
          modelSelection: selection,
        },
        modelExecutor: {
          async generateText(request) {
            modelRequests.push(JSON.stringify(request));
            const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
            if (!sent) {
              sent = true;
              return {
                finishReason: "tool-calls",
                text: "",
                usage,
                toolCalls: [
                  {
                    id: "guarded-workflow-rm",
                    name: "Bash",
                    input: { command: "rm -rf fixture-only" },
                  },
                ],
              };
            }
            return {
              finishReason: "stop",
              usage,
              text: JSON.stringify({
                done: true,
                reasoning: "controlled execution completed",
                verdict: "pass",
              }),
            };
          },
        },
      });
      try {
        if (kind === "script") {
          const scriptPath = join(root, "guarded.workflow.js");
          await writeFile(
            scriptPath,
            'export const meta = { name: "guarded", description: "guarded test", phases: [{ title: "Run" }] }; phase("Run"); return await agent("Run the fixture command.");',
          );
          await app.runWorkflowScript?.({ scriptPath });
        } else {
          await app.runExpertWorkflow({ task: "Run the fixture command." });
        }
        expect(requests).toHaveLength(0);
        expect(execute).toHaveBeenCalledTimes(1);
        expect(modelRequests.some((request) => request.includes("controlled execution"))).toBe(
          true,
        );
        expect(app.runtime.getMode()).toBe("guarded");
        // 子任务的 YOLO 不得污染父任务：随后父任务同一命令仍必须得到拒绝结果。
        sent = false;
        await app.runtime.executeTurn("Run the fixture command in the parent.");
        expect(requests).toHaveLength(1);
        expect(requests[0]?.approvalMode).toBe("user-once");
        expect(execute).toHaveBeenCalledTimes(1);
        expect(modelRequests.some((request) => request.includes("guarded fixture denial"))).toBe(
          true,
        );
      } finally {
        await app.close?.();
        store.close();
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});
