import { rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  TID_CONFIRM_DIALOG_CONFIRM,
  TID_WORKSPACE_CLOSE,
  TID_WORKSPACE_ITEM,
  formatZCodeAgentProcessName,
  testId,
} from "@zcode/shared";
import {
  clearAppData,
  clickTestIdByDom,
  getE2EAppDataPaths,
  hoverTestIdByWebDriver,
  quitElectronAppGracefully,
  waitForWorkspaceApp,
} from "./helpers/desktop-app.js";
import { getPassiveAgentStartupWorkspacePaths } from "./helpers/passive-agent-startup-fixture.js";
import {
  countAgentProcessRows,
  isMainRendererUrl,
  isResourceManagerUrl,
  openResourceManager,
  switchToElectronRendererTarget,
  waitForResourceManagerReady,
} from "./helpers/resource-manager.js";
import {
  openWorkspaceDraftFromSidebar,
  waitForRestoredWorkspaceItems,
} from "./helpers/workspace-agent-warmup.js";

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
    await waitForRestoredWorkspaceItems(workspacePaths, 30_000);

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
  const workspaceItemId = testId(TID_WORKSPACE_ITEM, workspacePath);
  // 修复原因：workspace 更多菜单只在整行 hover/focus 后挂载；直接查按钮会误报缺失。
  await hoverTestIdByWebDriver(workspaceItemId, {
    timeout: 30_000,
    timeoutMsg: `${CASE_MARKER}: workspace ${workspacePath} 没有可悬停的侧栏行`,
  });
  await browser.waitUntil(
    async () =>
      browser.execute((itemId) => {
        const item = Array.from(document.querySelectorAll<HTMLElement>("[data-testid]")).find(
          (candidate) => candidate.dataset.testid === itemId,
        );
        if (!item) return false;
        const moreButton = Array.from(
          item.closest("li")?.querySelectorAll<HTMLButtonElement>("button") ?? [],
        ).find((button) => {
          const label = (button.getAttribute("aria-label") ?? "").toLowerCase();
          return label.includes("more") || label.includes("更多");
        });
        if (!moreButton) return false;
        moreButton.dispatchEvent(
          new PointerEvent("pointerdown", {
            bubbles: true,
            cancelable: true,
            button: 0,
            pointerId: 1,
            pointerType: "mouse",
          }),
        );
        moreButton.dispatchEvent(
          new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }),
        );
        moreButton.click();
        return true;
      }, workspaceItemId),
    {
      timeout: 30_000,
      timeoutMsg: `${CASE_MARKER}: workspace ${workspacePath} 没有显示更多菜单入口`,
    },
  );
  await clickTestIdByDom(testId(TID_WORKSPACE_CLOSE, workspacePath), {
    timeout: 15_000,
    timeoutMsg: `${CASE_MARKER}: workspace ${workspacePath} 没有显示移除入口`,
  });
  await clickConfirmIfPresent();
  await browser.waitUntil(
    () =>
      browser.execute((itemId) => {
        const item = Array.from(document.querySelectorAll<HTMLElement>("[data-testid]")).find(
          (candidate) => candidate.dataset.testid === itemId,
        );
        return !item;
      }, workspaceItemId),
    {
      timeout: 30_000,
      timeoutMsg: `${CASE_MARKER}: workspace ${workspacePath} 移除后仍在侧栏`,
    },
  );
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
