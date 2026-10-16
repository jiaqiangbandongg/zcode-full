import { TID_WORKSPACE_ITEM, formatZCodeAgentProcessName, testId } from "@zcode/shared";
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

export async function waitForRestoredWorkspaceItems(
  workspacePaths: string[],
  timeout = 30_000,
): Promise<void> {
  const workspaceItemTestIds = workspacePaths.map((workspacePath) =>
    testId(TID_WORKSPACE_ITEM, workspacePath),
  );
  await browser.waitUntil(
    async () => {
      try {
        return await browser.execute((expectedTestIds) => {
          const actual = new Set(
            Array.from(document.querySelectorAll<HTMLElement>("[data-testid]"))
              .map((element) => element.dataset.testid)
              .filter((value): value is string => Boolean(value)),
          );
          return expectedTestIds.every((expected) => actual.has(expected));
        }, workspaceItemTestIds);
      } catch {
        return false;
      }
    },
    {
      timeout,
      interval: 250,
      timeoutMsg: `${workspacePaths.length} 个恢复 workspace 没有全部出现在侧栏`,
    },
  );
}

export async function openWorkspaceDraftFromSidebar(workspacePath: string): Promise<void> {
  const workspaceItemTestId = testId(TID_WORKSPACE_ITEM, workspacePath);
  await browser.waitUntil(
    () =>
      browser.execute((expectedTestId) => {
        return Array.from(document.querySelectorAll<HTMLElement>("[data-testid]")).some(
          (element) => element.dataset.testid === expectedTestId,
        );
      }, workspaceItemTestId),
    {
      timeout: 15_000,
      interval: 100,
      timeoutMsg: `侧栏没有 dormant workspace: ${workspacePath}`,
    },
  );

  const isExpanded = await browser.execute((expectedTestId) => {
    return Array.from(document.querySelectorAll<HTMLElement>("[data-testid]")).find(
      (element) => element.dataset.testid === expectedTestId,
    )?.getAttribute("aria-expanded") === "true";
  }, workspaceItemTestId);
  if (isExpanded) {
    // 修复原因：workspace 展开态与 active workspace 是两套状态；renderer reload 后目标行
    // 可能已展开但仍 dormant。先真实收起，再点击展开，才能命中产品的显式草稿导航入口。
    await clickWorkspaceItem(workspaceItemTestId);
    await browser.waitUntil(
      () =>
        browser.execute((expectedTestId) => {
          return Array.from(document.querySelectorAll<HTMLElement>("[data-testid]")).find(
            (element) => element.dataset.testid === expectedTestId,
          )?.getAttribute("aria-expanded") === "false";
        }, workspaceItemTestId),
      {
        timeout: 10_000,
        interval: 100,
        timeoutMsg: `workspace 没有先收起: ${workspacePath}`,
      },
    );
  }

  await clickWorkspaceItem(workspaceItemTestId);
  await waitForActiveWorkspacePath(workspacePath);
}

async function clickWorkspaceItem(workspaceItemTestId: string): Promise<void> {
  const clicked = await browser.execute((expectedTestId) => {
    const item = Array.from(document.querySelectorAll<HTMLElement>("[data-testid]")).find(
      (element) => element.dataset.testid === expectedTestId,
    );
    item?.click();
    return Boolean(item);
  }, workspaceItemTestId);
  if (!clicked) {
    throw new Error(`侧栏 workspace 在点击前消失: ${workspaceItemTestId}`);
  }
}

export async function selectTaskOrganizeMode(labels: string[]): Promise<void> {
  await browser.waitUntil(
    () =>
      browser.execute((expectedLabels) => {
        const trigger = Array.from(
          document.querySelectorAll<HTMLElement>('[role="tab"]'),
        ).find((element) => {
          const text = element.textContent?.replace(/\s+/gu, " ").trim() ?? "";
          return expectedLabels.some((label) => text.includes(label));
        });
        if (!trigger) return false;
        if (
          trigger.hasAttribute("data-active") ||
          trigger.getAttribute("data-state") === "active" ||
          trigger.getAttribute("aria-selected") === "true"
        ) {
          return true;
        }
        trigger.dispatchEvent(
          new MouseEvent("mousedown", {
            bubbles: true,
            cancelable: true,
            button: 0,
          }),
        );
        return false;
      }, labels),
    {
      timeout: 15_000,
      interval: 100,
      timeoutMsg: `侧栏没有切换到任务组织视图: ${labels.join("/")}`,
    },
  );
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
