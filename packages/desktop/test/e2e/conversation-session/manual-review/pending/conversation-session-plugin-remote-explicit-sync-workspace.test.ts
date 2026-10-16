import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import { join, posix } from "node:path";
import { TID_WORKSPACE_HEADER, TID_WORKSPACE_MORE_BUTTON, TID_WORKSPACE_PATH } from "@zcode/shared";
import { clearAppData, getE2EAppDataPaths } from "../../../helpers/desktop-app.js";
import {
  addMarketplaceSourceThroughAgent,
  createPluginLifecycleFixture,
  getPluginOverview,
  getPluginList,
  installMarketplacePluginThroughAgent,
  PLUGIN_LIFECYCLE_ID,
  PLUGIN_LIFECYCLE_MARKETPLACE_ID,
  PLUGIN_LIFECYCLE_MCP_TOOL_NAME,
  PLUGIN_LIFECYCLE_NAME,
  PLUGIN_LIFECYCLE_RUNTIME_MARKER,
  pluginStoragePath,
} from "../../../helpers/plugin-management-lifecycle.js";
import {
  getUpstreamRequestRecordCount,
  getUpstreamRequestToolNames,
  waitForUpstreamRequest,
} from "../../../helpers/conversation-session-network.js";
import { waitForToolCallBlockByToolName } from "../../../helpers/conversation-session-tool.js";
import {
  ensureToolCrossProductFullAccessMode,
  respondToToolCrossProductBlockers,
} from "../../../helpers/conversation-session-tool-cross-product.js";
import {
  connectSSHWorkspaceAndSendFirstTurn,
  createSSHLifecycleProvider,
  type SSHLifecycleProvider,
} from "../../../helpers/ssh-remote-lifecycle.js";
import {
  readSingleSSHWorkspaceRuntimeConfig,
  runSSHCommand,
  type SSHConnectionConfig,
} from "../../../helpers/ssh-remote-p0.js";
import {
  prepareV4ConversationE2E,
  sendV4PromptAndWaitAccepted,
  startNewV4Draft,
  waitForV4AssistantMessageContaining,
} from "../../../helpers/v4-conversation.js";

const CASE_MARKER = "E2E_WPL_011_REMOTE_EXPLICIT_SYNC";
const RUNTIME_MARKER = `${PLUGIN_LIFECYCLE_RUNTIME_MARKER}_1.0.0`;
const RUNTIME_PROMPT = `${CASE_MARKER}_RUNTIME_PROMPT`;
const RUNTIME_REPLY = "WPL_011_REMOTE_EXPLICIT_SYNC_REPLY";

