import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSqliteSessionStore } from "@zcode/adapters/storage";
import {
  CREATE_WORKFLOW_TOOL_NAME,
  SESSION_ENTRY_DYNAMIC_WORKFLOW_ACTIVATION,
  type ModelRequest,
} from "@zcode/contracts";
import { createRegistryBackedTestApp as createZCodeApp } from "./helpers/registry-backed-test-app.js";

// DWG-09 的装配层一半（docs/dynamic-workflow/launch.md「On demand: activation」）：`/workflow` 的展开处
// （create-app.ts 的 builtin prompt resolver）就是激活点，先于 executeTurn，所以敲命令那一轮的首个模型
// 请求就带着十个工具；prose 请求不是触发器。

function toolNames(request: ModelRequest | undefined): string[] {
  return (request?.tools ?? []).map((tool) => tool.name);
}

async function withApp(
  runtimeConfig: Record<string, unknown>,
  run: (input: {
    app: Awaited<ReturnType<typeof createZCodeApp>>;
    requests: ModelRequest[];
    sessionStore: ReturnType<typeof createSqliteSessionStore>;
  }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "zcode-dwf-on-demand-"));
  const sessionStore = createSqliteSessionStore({ dbPath: ":memory:" });
  const requests: ModelRequest[] = [];
  try {
    const app = await createZCodeApp({
      env: {},
      modelExecutor: {
        async generateText(request) {
          requests.push(request);
          return {
            finishReason: "stop",
            text: "ok",
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          } as never;
        },
      },
      runtimeConfig: { workingDirectory: root, ...runtimeConfig },
      sessionStore,
      skipUserConfig: true,
    });
    try {
      await run({ app, requests, sessionStore });
    } finally {
      await app.close();
    }
  } finally {
    sessionStore.close();
    await rm(root, { force: true, recursive: true });
  }
}

describe("onDemand：`/workflow` 经输入门面激活工具面（DWG-09）", () => {
  it("激活前没有工作流工具，prose 请求不激活；`/workflow` 那一轮的首个请求就带上，并落 entry", async () => {
    await withApp(
      { dynamicWorkflowEnabled: true, dynamicWorkflowToolsOnDemand: true },
      async ({ app, requests, sessionStore }) => {
        await app.submitPrompt("hello");
        expect(toolNames(requests.at(-1))).not.toContain(CREATE_WORKFLOW_TOOL_NAME);
        // 反向断言：普通工具面完整，只差工作流那十个。
        expect(toolNames(requests.at(-1))).toContain("Read");

        await app.submitPrompt("use a workflow to ship it");
        expect(toolNames(requests.at(-1))).not.toContain(CREATE_WORKFLOW_TOOL_NAME);

        await app.submitPrompt("/workflow ship it");
        const workflowRequest = requests.at(-1);
        expect(toolNames(workflowRequest)).toContain(CREATE_WORKFLOW_TOOL_NAME);
        // 展开后的命令正文到了模型手里（不是原文 "/workflow ship it" 当普通 prompt）。
        expect(JSON.stringify(workflowRequest)).toContain("Required skills");
        expect(JSON.stringify(workflowRequest)).toContain("ship it");

        const entries = await sessionStore.sessionEntries?.({
          sessionID: app.sessionId,
          type: SESSION_ENTRY_DYNAMIC_WORKFLOW_ACTIVATION,
        });
        expect(entries).toHaveLength(1);
        expect(entries?.[0]?.data).toEqual({ activated: true, source: "command" });

        // 之后的轮次保持。
        await app.submitPrompt("thanks");
        expect(toolNames(requests.at(-1))).toContain(CREATE_WORKFLOW_TOOL_NAME);
      },
    );
  });

  it("首轮就是 `/workflow`：激活先于会话落盘，entry 由首次持久化补写", async () => {
    await withApp(
      { dynamicWorkflowEnabled: true, dynamicWorkflowToolsOnDemand: true },
      async ({ app, requests, sessionStore }) => {
        await app.submitPrompt("/workflow ship it");
        expect(toolNames(requests.at(-1))).toContain(CREATE_WORKFLOW_TOOL_NAME);
        const entries = await sessionStore.sessionEntries?.({
          sessionID: app.sessionId,
          type: SESSION_ENTRY_DYNAMIC_WORKFLOW_ACTIVATION,
        });
        expect(entries).toHaveLength(1);
      },
    );
  });

  it("alwaysOn（只有布尔）从首个请求起就带工具，且不写激活 entry", async () => {
    await withApp({ dynamicWorkflowEnabled: true }, async ({ app, requests, sessionStore }) => {
      await app.submitPrompt("hello");
      expect(toolNames(requests.at(-1))).toContain(CREATE_WORKFLOW_TOOL_NAME);
      const entries = await sessionStore.sessionEntries?.({
        sessionID: app.sessionId,
        type: SESSION_ENTRY_DYNAMIC_WORKFLOW_ACTIVATION,
      });
      expect(entries ?? []).toHaveLength(0);
    });
  });
});
