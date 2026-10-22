import { rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { formatZCodeAgentProcessName } from "@zcode/shared";
import { TID_CONFIRM_DIALOG_CONFIRM } from "@zcode/shared/test-ids";
import {
  clearAppData,
  getE2EAppDataPaths,
  quitElectronAppGracefully,
  waitForWorkspaceApp,
} from "../../helpers/desktop-app.js";
import { openProjectMenuAction, waitForProjectRowGone } from "../../helpers/project-sidebar.js";
import { getPassiveAgentStartupWorkspacePaths } from "../../helpers/passive-agent-startup-fixture.js";
import {
  countAgentProcessRows,
  isMainRendererUrl,
  isResourceManagerUrl,
  openResourceManager,
  switchToElectronRendererTarget,
  waitForResourceManagerReady,
} from "../../helpers/resource-manager.js";
import {
  openWorkspaceDraftFromSidebar,
  waitForRestoredProjects,
} from "../../helpers/workspace-agent-warmup.js";

// 2026-09-12 降级为 pending：虚拟项目重构后侧栏没有「移除 workspace / 关闭 tab」入口，
// 最接近的动作是项目行菜单「删除项目」（Host 软删除项目容器，会话保留）。删除项目是否
// 应当释放该目录的 Agent runtime 尚无产品裁决，本用例改按删除项目执行，待裁决后再决定
// 是恢复为正式门禁还是随旧「移除 workspace」语义一起作废。
const CASE_MARKER = "WRL01";
const RENAME_RETRY_DELAYS_MS = [200, 500, 1000, 2000, 3000, 5000];

describe("workspace removal runtime release E2E", () => {
  after(async () => {
    await clearAppData();
  });

  it("WRL01: 移除项目释放 Agent runtime，退出后 Windows 可重命名和删除项目目录", async function () {
    this.timeout(120_000);

    const { homeDir } = getE2EAppDataPaths();
    const workspacePaths = getPassiveAgentStartupWorkspacePaths(homeDir, 2);
    const removableWorkspacePath = workspacePaths[0];
    const activeWorkspacePath = workspacePaths[1];
    if (!removableWorkspacePath || !activeWorkspacePath) {
      throw new Error(`${CASE_MARKER}: 缺少 workspace fixture`);
    }

    await writeFile(
      join(removableWorkspacePath, "wrl-lock-probe.txt"),
      "workspace removal runtime release probe",
      "utf-8",
    );
    await waitForWorkspaceApp(activeWorkspacePath, 30_000);
    await waitForRestoredProjects(workspacePaths, 30_000);

    await openWorkspaceDraftFromSidebar(removableWorkspacePath);
    await openResourceManager();
    await switchToElectronRendererTarget(isResourceManagerUrl);
    await waitForResourceManagerReady();

    const workspaceNameSuffix = buildAgentWorkspaceNameSuffix(removableWorkspacePath);
    await waitForWorkspaceAgentCount(
      workspaceNameSuffix,
      1,
      "移除前没有观察到目标 workspace Agent",
    );

    await switchToElectronRendererTarget(isMainRendererUrl);
    await removeWorkspaceFromSidebar(removableWorkspacePath);
    await switchToElectronRendererTarget(isResourceManagerUrl);
    await waitForWorkspaceAgentCount(workspaceNameSuffix, 0, "移除后目标 workspace Agent 仍残留");

    await switchToElectronRendererTarget(isMainRendererUrl);
    await quitElectronAppGracefully();

    const renamedWorkspacePath = `${removableWorkspacePath}-renamed`;
    await renameWorkspaceWithRetry(removableWorkspacePath, renamedWorkspacePath);
    await rm(renamedWorkspacePath, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 500,
    });
  });
});

function buildAgentWorkspaceNameSuffix(workspacePath: string): string {
  const placeholderPrefix = formatZCodeAgentProcessName("placeholder");
  const formatted = formatZCodeAgentProcessName("placeholder", workspacePath);
  return formatted.slice(placeholderPrefix.length);
}

async function waitForWorkspaceAgentCount(
  workspaceNameSuffix: string,
  expected: number,
  failureMessage: string,
): Promise<void> {
  await browser.waitUntil(
    async () => (await countAgentProcessRows({ workspaceNameSuffix })) === expected,
    {
      timeout: 30_000,
      interval: 250,
      timeoutMsg: `${CASE_MARKER}: ${failureMessage}`,
    },
  );
}

async function removeWorkspaceFromSidebar(workspacePath: string): Promise<void> {
  // 旧「更多菜单 → 移除 workspace」已下线；现用项目行更多菜单的删除项目动作。
  await openProjectMenuAction(workspacePath, "delete", { timeout: 30_000 });
  await clickConfirmIfPresent();
  await waitForProjectRowGone(workspacePath, {
    timeout: 30_000,
    timeoutMsg: `${CASE_MARKER}: workspace ${workspacePath} 对应项目删除后仍在侧栏`,
  });
}

async function clickConfirmIfPresent(): Promise<void> {
  await browser.pause(250);
  await browser.execute((confirmTestId) => {
    const confirmButton = Array.from(document.querySelectorAll<HTMLElement>("[data-testid]")).find(
      (candidate) => candidate.dataset.testid === confirmTestId,
    );
    confirmButton?.click();
  }, TID_CONFIRM_DIALOG_CONFIRM);
}

async function renameWorkspaceWithRetry(fromPath: string, toPath: string): Promise<void> {
  let lastError: unknown = null;
  await rm(toPath, { recursive: true, force: true, maxRetries: 3, retryDelay: 500 });
  for (const delayMs of RENAME_RETRY_DELAYS_MS) {
    try {
      await rename(fromPath, toPath);
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  throw new Error(`${CASE_MARKER}: 移除并退出后 workspace 目录仍不可重命名: ${fromPath}`, {
    cause: lastError,
  });
}