describe("WPL-011 remote Workspace Plugin explicit sync E2E", () => {
  let provider: SSHLifecycleProvider | null = null;
  let target: SSHConnectionConfig | null = null;
  let workspacePath = "";

  after(async () => {
    await provider?.tunnel.close().catch(() => undefined);
    if (target && workspacePath) {
      await cleanupRemoteWorkspace(target, workspacePath).catch(() => undefined);
    }
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("does not copy a local package on connect, then materializes it only through Sync Plugin", async function () {
    this.timeout(45 * 60_000);

    const remote = readSingleSSHWorkspaceRuntimeConfig(CASE_MARKER);
    target = remote;
    workspacePath = remote.workspacePath;
    await seedRemoteWorkspace(target, workspacePath);

    await prepareV4ConversationE2E({ skipProvider: true });
    await ensureToolCrossProductFullAccessMode();

    const fixture = await createPluginLifecycleFixture("1.0.0");
    await addMarketplaceSourceThroughAgent(fixture.marketplaceRoot);
    await installMarketplacePluginThroughAgent(
      PLUGIN_LIFECYCLE_NAME,
      PLUGIN_LIFECYCLE_MARKETPLACE_ID,
    );
    const localOverview = await getPluginOverview();
    expect(localOverview.installedPlugins).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: PLUGIN_LIFECYCLE_ID,
          scope: "user",
          version: "1.0.0",
        }),
      ]),
    );

    const localConfigPath = join(getE2EAppDataPaths().storageRoot, "cli", "config.json");
    const localInstalledPath = pluginStoragePath("installed_plugins.json");
    const localConfigBefore = await readFile(localConfigPath, "utf8");
    const localInstalledBefore = await readFile(localInstalledPath, "utf8");
    const workspaceConfigBefore = await readRemoteFile(
      target,
      posix.join(workspacePath, ".zcode", "config.json"),
    );

    provider = await createSSHLifecycleProvider(target, CASE_MARKER);
    const task = await connectSSHWorkspaceAndSendFirstTurn({
      caseMarker: CASE_MARKER,
      config: target,
      label: "A",
      provider,
      workspacePath,
    });

    expect(
      await getUpstreamRequestToolNames({
        lastUserMessageIncludes: [task.firstPrompt],
      }),
    ).not.toContain(PLUGIN_LIFECYCLE_MCP_TOOL_NAME);
    expect(await readRemotePluginStorageState(target)).toEqual({
      cacheContainsPlugin: false,
      installedContainsPlugin: false,
      marketplaceContainsPlugin: false,
    });
    const missingRemotePlugin = (await getPluginList(workspacePath, task.identity)).plugins.find(
      (plugin) => plugin.id === PLUGIN_LIFECYCLE_ID,
    );
    expect(missingRemotePlugin).toMatchObject({
      enabled: true,
      enabledSource: "workspace",
      id: PLUGIN_LIFECYCLE_ID,
      packageStatus: "missing",
      source: "missing",
    });
    expect(await readRemoteFile(target, posix.join(workspacePath, ".zcode", "config.json"))).toBe(
      workspaceConfigBefore,
    );

    await openRemotePluginSyncDialog(workspacePath);
    await waitForRemotePluginCandidate(`marketplace:${PLUGIN_LIFECYCLE_ID}`);
    await startRemotePluginSync();
    await waitForRemotePluginSyncComplete();

    await browser.waitUntil(
      async () => {
        const state = await readRemotePluginStorageState(target!);
        return (
          state.cacheContainsPlugin &&
          state.installedContainsPlugin &&
          state.marketplaceContainsPlugin
        );
      },
      {
        timeout: 180_000,
        timeoutMsg: `${CASE_MARKER}: 显式同步完成后 remote package/cache 没有物化`,
      },
    );
    expect(await readRemoteFile(target, posix.join(workspacePath, ".zcode", "config.json"))).toBe(
      workspaceConfigBefore,
    );
    expect(await readFile(localConfigPath, "utf8")).toBe(localConfigBefore);
    expect(await readFile(localInstalledPath, "utf8")).toBe(localInstalledBefore);

    await browser.waitUntil(
      async () =>
        (await getPluginList(workspacePath, task.identity)).plugins.some(
          (plugin) =>
            plugin.id === PLUGIN_LIFECYCLE_ID &&
            plugin.enabled &&
            plugin.enabledSource === "workspace",
        ),
      {
        timeout: 120_000,
        timeoutMsg: `${CASE_MARKER}: remote Plugin list 没有刷新为 Workspace enabled`,
      },
    );

    await startNewV4Draft();
    const requestStart = await getUpstreamRequestRecordCount();
    await sendV4PromptAndWaitAccepted(
      `${RUNTIME_PROMPT}: Call ${PLUGIN_LIFECYCLE_MCP_TOOL_NAME} exactly once, then reply with exactly ${RUNTIME_REPLY}.`,
      RUNTIME_PROMPT,
      `${CASE_MARKER}: 显式同步后的 remote 新 Session prompt 没有被接受`,
    );
    await waitForUpstreamRequest(
      {
        includes: [RUNTIME_MARKER],
        lastUserMessageIncludes: [RUNTIME_PROMPT],
      },
      `${CASE_MARKER}: 显式同步后的 remote 新 Session 没有暴露 Plugin MCP`,
      120_000,
      { afterIndex: requestStart - 1 },
    );
    expect(
      await getUpstreamRequestToolNames({
        lastUserMessageIncludes: [RUNTIME_PROMPT],
      }),
    ).toContain(PLUGIN_LIFECYCLE_MCP_TOOL_NAME);
    await browser.waitUntil(
      async () => {
        await respondToToolCrossProductBlockers();
        return Boolean(
          await waitForToolCallBlockByToolName(PLUGIN_LIFECYCLE_MCP_TOOL_NAME, 2_000).catch(
            () => null,
          ),
        );
      },
      {
        timeout: 120_000,
        timeoutMsg: `${CASE_MARKER}: Plugin MCP tool-call block 没有出现`,
      },
    );
    await waitForV4AssistantMessageContaining(RUNTIME_REPLY, 120_000);
  });
});

