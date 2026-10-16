import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  clearAppData,
  getE2EAppDataPaths,
} from "../../../helpers/desktop-app.js";
import {
  getPluginReferenceCatalog,
  restartPluginLifecycleApp,
} from "../../../helpers/plugin-management-lifecycle.js";
import {
  captureArtifactAdvertisesToolName,
  findUpstreamRequestContaining,
  PLUGIN_MCP_PLUGIN_ID,
  PLUGIN_MCP_TOOL_NAME,
} from "../../../helpers/plugin-mcp-skill.js";
import {
  getToolCallBlockByToolName,
  prepareConversationE2E,
  selectTaskById,
  sendPrompt,
  startNewTask,
  waitForAssistantMessageContaining,
  waitForUpstreamRequestContaining,
} from "../../../helpers/conversation-session.js";
import {
  ensureToolCrossProductFullAccessMode,
  respondToToolCrossProductBlockers,
} from "../../../helpers/conversation-session-tool-cross-product.js";
import { getV4PaneSnapshot } from "../../../helpers/v4-conversation.js";

const RESIDENT_MARKER = "E2E_WPL_008_RESIDENT_ENABLED";
const NEW_SESSION_MARKER = "E2E_WPL_008_NEW_SESSION_DISABLED";
const COLD_RESUME_MARKER = "E2E_WPL_008_COLD_RESUME_DISABLED";
const RESIDENT_REPLY = "wpl-008-resident-ok";
const NEW_SESSION_REPLY = "wpl-008-new-session-ok";
const COLD_RESUME_REPLY = "wpl-008-cold-resume-ok";

describe("WPL-008 Workspace Plugin resident freeze and cold resume E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("freezes resident S1, reloads new S2, and cold-resumes S1 with the new config", async function () {
    this.timeout(300000);

    await prepareConversationE2E();
    await ensureToolCrossProductFullAccessMode();
    await startNewTask();
    await sendPrompt(
      `${RESIDENT_MARKER}: Call ${PLUGIN_MCP_TOOL_NAME} exactly once, then reply with exactly ${RESIDENT_REPLY}.`,
    );
    await assertPluginToolAdvertisementAndCompletion(RESIDENT_MARKER, RESIDENT_REPLY);

    const residentSessionId = (await getV4PaneSnapshot()).sessionId;
    expect(residentSessionId).not.toBeNull();
    if (!residentSessionId) return;

    const residentCatalog = await getPluginReferenceCatalog({ sessionId: residentSessionId });
    expect(residentCatalog.authority).toBe("session");
    expectPluginCatalogState(residentCatalog.plugins, true);

    await disableWorkspacePlugin();

    const workspaceCatalog = await getPluginReferenceCatalog();
    expect(workspaceCatalog.authority).toBe("workspace");
    expectPluginCatalogState(workspaceCatalog.plugins, false);

    // 同一个 resident App 的 Session-owned catalog 不热加载新配置。
    const stillResidentCatalog = await getPluginReferenceCatalog({ sessionId: residentSessionId });
    expectPluginCatalogState(stillResidentCatalog.plugins, true);

    await startNewTask();
    await sendPrompt(
      `${NEW_SESSION_MARKER}: Do not call tools; reply with exactly ${NEW_SESSION_REPLY}.`,
    );
    await assertPluginToolNotAdvertised(NEW_SESSION_MARKER);
    await waitForAssistantMessageContaining(NEW_SESSION_REPLY);

    // 完整重启 Desktop/Host/CLI 后再打开 S1，证明 cold resume 重建 App 时读取当前 Workspace 配置。
    await restartPluginLifecycleApp();
    await selectTaskById(residentSessionId);
    await browser.waitUntil(
      async () => (await getV4PaneSnapshot()).sessionId === residentSessionId,
      { timeout: 60000, timeoutMsg: `S1 没有在 cold resume 后恢复: ${residentSessionId}` },
    );
    const coldCatalog = await waitForSessionPluginReferenceCatalog(residentSessionId);
    expect(coldCatalog.authority).toBe("session");
    expectPluginCatalogState(coldCatalog.plugins, false);

    await sendPrompt(
      `${COLD_RESUME_MARKER}: Do not call tools; reply with exactly ${COLD_RESUME_REPLY}.`,
    );
    await assertPluginToolNotAdvertised(COLD_RESUME_MARKER);
    await waitForAssistantMessageContaining(COLD_RESUME_REPLY);
  });
});

