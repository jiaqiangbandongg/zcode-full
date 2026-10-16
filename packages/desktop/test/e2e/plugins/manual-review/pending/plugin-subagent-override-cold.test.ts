import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { clearAppData, readAgentsState } from "../../../helpers/desktop-app.js";
import {
  assertUpstreamRequestCapture,
  assertUpstreamThoughtLevelCapture,
} from "../../../helpers/upstream-capture.js";
import {
  UPSTREAM_MODEL,
  UPSTREAM_PROVIDER_ID,
  UPSTREAM_ALTERNATE_MODEL,
  UPSTREAM_ALTERNATE_PROVIDER_ID,
} from "../../../helpers/upstream-provider.js";
import { resolveE2EStorageRoot } from "../../../helpers/e2e-runtime-paths.js";
import {
  restartIntoWorkspacePreservingProfile,
  seedPersistedModelSelection,
} from "../../../helpers/model-provider-restart.js";
import type {
  E2ENetworkCaptureArtifact,
  E2ENetworkCaptureRecord,
} from "../../../helpers/network-capture-proxy.js";
import { requirePluginManualReview } from "../../../helpers/plugin-management-lifecycle.js";
import { waitForToolCallBlockByToolName } from "../../../helpers/conversation-session-tool.js";
import {
  prepareV4ConversationE2E,
  sendV4PromptAndWaitAccepted,
  waitForV4AssistantMessageContaining,
  waitForV4ConversationState,
} from "../../../helpers/v4-conversation.js";

const AGENT_ID = "plugin:document-skills@zcode-plugins-official:judge";
const PARENT = "E2E_PLUGIN_OVERRIDE_COLD_PARENT";
const CHILD = "E2E_PLUGIN_OVERRIDE_COLD_CHILD";
const RESULT = "E2E_PLUGIN_OVERRIDE_COLD_RESULT";
const FINAL = "plugin-override-cold-done";

describe("PLM-LC-020 插件 Subagent 覆盖冷启动请求", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("完整重启后 judge 使用已保存模型/high，父 continuation 保持原模型/max", async () => {
    requirePluginManualReview();
    await prepareV4ConversationE2E({ skipProvider: true });
    const selection = {
      providerId: UPSTREAM_ALTERNATE_PROVIDER_ID,
      modelId: UPSTREAM_ALTERNATE_MODEL,
      options: { reasoningLevel: "high" },
    };
    // SE-04 已验证 UI 保存；这里仅构造同格式测试副本，冷启动后不再调用设置服务。
    await writeFile(
      join(resolveE2EStorageRoot(), "v2", "agents-state.json"),
      JSON.stringify({
        ...(await readAgentsState()),
        pluginAgentModelSelectionOverrides: { [AGENT_ID]: selection },
      }),
    );
    await seedPersistedModelSelection({
      providerId: UPSTREAM_PROVIDER_ID,
      modelId: UPSTREAM_MODEL,
      reasoningLevel: "max",
    });
    await restartIntoWorkspacePreservingProfile();
    await prepareV4ConversationE2E({ skipProvider: true });
    await sendV4PromptAndWaitAccepted(
      `${PARENT}: Use Agent with subagent_type document-skills:judge, then report its result.`,
      PARENT,
      "插件覆盖冷启动消息未被接受",
    );
    await waitForV4AssistantMessageContaining(FINAL);
    await waitForV4ConversationState(
      (snapshot) => snapshot.state === "idle" && snapshot.queueCount === 0,
      "插件执行后未回到 idle",
      30_000,
    );
    expect((await waitForToolCallBlockByToolName("Agent")).status).toBe("completed");

    const capturePath = process.env.E2E_PROVIDER_CAPTURE_PATH;
    if (!capturePath) throw new Error("缺少插件请求 capture 文件路径");
    const capture = JSON.parse(await readFile(capturePath, "utf8")) as E2ENetworkCaptureArtifact;
    // 不能只搜整份请求：父 continuation 也包含 child prompt；按最新 user block 的类型区分。
    const child = capture.records.find((record) => latestUserContains(record, "text", CHILD));
    const parent = capture.records.find((record) =>
      latestUserContains(record, "tool_result", RESULT),
    );
    if (!child || !parent) throw new Error("缺少独立 child 或父 tool_result continuation 请求");
    assertUpstreamRequestCapture(child, { expectedText: CHILD, model: UPSTREAM_ALTERNATE_MODEL });
    assertUpstreamThoughtLevelCapture(child, "high");
    assertUpstreamRequestCapture(parent, { expectedText: RESULT, model: UPSTREAM_MODEL });
    assertUpstreamThoughtLevelCapture(parent, "max");
    expect((await readAgentsState()).pluginAgentModelSelectionOverrides).toEqual({
      [AGENT_ID]: selection,
    });
  });
});

function latestUserContains(
  record: E2ENetworkCaptureRecord,
  type: string,
  marker: string,
): boolean {
  if (record.method !== "POST" || record.status !== "complete") return false;
  const request = record.requestJson as { messages?: Array<{ role?: string; content?: unknown }> };
  const content = request?.messages?.findLast((message) => message.role === "user")?.content;
  return (
    Array.isArray(content) &&
    content.some((part) => part?.type === type && JSON.stringify(part).includes(marker))
  );
}
