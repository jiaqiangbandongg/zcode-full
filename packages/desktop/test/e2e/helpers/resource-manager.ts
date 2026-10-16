import type { MenuItem } from "electron";
import {
  TID_RESOURCE_MANAGER_TAB,
  TID_WORKSPACE_HELP_MENU_RESOURCE_MANAGER,
  TID_WORKSPACE_HELP_MENU_TRIGGER,
  testId,
  type ResourceUsageSnapshot,
} from "@zcode/shared";
import { clickTestIdByWebDriver, dispatchMouseDownByExactTestId } from "./desktop-app.js";
import { sel } from "./selectors.js";

const RESOURCE_MANAGER_URL_MARKER = "resource-manager.html";
const MAIN_RENDERER_URL_MARKER = "/renderer/index.html";

type ResourceManagerWindow = Window & {
  resourceManager?: { getSnapshot: () => Promise<ResourceUsageSnapshot> };
};

export async function openResourceManager(): Promise<void> {
  await browser.electron.execute((electron) => {
    const findResourceManagerItem = (items: MenuItem[]): MenuItem | undefined => {
      for (const item of items) {
        if (item.label === "资源管理器" || item.label.toLowerCase() === "resource manager") {
          return item;
        }
        const nested = item.submenu ? findResourceManagerItem(item.submenu.items) : undefined;
        if (nested) return nested;
      }
      return undefined;
    };

    const item = findResourceManagerItem(electron.Menu.getApplicationMenu()?.items ?? []);
    if (!item) throw new Error("应用菜单中没有找到资源管理器");
    item.click(undefined as never, undefined, undefined as never);
  });
}

/**
 * 从主窗口右上角问号帮助菜单打开资源管理器。
 * Windows/Linux 没有原生菜单栏，这是这两个平台唯一的入口；调用前需处于主 renderer target。
 */
export async function openResourceManagerFromHelpMenu(): Promise<void> {
  // Radix DropdownMenu trigger 依赖 pointerdown，必须走真实 WebDriver 指针链。
  await clickTestIdByWebDriver(TID_WORKSPACE_HELP_MENU_TRIGGER);
  const item = $(sel(TID_WORKSPACE_HELP_MENU_RESOURCE_MANAGER));
  await item.waitForClickable({ timeout: 10_000, timeoutMsg: "问号菜单里没有资源管理器项" });
  await item.click();
}

/** 关闭资源管理器窗口（若存在），供同一 spec 内多个 case 各自验证打开路径。 */
export async function closeResourceManagerWindow(): Promise<void> {
  await browser.electron.execute((electron, marker) => {
    for (const window of electron.BrowserWindow.getAllWindows()) {
      if (window.webContents.getURL().includes(marker)) {
        window.close();
      }
    }
  }, RESOURCE_MANAGER_URL_MARKER);
  await browser.waitUntil(
    async () =>
      browser.electron.execute(
        (electron, marker) =>
          !electron.BrowserWindow.getAllWindows().some((window) =>
            window.webContents.getURL().includes(marker),
          ),
        RESOURCE_MANAGER_URL_MARKER,
      ),
    { timeout: 10_000, interval: 250, timeoutMsg: "资源管理器窗口没有关闭" },
  );
}

export async function switchToElectronRendererTarget(
  predicate: (url: string) => boolean,
): Promise<void> {
  await browser.waitUntil(
    async () => {
      const puppeteer = await browser.getPuppeteer();
      const target = puppeteer.targets().find((candidate) => predicate(candidate.url()));
      const targetId = target
        ? ((target as unknown as { _targetId?: string })._targetId ?? null)
        : null;
      if (!targetId) return false;
      await browser.switchToWindow(targetId);
      (browser.electron as typeof browser.electron & { windowHandle?: string }).windowHandle =
        targetId;
      return predicate(await browser.execute(() => window.location.href));
    },
    {
      timeout: 15_000,
      interval: 250,
      timeoutMsg: "没有找到目标 Electron renderer",
    },
  );
}

