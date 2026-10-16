import { dirname } from "node:path";
import {
  DEFAULT_WORKSPACE,
  clearAppData,
  waitForWorkspaceApp,
} from "./helpers/desktop-app.js";
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
  openWorkspaceDraftFromSidebar,
  pickWorkspacePaths,
  selectTaskOrganizeMode,
  waitForActiveWorkspacePath,
  waitForRestoredWorkspaceItems,
} from "./helpers/workspace-agent-warmup.js";

describe("workspace Agent 预热生命周期", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("TSL31: renderer reload 复用原 3 个 PID，显式打开名单外 workspace 后只增加第 4 个", async function () {
    this.timeout(120_000);
    const workspacePaths = getPassiveAgentStartupWorkspacePaths(
      dirname(DEFAULT_WORKSPACE),
      PASSIVE_AGENT_STARTUP_SCENARIO.workspaceCount,
    );
    const activeWorkspacePath = workspacePaths[
      PASSIVE_AGENT_STARTUP_SCENARIO.activeWorkspaceIndex
    ];
    const explicitWorkspacePath = workspacePaths[
      PASSIVE_AGENT_STARTUP_SCENARIO.explicitWorkspaceIndex
    ];
    if (!activeWorkspacePath || !explicitWorkspacePath) {
      throw new Error("启动 fixture 缺少 active 或显式打开 workspace");
    }
    const startupWarmupWorkspacePaths = pickWorkspacePaths(
      workspacePaths,
      PASSIVE_AGENT_STARTUP_SCENARIO.expectedWarmupWorkspaceIndexes,
    );

    await waitForWorkspaceApp(activeWorkspacePath, 30_000);
    await waitForActiveWorkspacePath(activeWorkspacePath);
    await waitForRestoredWorkspaceItems(workspacePaths);

    await openResourceManager();
    await switchToElectronRendererTarget(isResourceManagerUrl);
    await waitForResourceManagerReady();
    const beforeReload = await assertStableAgentSelection(
      workspacePaths,
      startupWarmupWorkspacePaths,
    );

    await switchToElectronRendererTarget(isMainRendererUrl);
    // renderer reload 应只给存活 Host 重新挂 MessagePort，不能重跑 InitLocal 或复制 Agent。
    await browser.execute(() => window.location.reload());
    await waitForActiveWorkspacePath(activeWorkspacePath);
    await waitForRestoredWorkspaceItems(workspacePaths);

    await switchToElectronRendererTarget(isResourceManagerUrl);
    await waitForResourceManagerReady();
    const afterReload = await assertStableAgentSelection(
      workspacePaths,
      startupWarmupWorkspacePaths,
    );
    expect(afterReload).toEqual(beforeReload);

    await switchToElectronRendererTarget(isMainRendererUrl);
    await openWorkspaceDraftFromSidebar(explicitWorkspacePath);

    const expectedAfterExplicitOpen = [
      ...startupWarmupWorkspacePaths,
      explicitWorkspacePath,
    ];
    await switchToElectronRendererTarget(isResourceManagerUrl);
    await assertStableAgentSelection(workspacePaths, expectedAfterExplicitOpen);

    await switchToElectronRendererTarget(isMainRendererUrl);
    await selectTaskOrganizeMode(["分组", "Group"]);
    await switchToElectronRendererTarget(isResourceManagerUrl);
    await assertStableAgentSelection(workspacePaths, expectedAfterExplicitOpen);
  });
});
