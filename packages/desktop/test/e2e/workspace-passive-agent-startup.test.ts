import { dirname } from "node:path";
import { DEFAULT_WORKSPACE, clearAppData, waitForWorkspaceApp } from "./helpers/desktop-app.js";
import {
  PASSIVE_AGENT_STARTUP_SCENARIO,
  getPassiveAgentStartupWorkspacePaths,
} from "./helpers/passive-agent-startup-fixture.js";
import {
  isMainRendererUrl,
  isResourceManagerUrl,
  openResourceManager,
  switchToElectronRendererTarget,
  waitForResourceManagerReady,
} from "./helpers/resource-manager.js";
import {
  assertStableAgentSelection,
  pickWorkspacePaths,
  selectTaskOrganizeMode,
  waitForActiveWorkspacePath,
  waitForRestoredWorkspaceItems,
} from "./helpers/workspace-agent-warmup.js";

describe("恢复 workspace 只预热 active 1 个 Agent", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("TSL29: 9 个 restored workspace 只预热 active 05，recent 01/02 保持 dormant", async function () {
    this.timeout(120_000);
    const workspacePaths = getPassiveAgentStartupWorkspacePaths(
      dirname(DEFAULT_WORKSPACE),
      PASSIVE_AGENT_STARTUP_SCENARIO.workspaceCount,
    );
    const activeWorkspacePath = workspacePaths[PASSIVE_AGENT_STARTUP_SCENARIO.activeWorkspaceIndex];
    if (!activeWorkspacePath) throw new Error("启动 fixture 缺少 active workspace");
    const expectedWarmupWorkspacePaths = pickWorkspacePaths(
      workspacePaths,
      PASSIVE_AGENT_STARTUP_SCENARIO.expectedWarmupWorkspaceIndexes,
    );

    await waitForWorkspaceApp(activeWorkspacePath, 30_000);
    await waitForActiveWorkspacePath(activeWorkspacePath);
    await waitForRestoredWorkspaceItems(workspacePaths);

    await openResourceManager();
    await switchToElectronRendererTarget(isResourceManagerUrl);
    await waitForResourceManagerReady();
    await assertStableAgentSelection(workspacePaths, expectedWarmupWorkspacePaths);

    await switchToElectronRendererTarget(isMainRendererUrl);
    await selectTaskOrganizeMode(["分组", "Group"]);

    await switchToElectronRendererTarget(isResourceManagerUrl);
    await assertStableAgentSelection(workspacePaths, expectedWarmupWorkspacePaths);
  });
});