async function seedRemoteWorkspace(
  target: SSHConnectionConfig,
  workspacePath: string,
): Promise<void> {
  if (workspacePath !== "/root/workspace") {
    throw new Error(`${CASE_MARKER}: refusing to reset unexpected remote path ${workspacePath}`);
  }
  const config = {
    plugins: {
      enabledPlugins: {
        [PLUGIN_LIFECYCLE_ID]: true,
      },
    },
  };
  const command = [
    "set -eu",
    `rm -rf -- /root/.zcode ${quoteShell(workspacePath)}`,
    `mkdir -p -- ${quoteShell(posix.join(workspacePath, ".zcode"))}`,
    writeBase64Command(
      posix.join(workspacePath, ".zcode", "config.json"),
      `${JSON.stringify(config, null, 2)}\n`,
    ),
  ].join(" && ");
  const result = await runSSHCommand(target, command);
  expect(result.code).toBe(0);
  expect(result.stderr).toBe("");
}

async function cleanupRemoteWorkspace(
  target: SSHConnectionConfig,
  workspacePath: string,
): Promise<void> {
  if (workspacePath !== "/root/workspace") {
    throw new Error(`${CASE_MARKER}: refusing to clean unexpected remote path ${workspacePath}`);
  }
  await runSSHCommand(target, `rm -rf -- ${quoteShell(workspacePath)}`);
}

async function readRemotePluginStorageState(target: SSHConnectionConfig): Promise<{
  cacheContainsPlugin: boolean;
  installedContainsPlugin: boolean;
  marketplaceContainsPlugin: boolean;
}> {
  const command = [
    "installed=false",
    `if test -f "$HOME/.zcode/cli/plugins/installed_plugins.json" && grep -Fq -- ${quoteShell(PLUGIN_LIFECYCLE_ID)} "$HOME/.zcode/cli/plugins/installed_plugins.json"; then installed=true; fi`,
    "cached=false",
    `if test -d "$HOME/.zcode/cli/plugins/cache" && find "$HOME/.zcode/cli/plugins/cache" -path ${quoteShell(`*${PLUGIN_LIFECYCLE_NAME}*`)} -print -quit | grep -q .; then cached=true; fi`,
    "marketplace=false",
    `if test -f "$HOME/.zcode/cli/plugins/known_marketplaces.json" && grep -Fq -- ${quoteShell(PLUGIN_LIFECYCLE_MARKETPLACE_ID)} "$HOME/.zcode/cli/plugins/known_marketplaces.json"; then marketplace=true; fi`,
    "printf '%s\\n' \"$installed $cached $marketplace\"",
  ].join("; ");
  const result = await runSSHCommand(target, command);
  expect(result.code).toBe(0);
  const [installed, cached, marketplace] = result.stdout.trim().split(/\s+/u);
  return {
    cacheContainsPlugin: cached === "true",
    installedContainsPlugin: installed === "true",
    marketplaceContainsPlugin: marketplace === "true",
  };
}

async function readRemoteFile(target: SSHConnectionConfig, path: string): Promise<string> {
  const result = await runSSHCommand(target, `cat -- ${quoteShell(path)}`);
  expect(result.code).toBe(0);
  return result.stdout;
}