export function isMainRendererUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.pathname.endsWith(MAIN_RENDERER_URL_MARKER) ||
      (parsed.hostname === "localhost" && !parsed.pathname.endsWith(RESOURCE_MANAGER_URL_MARKER))
    );
  } catch {
    return false;
  }
}

export function isResourceManagerUrl(url: string): boolean {
  return url.includes(RESOURCE_MANAGER_URL_MARKER);
}

/** 读取 preload 指标源的一次完整快照（与 UI 同源，避免读瞬时 DOM 撞上 React commit 边界） */
export async function readResourceUsageSnapshot(): Promise<ResourceUsageSnapshot | null> {
  return browser.execute(async () => {
    const snapshot = await (window as ResourceManagerWindow).resourceManager?.getSnapshot();
    return snapshot ?? null;
  });
}

export async function waitForResourceManagerReady(): Promise<void> {
  await browser.waitUntil(
    async () => {
      const snapshot = await readResourceUsageSnapshot();
      return Boolean(snapshot?.processes.some((process) => process.name === "zcode-main"));
    },
    {
      timeout: 15_000,
      interval: 250,
      timeoutMsg: "资源管理器没有加载进程快照",
    },
  );
}

export async function waitForAgentProcessCount(
  expected: number,
  options: { workspaceNameSuffix?: string } = {},
): Promise<void> {
  await browser.waitUntil(async () => (await countAgentProcessRows(options)) === expected, {
    timeout: 30_000,
    interval: 250,
    timeoutMsg: `资源管理器中 Agent 数量没有收敛为 ${expected}`,
  });
}

export async function countAgentProcessRows(
  options: { workspaceNameSuffix?: string } = {},
): Promise<number> {
  return (await listAgentProcessIdentities(options)).length;
}

export interface AgentProcessIdentity {
  pid: number;
  name: string;
}

export async function listAgentProcessIdentities(
  options: { workspaceNameSuffix?: string } = {},
): Promise<AgentProcessIdentity[]> {
  const snapshot = await readResourceUsageSnapshot();
  if (!snapshot) return [];
  const suffix = options.workspaceNameSuffix ?? "";
  return snapshot.processes
    .filter(
      (process) =>
        process.name.startsWith("zcode-agent-") && (!suffix || process.name.endsWith(suffix)),
    )
    .map((process) => ({ pid: process.pid, name: process.name }))
    .sort((left, right) =>
      left.name === right.name ? left.pid - right.pid : left.name.localeCompare(right.name),
    );
}

/** Host 进程行（`zcode-host-*`），按 pid 升序 */
export async function listHostProcessIdentities(): Promise<AgentProcessIdentity[]> {
  const snapshot = await readResourceUsageSnapshot();
  if (!snapshot) return [];
  return snapshot.processes
    .filter((process) => process.name.startsWith("zcode-host-"))
    .map((process) => ({ pid: process.pid, name: process.name }))
    .sort((left, right) => left.pid - right.pid);
}

/**
 * 切换资源管理器顶部 tab。Radix TabsTrigger 在 mousedown 时激活，DOM click() 不会切换，
 * 所以这里派发 mousedown 并等待 data-state=active。
 */
export async function activateResourceManagerTab(
  tab: "cpu" | "memory" | "storage" | "network",
): Promise<void> {
  const tabTestId = testId(TID_RESOURCE_MANAGER_TAB, tab);
  await browser.waitUntil(
    async () => {
      await browser.execute(dispatchMouseDownByExactTestId, tabTestId);
      return browser.execute((currentTestId: string) => {
        const element = Array.from(document.querySelectorAll<HTMLElement>("[data-testid]")).find(
          (item) => item.dataset.testid === currentTestId,
        );
        return element?.getAttribute("data-state") === "active";
      }, tabTestId);
    },
    { timeout: 10_000, interval: 200, timeoutMsg: `资源管理器 tab ${tab} 没有激活` },
  );
}
