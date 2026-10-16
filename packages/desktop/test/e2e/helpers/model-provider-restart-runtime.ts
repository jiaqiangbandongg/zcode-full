import { NodePersonalProviderConfigRepository } from "@zcode/provider-node";
import {
  getE2EAppDataPaths,
  waitForDefaultWorkspaceReady,
  waitForWorkspaceApp,
} from "./desktop-app.js";
import { reloadElectronSessionSafely } from "./e2e-electron-reload.js";
import { flushElectronStorageData } from "./e2e-electron-storage.js";

const paths = getE2EAppDataPaths();
const MODEL_SELECTION_RECENT_KEY_PREFIX = "zcode-model-selection-recent-v1:";
let retainedRestartUserDataDir: string | null = null;

export interface ModelProviderRestartOptions {
  afterElectronProcessExit?: () => Promise<void> | void;
}

export async function seedTurboAgentStartupModel(providerId: string, modelId: string) {
  // 默认选择与 Provider 共用同一份 Personal 文件，seed 必须保留已有模型配置。
  const repository = new NodePersonalProviderConfigRepository({
    filePath: paths.configFile,
    pollingIntervalMs: false,
  });
  try {
    await repository.update((current) => ({
      ...current,
      defaultModelSelection: { providerId, modelId },
    }));
  } finally {
    repository.dispose();
  }
}

export async function restartIntoWorkspacePreservingProfile(
  workspacePath: string,
  options: ModelProviderRestartOptions = {},
) {
  const isFirstRestart = retainedRestartUserDataDir === null;
  if (isFirstRestart) {
    retainedRestartUserDataDir = (await browser.electron.execute((electron) =>
      electron.app.getPath("userData"),
    )) as string;
  }
  const requestedCapabilities = browser.requestedCapabilities as WebdriverIO.Capabilities & {
    "goog:chromeOptions"?: { args?: string[] };
  };
  const chromeOptions = requestedCapabilities["goog:chromeOptions"] ?? {};
  requestedCapabilities["goog:chromeOptions"] = {
    ...chromeOptions,
    args: [
      ...(chromeOptions.args ?? []).filter((arg) => !arg.startsWith("--user-data-dir=")),
      `--user-data-dir=${retainedRestartUserDataDir}`,
    ],
  };

  // Bug 根因：旧实现只在第一次重启 flush；第二、三次依赖固定 pause，进程退出可能
  // 早于 Chromium DOMStorage 异步落盘，下一 case 会恢复上一条 thoughtLevel。
  // reload helper 已在每次新 session 后重建并探测 Electron service bridge，因此每次
  // 退出都通过当前 bridge 建立真实持久化屏障，不能再用机器负载相关的 sleep 代替。
  await flushElectronStorageData(browser);
  await reloadElectronSessionSafely(browser, {
    afterElectronProcessExit: options.afterElectronProcessExit,
  });
  // Bug 根因：Puppeteer targetId 不保证同时是 ChromeDriver window handle，
  // 长批次直接 switchToWindow(targetId) 会破坏 CDP bridge。复用共享 helper 的
  // BrowserWindow URL + handle/target 交集切换，和 WDIO preflight 保持同一合同。
  await waitForDefaultWorkspaceReady(60000);
  await waitForWorkspaceApp(workspacePath, 60000);
}

export async function restartIntoWorkspaceRestoringPreferences(
  workspacePath: string,
  options: ModelProviderRestartOptions = {},
) {
  const persistedModelPreferences = await browser.execute(
    (modelSelectionRecentKeyPrefix) =>
      Object.fromEntries(
        Object.entries(window.localStorage).filter(
          ([key]) =>
            key.startsWith("zcode-last-agent-") ||
            // Bug 根因：重启 helper 只恢复旧的 agent 键，遗漏当前唯一结构化
            // Model Selection recent 键，导致冷启动断言看到 storedConfig=null 并
            // 回退 preferredSelection。两类键必须在同一退出屏障后一起恢复。
            key.startsWith(modelSelectionRecentKeyPrefix),
        ),
      ),
    MODEL_SELECTION_RECENT_KEY_PREFIX,
  );
  // Bug 根因：SQLite/provider fixture 若在旧 Host/Agent 存活时写入，会被退出阶段的
  // 迟到持久化覆盖。只把调用方写操作放进 reload 的进程退出屏障，不用 pause 猜时序。
  await reloadElectronSessionSafely(browser, {
    afterElectronProcessExit: options.afterElectronProcessExit,
  });
  await waitForDefaultWorkspaceReady(60000);
  await waitForWorkspaceApp(workspacePath, 60000);
  await browser.execute((preferences) => {
    for (const [key, value] of Object.entries(preferences)) {
      window.localStorage.setItem(key, value);
    }
    window.location.reload();
  }, persistedModelPreferences);
  // 通用回退 case 需要在新 renderer 启动后恢复“待判定偏好”，不能把无效模型
  // 提前写成 Agent 启动模型。它们只验证偏好回退，不验证首个 deferred session。
  await waitForWorkspaceApp(workspacePath, 60000);
}
