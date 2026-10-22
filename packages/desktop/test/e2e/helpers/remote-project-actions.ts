import {
  TID_SETTINGS_BACK_BUTTON,
  TID_SETTINGS_PAGE,
  TID_SETTINGS_SECTION_NAV,
  TID_TASK_SETTINGS_BUTTON,
  testId,
} from "@zcode/shared/test-ids";
import { clickTestIdByDom, readSettings, waitForTestIdByDom } from "./desktop-app.js";
import {
  readRemoteTabSnapshot,
  waitForRemoteTab,
  waitForSSHDirectoryStep,
} from "./ssh-remote-p0.js";
import { selectTaskOrganizeMode } from "./workspace-agent-warmup.js";

/** 项目平铺后，设备断开属于设置页；按权威 Source 找线路，不借第一个设备操作。 */
export async function disconnectRemoteSource(
  sourceId: string,
  caseMarker: string,
  options: { workspaceIdentities?: readonly string[] } = {},
): Promise<void> {
  await clickRemoteSourceAction(sourceId, caseMarker, ["断开", "Disconnect"]);
  await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON, { timeout: 15_000 });
  await selectTaskOrganizeMode(["项目", "Project"]);
  const identities = options.workspaceIdentities;
  if (identities?.length) {
    // 根因：旧 case 等 settings 历史投影变成 failed，新项目已离线仍白等 30 秒。
    // 当前连接展示归 Source/项目目录，按指定 identity 等实际项目行，不读取退役投影判就绪。
    let latest: Array<{ identity: string; status: string | null }> = [];
    try {
      await browser.waitUntil(
        async () => {
          latest = await browser.execute(
            (identities) =>
              identities.map((identity) => ({
                identity,
                status:
                  document.querySelector<HTMLElement>(
                    `[data-project-workspace-identity=${JSON.stringify(identity)}]`,
                  )?.dataset.connectionState ?? null,
              })),
            identities,
          );
          return latest.every((project) => project.status === "offline");
        },
        { timeout: 30_000, timeoutMsg: `${caseMarker}: 目标项目未离线` },
      );
    } catch (cause) {
      throw new Error(`${caseMarker}: 目标项目未离线；latest=${JSON.stringify(latest)}`, { cause });
    }
  }
}

export async function connectRemoteSourceFromSettings(
  sourceId: string,
  caseMarker: string,
): Promise<void> {
  await clickRemoteSourceAction(sourceId, caseMarker, ["连接", "Connect"]);
}

async function clickRemoteSourceAction(
  sourceId: string,
  caseMarker: string,
  labels: string[],
): Promise<void> {
  const settings = await readSettings();
  const source = settings.sourceServers?.find((item) => item.sourceServerId === sourceId);
  if (!source) throw new Error(`${caseMarker}: 找不到 Source ${sourceId}`);
  await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON, { timeout: 15_000 });
  await waitForTestIdByDom(TID_SETTINGS_PAGE, { timeout: 15_000 });
  await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "remoteDevices"), { timeout: 15_000 });
  await browser.waitUntil(
    () =>
      browser.execute(
        (name, allowedLabels) => {
          const page = document.querySelector('[data-testid="settings-page"]');
          // 外层设置内容也用 section；从精确标题取最近设备卡，不能把祖先一起匹配。
          const cards = [
            ...new Set(
              Array.from(page?.querySelectorAll("p") ?? [])
                .filter((p) => p.textContent?.trim() === name)
                .map((p) => p.closest("section"))
                .filter((card): card is HTMLElement => card !== null),
            ),
          ];
          if (cards.length !== 1) return false;
          const button = Array.from(cards[0]!.querySelectorAll<HTMLButtonElement>("button")).find(
            (item) =>
              item.getClientRects().length &&
              !item.disabled &&
              allowedLabels.includes(item.innerText.trim()),
          );
          button?.click();
          return Boolean(button);
        },
        source.displayName,
        labels,
      ),
    {
      timeout: 30_000,
      interval: 200,
      timeoutMsg: `${caseMarker}: 目标设备没有可用的 ${labels.join("/")} 入口`,
    },
  );
}

/** 点击已有项目保留原目录意图；不重新输入线路，也不创建远程无项目聊天。 */
export async function reconnectRemoteProject(identity: string, caseMarker: string): Promise<void> {
  const before = await readRemoteTabSnapshot(identity);
  if (!before.workspacePath) throw new Error(`${caseMarker}: 找不到保留项目路径`);
  await requestRemoteProjectConnection(identity, caseMarker);
  await waitForSSHDirectoryStep(caseMarker);
  await waitForRemoteTab({
    caseMarker,
    expectedIdentity: identity,
    expectedPath: before.workspacePath,
  });
}

/** 故障/升级用例需要观察连接中间态，由调用方决定何时解除 barrier。 */
export async function requestRemoteProjectConnection(
  identity: string,
  caseMarker: string,
  options: { retryFailure?: boolean } = {},
): Promise<void> {
  await selectTaskOrganizeMode(["项目", "Project"]);
  const row = $(`[data-project-workspace-identity=${JSON.stringify(identity)}]`);
  await row.waitForDisplayed({ timeout: 30_000, timeoutMsg: `${caseMarker}: 项目入口未保留` });
  await row.moveTo();
  await row.$('[data-testid="virtual-project-menu"]').click();
  await $('[data-testid="virtual-project-connect"]').click();
  if (!options.retryFailure) return;
  // 失败项目先展示原故障，再由用户在原向导点击重试；只打开页面不能算作恢复操作。
  await browser.waitUntil(
    async () => {
      if ((await readRemoteTabSnapshot(identity)).remoteSessionId) return true;
      return browser.execute(() => {
        const button = Array.from(
          document.querySelectorAll<HTMLButtonElement>('[data-testid="ssh-dialog"] button'),
        ).find(
          (item) =>
            /^(重试|重新连接|Retry|Reconnect)$/iu.test(item.innerText.trim()) && !item.disabled,
        );
        button?.click();
        return Boolean(button);
      });
    },
    { timeout: 30_000, timeoutMsg: `${caseMarker}: 原地恢复没有可用重试入口` },
  );
}