async function openRemotePluginSyncDialog(workspacePath: string): Promise<void> {
  await browser.waitUntil(
    () =>
      browser.execute(
        (headerTestId, moreTestId, pathTestId, expectedPath) => {
          const headers = Array.from(
            document.querySelectorAll<HTMLElement>(`[data-testid="${headerTestId}"]`),
          );
          const header = headers.find((candidate) => {
            if (candidate.getClientRects().length === 0) return false;
            const path = candidate.querySelector<HTMLElement>(`[data-testid="${pathTestId}"]`);
            return path?.title.startsWith(expectedPath);
          });
          const button = header?.querySelector<HTMLButtonElement>(`[data-testid="${moreTestId}"]`);
          if (!button || button.disabled) return false;
          button.dispatchEvent(
            new PointerEvent("pointerdown", {
              bubbles: true,
              cancelable: true,
              button: 0,
              pointerId: 1,
              pointerType: "mouse",
            }),
          );
          button.click();
          return true;
        },
        TID_WORKSPACE_HEADER,
        TID_WORKSPACE_MORE_BUTTON,
        TID_WORKSPACE_PATH,
        workspacePath,
      ),
    {
      timeout: 30_000,
      timeoutMsg: `${CASE_MARKER}: remote task header 没有更多菜单`,
    },
  );
  let visibleMenuItems: string[] = [];
  await browser.waitUntil(
    async () => {
      const result = await browser.execute(() => {
        const visibleItems = Array.from(
          document.querySelectorAll<HTMLElement>('[role="menuitem"]'),
        ).filter((candidate) => candidate.getClientRects().length > 0);
        const item = Array.from(visibleItems).find((candidate) => {
          const text = candidate.innerText.trim();
          return text === "同步 Plugin" || text === "Sync Plugin";
        });
        if (!item) {
          return {
            clicked: false,
            visibleItems: visibleItems.map((candidate) => candidate.innerText.trim()),
          };
        }
        item.click();
        return {
          clicked: true,
          visibleItems: visibleItems.map((candidate) => candidate.innerText.trim()),
        };
      });
      visibleMenuItems = result.visibleItems;
      return result.clicked;
    },
    {
      timeout: 30_000,
      timeoutMsg: `${CASE_MARKER}: remote task menu 没有“同步 Plugin”入口，visible=${JSON.stringify(visibleMenuItems)}`,
    },
  );
}

async function waitForRemotePluginCandidate(candidateId: string): Promise<void> {
  await browser.waitUntil(
    () =>
      browser.execute((id) => {
        const checkbox = document.getElementById(
          `remote-plugin-sync-${id}`,
        ) as HTMLInputElement | null;
        return Boolean(checkbox && !checkbox.disabled && checkbox.checked);
      }, candidateId),
    {
      timeout: 120_000,
      timeoutMsg: `${CASE_MARKER}: remote Plugin sync 没有默认选中 ${candidateId}`,
    },
  );
}

async function startRemotePluginSync(): Promise<void> {
  await browser.waitUntil(
    () =>
      browser.execute(() => {
        const button = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
          (candidate) => {
            const text = candidate.innerText.trim();
            return !candidate.disabled && (text === "同步已选项" || text === "Sync selected");
          },
        );
        if (!button) return false;
        button.click();
        return true;
      }),
    {
      timeout: 30_000,
      timeoutMsg: `${CASE_MARKER}: “同步已选项”不可点击`,
    },
  );
}

async function waitForRemotePluginSyncComplete(): Promise<void> {
  let observedBusy = false;
  let latestState: {
    dialogText: string;
    failed: boolean;
    syncButtonEnabled: boolean;
    synced: boolean;
  } = {
    dialogText: "",
    failed: false,
    syncButtonEnabled: false,
    synced: false,
  };
  await browser.waitUntil(
    async () => {
      latestState = await browser.execute(() => {
        const synced = Array.from(document.querySelectorAll<HTMLElement>("span")).some(
          (candidate) => {
            const text = candidate.innerText.trim();
            return text === "已同步" || text === "Synced";
          },
        );
        const failed = Array.from(document.querySelectorAll<HTMLElement>("span")).some(
          (candidate) => {
            const text = candidate.innerText.trim();
            return text === "失败" || text === "Failed";
          },
        );
        const syncButton = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
          (candidate) => {
            const text = candidate.innerText.trim();
            return text === "同步已选项" || text === "Sync selected";
          },
        );
        const dialog = Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"]')).find(
          (candidate) => candidate.getClientRects().length > 0,
        );
        return {
          dialogText: dialog?.innerText.trim() ?? "",
          failed,
          syncButtonEnabled: Boolean(syncButton && !syncButton.disabled),
          synced,
        };
      });
      if (!latestState.syncButtonEnabled) {
        observedBusy = true;
      }
      return (
        latestState.synced || latestState.failed || (observedBusy && latestState.syncButtonEnabled)
      );
    },
    {
      timeout: 240_000,
      timeoutMsg: `${CASE_MARKER}: remote Plugin sync 没有进入“已同步”`,
    },
  );
  if (!latestState.synced) {
    throw new Error(
      `${CASE_MARKER}: remote Plugin sync 回退到选择阶段，dialog=${JSON.stringify(latestState.dialogText)}`,
    );
  }
}

function writeBase64Command(path: string, content: string): string {
  const encoded = Buffer.from(content, "utf8").toString("base64");
  return `printf '%s' ${quoteShell(encoded)} | base64 -d > ${quoteShell(path)}`;
}

function quoteShell(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
