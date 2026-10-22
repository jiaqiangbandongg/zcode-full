import { formatZCodeAgentProcessName } from "@zcode/shared";
import { startDraftFromProject, waitForProjectRow } from "./project-sidebar.js";
import {
  countAgentProcessRows,
  listAgentProcessIdentities,
  waitForAgentProcessCount,
  type AgentProcessIdentity,
} from "./resource-manager.js";

export function pickWorkspacePaths(workspacePaths: string[], indexes: readonly number[]): string[] {
  return indexes.map((index) => {
    const workspacePath = workspacePaths[index];
    if (!workspacePath) {
      throw new Error(`workspace fixture 缺少 index=${index}`);
    }
    return workspacePath;
  });
}

export async function waitForActiveWorkspacePath(
  expectedWorkspacePath: string,
  timeout = 30_000,
): Promise<void> {
  await browser.waitUntil(
    async () => {
      try {
        return await browser.execute((expectedPath) => {
          const tabStore = (
            window as Window & {
              __zcodeTabStoreE2E?: {
                getState?: () => { activeWorkspacePath?: string | null };
              };
            }
          ).__zcodeTabStoreE2E;
          return tabStore?.getState?.().activeWorkspacePath === expectedPath;
        }, expectedWorkspacePath);
      } catch {
        // renderer reload 期间 WebDriver 会短暂失去执行上下文，继续等待新页面挂载 store。
        return false;
      }
    },
    {
      timeout,
      interval: 100,
      timeoutMsg: `active workspace 没有收敛为 ${expectedWorkspacePath}`,
    },
  );
}

export { waitForRestoredProjects } from "./project-sidebar.js";

/**
 * 从侧栏为指定 workspace 打开新任务草稿。虚拟项目重构后 workspace 不再是可点击的目录
 * 节点，而是同名项目行；项目行的「新建任务」按钮就是显式草稿导航入口（cwd = 主要目录），
 * 不再依赖旧的「先收起再展开」手势。
 */
export async function openWorkspaceDraftFromSidebar(workspacePath: string): Promise<void> {
  await waitForProjectRow(workspacePath, {
    timeout: 15_000,
    timeoutMsg: `侧栏没有 dormant workspace 对应的项目: ${workspacePath}`,
  });
  await startDraftFromProject(workspacePath);
  await waitForActiveWorkspacePath(workspacePath);
}

export async function assertStableAgentSelection(
  allWorkspacePaths: string[],
  expectedWorkspacePaths: string[],
): Promise<AgentProcessIdentity[]> {
  await waitForAgentProcessCount(expectedWorkspacePaths.length);
  // 观察窗口跨过 Process Monitor 的至少一次刷新周期，避免只命中启动风暴前的瞬时值。
  await browser.pause(1_500);

  const identities = await listAgentProcessIdentities();
  expect(identities).toHaveLength(expectedWorkspacePaths.length);

  const expected = new Set(expectedWorkspacePaths);
  const placeholderPrefix = formatZCodeAgentProcessName("placeholder");
  for (const workspacePath of allWorkspacePaths) {
    const formatted = formatZCodeAgentProcessName("placeholder", workspacePath);
    const workspaceNameSuffix = formatted.slice(placeholderPrefix.length);
    const actual = await countAgentProcessRows({ workspaceNameSuffix });
    expect(actual).toBe(expected.has(workspacePath) ? 1 : 0);
  }

  return identities;
}

/** 旧组织模式入口退场后，所有项目型用例统一选择项目视图。 */
export async function selectTaskOrganizeMode(_labels: string[]): Promise<void> {
  await $('[data-testid="sidebar-view-menu"]').click();
  await $('[role="menuitemradio"][data-state]') .waitForExist();
  const item = $('[role="menuitemradio"][data-testid="sidebar-view-projects"]');
  await item.click();
  await $('[data-testid="project-section"]').waitForDisplayed();
}
