import { dirname } from "node:path";
import { DEFAULT_WORKSPACE, clearAppData, waitForWorkspaceApp } from "./helpers/desktop-app.js";
import {
  SMALL_AGENT_WARMUP_SCENARIO,
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

describe("少量候选 workspace 恢复", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("TSL29: 有 2 个候选时只启动 active 1 个，切换 Grouped 也不补启动 recent", async function () {
    this.timeout(90_000);
    const workspacePaths = getPassiveAgentStartupWorkspacePaths(
      dirname(DEFAULT_WORKSPACE),
      SMALL_AGENT_WARMUP_SCENARIO.workspaceCount,
    );
    const activeWorkspacePath = workspacePaths[SMALL_AGENT_WARMUP_SCENARIO.activeWorkspaceIndex];
    if (!activeWorkspacePath) throw new Error("small-set fixture 缺少 active workspace");
    const expectedWarmupWorkspacePaths = pickWorkspacePaths(
      workspacePaths,
      SMALL_AGENT_WARMUP_SCENARIO.expectedWarmupWorkspaceIndexes,
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
