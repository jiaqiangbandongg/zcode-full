import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  E2E_REPLY_TOKEN,
  getToolCallBlockByToolName,
  prepareConversationE2E,
  sendPrompt,
  startNewTask,
  waitForAssistantMessageContaining,
  waitForUpstreamRequestContaining,
} from "./conversation-session.js";
import {
  ensureToolCrossProductFullAccessMode,
  respondToToolCrossProductBlockers,
} from "./conversation-session-tool-cross-product.js";
import {
  captureArtifactAdvertisesToolName,
  findUpstreamRequestContaining,
  PLUGIN_MCP_PLUGIN_ID,
  PLUGIN_MCP_TOOL_NAME,
} from "./plugin-mcp-skill.js";
import { getE2EAppDataPaths } from "./desktop-app.js";

export async function readWorkspacePluginConfig(): Promise<Record<string, unknown>> {
  const { workspace } = getE2EAppDataPaths();
  return JSON.parse(await readFile(join(workspace, ".zcode", "config.json"), "utf8")) as Record<string, unknown>;
}

export async function readUserPluginConfig(): Promise<Record<string, unknown>> {
  const { storageRoot } = getE2EAppDataPaths();
  return JSON.parse(await readFile(join(storageRoot, "cli", "config.json"), "utf8")) as Record<string, unknown>;
}

export async function assertWorkspacePluginRuntime(marker: string): Promise<void> {
  await prepareConversationE2E();
  await ensureToolCrossProductFullAccessMode();
  await startNewTask();
  const prompt = `${marker}: Call ${PLUGIN_MCP_TOOL_NAME} exactly once, then reply with exactly ${E2E_REPLY_TOKEN}.`;
  await sendPrompt(prompt);
  await waitForUpstreamRequestContaining(marker, 60000);
  const requestRecord = await findUpstreamRequestContaining(marker, 60000, {
    advertisedToolName: PLUGIN_MCP_TOOL_NAME,
  });
  expect(requestRecord).not.toBeNull();
  if (!requestRecord) return;
  expect(captureArtifactAdvertisesToolName(requestRecord.requestJson, PLUGIN_MCP_TOOL_NAME)).toBe(true);

  await browser.waitUntil(
    async () => {
      await respondToToolCrossProductBlockers();
      return Boolean((await getToolCallBlockByToolName(PLUGIN_MCP_TOOL_NAME))?.exists);
    },
    { timeout: 60000, timeoutMsg: "Workspace Plugin MCP tool-call block did not render" },
  );
  await waitForAssistantMessageContaining(E2E_REPLY_TOKEN);
}

export async function assertWorkspacePluginUnavailable(marker: string): Promise<void> {
  await prepareConversationE2E();
  await ensureToolCrossProductFullAccessMode();
  await startNewTask();
  const prompt = `${marker}: do not call tools; reply with exactly ${E2E_REPLY_TOKEN}.`;
  await sendPrompt(prompt);
  await waitForUpstreamRequestContaining(marker, 60000);
  const requestRecord = await findUpstreamRequestContaining(marker, 60000);
  expect(requestRecord).not.toBeNull();
  if (!requestRecord) return;
  expect(captureArtifactAdvertisesToolName(requestRecord.requestJson, PLUGIN_MCP_TOOL_NAME)).toBe(false);
}

export function pluginConfigOptions(config: Record<string, unknown>): Record<string, unknown> {
  const plugins = config.plugins as Record<string, unknown> | undefined;
  const options = plugins?.options as Record<string, Record<string, unknown>> | undefined;
  return options?.[PLUGIN_MCP_PLUGIN_ID] ?? {};
}

export function pluginConfigEnabled(config: Record<string, unknown>): boolean | undefined {
  const plugins = config.plugins as Record<string, unknown> | undefined;
  const enabled = plugins?.enabledPlugins as Record<string, boolean> | undefined;
  return enabled?.[PLUGIN_MCP_PLUGIN_ID];
}
