import { clearAppData, clickTestIdByDom } from "../../../helpers/desktop-app.js";
import { TID_SETTINGS_BACK_BUTTON } from "@zcode/shared";
import {
  PLUGIN_CDN_ZIP_MARKETPLACE_ID,
  PLUGIN_STORE_AUTO_REFRESH_STALE_LAST_UPDATED,
} from "../../../helpers/plugin-cdn-zip-marketplace.js";
import {
  capturePluginManualReview,
  getPluginOverview,
  hasPluginControl,
  openPluginSettings,
  requirePluginManualReview,
  waitForPluginControl,
  waitForPluginSettingsScope,
} from "../../../helpers/plugin-management-lifecycle.js";

// 真打公网 CDN：与 PLM-LC-007b 一致，刷新等待 180s。
// 运行方式（2026-09-08 本机验证通过）：
//   ZCODE_E2E_MANUAL_REVIEW=1 ZCODE_E2E_MANUAL_REVIEW_HOLD_MS=180000 \
//   E2E_PROVIDER_REPLAY_FIXTURE_PATH=packages/desktop/test/e2e/fixtures/upstream/common.json \
//   pnpm --filter @zcode/desktop test:e2e:serial -- --spec <本文件>
// - manual-review 默认 capture 模式会给 agent 挂 MITM 抓包代理，agent 的市场 fetch 不认其 CA，
//   官方市场刷新会以 "unable to get local issuer certificate" 失败；显式 replay fixture 让 worker
//   恢复直连即可。
// - wdio mocha 超时是配置级 120s 硬上限，用例内 this.timeout 无效，必须用 HOLD_MS 追加预算。
const CDN_REFRESH_TIMEOUT_MS = 180000;
const NO_REFRESH_SETTLE_MS = 5000;

function readOfficialLastUpdated(
  overview: Awaited<ReturnType<typeof getPluginOverview>>,
): string | undefined {
  return overview.marketplaces.find((item) => item.id === PLUGIN_CDN_ZIP_MARKETPLACE_ID)
    ?.lastUpdated;
}

describe("PLM-LC-019 Desktop plugin store auto refresh on enter (real official CDN)", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("官方市场刷新时间过期时，进入商店页不点刷新也会自动刷新，重进则命中节流", async function () {
    requirePluginManualReview();

    // wdio seed 把官方市场 lastUpdated 写成远古时间且 pluginCount>0，必然落在节流窗口外。
    expect(readOfficialLastUpdated(await getPluginOverview())).toBe(
      PLUGIN_STORE_AUTO_REFRESH_STALE_LAST_UPDATED,
    );
    const enteredAt = Date.now();

    await openPluginSettings();
    let refreshedLastUpdated: string | undefined;
    let official: Awaited<ReturnType<typeof getPluginOverview>>["marketplaces"][number] | undefined;
    await browser
      .waitUntil(
        async () => {
          official = (await getPluginOverview()).marketplaces.find(
            (item) => item.id === PLUGIN_CDN_ZIP_MARKETPLACE_ID,
          );
          // 刷新失败会被持久化成 refreshFailure；直接带着诊断失败，不要空等到超时。
          if (official?.refreshFailure) {
            throw new Error(
              `Official marketplace auto refresh failed: ${JSON.stringify(official.refreshFailure)}`,
            );
          }
          refreshedLastUpdated = official?.lastUpdated;
          return (
            refreshedLastUpdated !== undefined &&
            refreshedLastUpdated !== PLUGIN_STORE_AUTO_REFRESH_STALE_LAST_UPDATED
          );
        },
        {
          timeout: CDN_REFRESH_TIMEOUT_MS,
          interval: 2000,
          timeoutMsg: "Entering the plugin store did not auto refresh the official marketplace",
        },
      )
      .catch((error: unknown) => {
        // 超时时把官方市场记录一并带出，便于区分「没触发」与「触发了但落盘异常」。
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}; official=${JSON.stringify(official)}`,
        );
      });
    if (!refreshedLastUpdated) throw new Error("Official marketplace lastUpdated missing");
    // 允许 agent/renderer 时钟有秒级偏差。
    expect(Date.parse(refreshedLastUpdated)).toBeGreaterThanOrEqual(enteredAt - 60_000);
    expect(await hasPluginControl("plugin-store-error")).toBe(false);
    await capturePluginManualReview("PLM-LC-019", "auto-refreshed-on-enter");

    // 刚刷新过：离开再重进商店页命中 10 分钟窗口，不再刷新。
    // 重进路径与 conversation-session-plugin-marketplace-installed-roundtrip 一致：商店顶栏返回
    // 到设置页 → 退出设置 → 侧栏「插件市场」重新进入，保证 PluginStorePage 真正重新挂载。
    await clickTestIdByDom("desktop-top-nav-back");
    await waitForPluginSettingsScope("user");
    await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON);
    await clickTestIdByDom("plugin-store-sidebar-open");
    await waitForPluginControl("plugin-store-root", {}, 30000);
    await browser.pause(NO_REFRESH_SETTLE_MS);
    expect(readOfficialLastUpdated(await getPluginOverview())).toBe(refreshedLastUpdated);
  });
});