async function disableWorkspacePlugin(): Promise<void> {
  const { workspace } = getE2EAppDataPaths();
  const configPath = join(workspace, ".zcode", "config.json");
  const config = JSON.parse(await readFile(configPath, "utf8")) as {
    plugins?: { enabledPlugins?: Record<string, boolean> };
  };
  await writeFile(
    configPath,
    `${JSON.stringify(
      {
        ...config,
        plugins: {
          ...config.plugins,
          enabledPlugins: {
            ...config.plugins?.enabledPlugins,
            [PLUGIN_MCP_PLUGIN_ID]: false,
          },
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

async function assertPluginToolAdvertisementAndCompletion(
  marker: string,
  expectedReply: string,
): Promise<void> {
  await waitForUpstreamRequestContaining(marker, 60000);
  const requestRecord = await findUpstreamRequestContaining(marker, 60000, {
    advertisedToolName: PLUGIN_MCP_TOOL_NAME,
  });
  expect(requestRecord).not.toBeNull();
  if (!requestRecord) return;
  expect(captureArtifactAdvertisesToolName(requestRecord.requestJson, PLUGIN_MCP_TOOL_NAME)).toBe(
    true,
  );
  await browser.waitUntil(
    async () => {
      await respondToToolCrossProductBlockers();
      return Boolean((await getToolCallBlockByToolName(PLUGIN_MCP_TOOL_NAME))?.exists);
    },
    { timeout: 60000, timeoutMsg: `WPL-008 工具调用没有出现: ${marker}` },
  );
  await waitForAssistantMessageContaining(expectedReply);
}

function expectPluginCatalogState(
  plugins: Awaited<ReturnType<typeof getPluginReferenceCatalog>>["plugins"],
  enabled: boolean,
): void {
  const plugin = plugins.find((entry) => entry.pluginId === PLUGIN_MCP_PLUGIN_ID);
  expect(plugin).toBeDefined();
  expect(plugin?.enabled).toBe(enabled);
  if (!enabled) {
    expect(plugin?.mcpServerNames).toEqual([]);
  }
}

async function waitForSessionPluginReferenceCatalog(
  sessionId: string,
): Promise<Awaited<ReturnType<typeof getPluginReferenceCatalog>>> {
  let catalog: Awaited<ReturnType<typeof getPluginReferenceCatalog>> | undefined;
  await browser.waitUntil(
    async () => {
      try {
        catalog = await getPluginReferenceCatalog({ sessionId });
        return true;
      } catch (error) {
        // cold resume 时 Renderer 会先恢复选中态，CLI App 随后才完成 session/resume；
        // 只把这个明确的暂态当作未就绪，其他协议错误立即暴露。
        if (error instanceof Error && error.message.includes(`Session is not active: ${sessionId}`)) {
          return false;
        }
        throw error;
      }
    },
    {
      interval: 250,
      timeout: 60000,
      timeoutMsg: `S1 cold resume 后 Plugin catalog 没有就绪: ${sessionId}`,
    },
  );
  if (!catalog) throw new Error(`S1 cold resume 后缺少 Plugin catalog: ${sessionId}`);
  return catalog;
}

async function assertPluginToolNotAdvertised(marker: string): Promise<void> {
  await waitForUpstreamRequestContaining(marker, 60000);
  const requestRecord = await findUpstreamRequestContaining(marker, 60000);
  expect(requestRecord).not.toBeNull();
  if (!requestRecord) return;
  expect(captureArtifactAdvertisesToolName(requestRecord.requestJson, PLUGIN_MCP_TOOL_NAME)).toBe(
    false,
  );
}
