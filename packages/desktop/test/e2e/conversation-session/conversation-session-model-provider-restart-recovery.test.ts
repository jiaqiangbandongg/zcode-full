import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  TID_CHAT_MODEL_SELECT_ITEM,
  TID_CHAT_MODEL_SELECT_TRIGGER,
  encodeCustomModelValue,
  testId,
} from "@zcode/shared";
import {
  clearAppData,
  clickTestIdByWebDriver,
  getE2EAppDataPaths,
  readSettings,
} from "../helpers/desktop-app.js";
import { restartIntoWorkspacePreservingProfile } from "../helpers/model-provider-restart-runtime.js";
import {
  assertUpstreamRequestCapture,
  waitForUpstreamNetworkCapture,
  waitForUpstreamNetworkRequestStarted,
} from "../helpers/upstream-capture.js";
import { UPSTREAM_MODEL, UPSTREAM_PROVIDER_ID } from "../helpers/upstream-provider.js";
import {
  E2E_BIGMODEL_PLAN_PROVIDER_ID,
  E2E_BIGMODEL_START_PROVIDER_ID,
  E2E_PLAN_NON_DEFAULT_MODEL,
  restartIntoWorkspace,
  seedBigModelOAuthCredential,
  seedBigModelConnectionSelection,
  seedPersistedModelSelection,
  seedReplayProvider,
  waitForSelectedModel,
} from "../helpers/model-provider-restart.js";
import {
  E2E_REPLY_TOKEN,
  getV4ModelConfig,
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4ComposerSelectionReady,
  waitForV4Pane,
  waitForV4TimelineContaining,
} from "../helpers/v4-conversation.js";

describe("模型 Provider 重启恢复 E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  beforeEach(async () => {
    await prepareV4ConversationE2E({ skipProvider: true });
    await seedReplayProvider({
      id: UPSTREAM_PROVIDER_ID,
      models: [UPSTREAM_MODEL],
      name: "Upstream E2E",
    });
  });

  it("I25/MP-R01: 重启保留仍可用的 上游 last-selected", async function () {
    this.timeout(180000);
    await seedPersistedModelSelection({
      modelId: UPSTREAM_MODEL,
      providerId: UPSTREAM_PROVIDER_ID,
      reasoningLevel: "max",
    });
    await restartIntoWorkspace();
    await waitForSelectedModel(UPSTREAM_PROVIDER_ID, UPSTREAM_MODEL);
    await waitForRestartedDraftModelReady(UPSTREAM_PROVIDER_ID, UPSTREAM_MODEL);
    await assertRequestUsesModel("E2E_MODEL_PROVIDER_RESTART_R01", UPSTREAM_MODEL);
  });

  it("I26/MP-R02: 重启保留当前 Plan 内非首个模型", async function () {
    this.timeout(180000);
    // Bug 根因：运行中的 Host 会在退出时落盘内存里的连接选择；若 fixture 预先
    // 直写 setting.json，退出阶段会把 Individual 选择覆盖回上一条 Team 状态。
    // 与真实冷启动一致，账号选择和凭据都必须在进程退出屏障后写入。
    await restartIntoWorkspace({
      afterElectronProcessExit: async () => {
        await seedBigModelConnectionSelection({
          kind: "team-coding-plan",
          productId: "product-team-a",
          organizationId: "org-team-a",
          projectId: "proj-team-a",
        });
        await seedBigModelOAuthCredential();
      },
    });
    // 只写 Recent 不代表已经修改新版 Composer 草稿；用真实点选建立用户实际持久选择。
    await waitForV4ComposerSelectionReady();
    await clickTestIdByWebDriver(TID_CHAT_MODEL_SELECT_TRIGGER);
    await clickTestIdByWebDriver(
      testId(
        TID_CHAT_MODEL_SELECT_ITEM,
        encodeCustomModelValue(E2E_BIGMODEL_PLAN_PROVIDER_ID, E2E_PLAN_NON_DEFAULT_MODEL),
      ),
    );
    await waitForSelectedModel(E2E_BIGMODEL_PLAN_PROVIDER_ID, E2E_PLAN_NON_DEFAULT_MODEL);
    await restartIntoWorkspacePreservingProfile(getE2EAppDataPaths().workspace);
    await waitForSelectedModel(E2E_BIGMODEL_PLAN_PROVIDER_ID, E2E_PLAN_NON_DEFAULT_MODEL);
    // Todo88：仅在退出后注入同一 Team 的旧连接字段；不能用新字段 seed 冒充升级迁移。
    const settingsPath = join(getE2EAppDataPaths().appDataDir, "setting.json");
    for (const key of [
      "team-plan:builtin:bigmodel-coding-plan:product-team-a:org-team-a:proj-team-a",
      "team-plan:builtin:bigmodel-coding-plan:product-team-a:proj-team-a",
    ]) {
      const legacyKeys = { bigmodel: key };
      await restartIntoWorkspacePreservingProfile(getE2EAppDataPaths().workspace, {
        afterElectronProcessExit: async () => {
          const settings = JSON.parse(await readFile(settingsPath, "utf8"));
          delete settings.providerFamilyConnectionSelections;
          await writeFile(
            settingsPath,
            JSON.stringify({
              ...settings,
              modelProviderFamilyModes: { bigmodel: "oauth" },
              modelProviderFamilySelectedKeys: legacyKeys,
            }),
          );
        },
      });
      await waitForSelectedModel(E2E_BIGMODEL_PLAN_PROVIDER_ID, E2E_PLAN_NON_DEFAULT_MODEL);
      expect((await readSettings()).providerFamilyConnectionSelections?.bigmodel).toEqual({
        kind: "team-coding-plan",
        productId: "product-team-a",
        organizationId: "org-team-a",
        projectId: "proj-team-a",
      });
      expect(
        JSON.parse(await readFile(settingsPath, "utf8")).modelProviderFamilySelectedKeys,
      ).toEqual(legacyKeys);
    }
    await assertPlanRequest("E2E_MODEL_PROVIDER_RESTART_R02");
  });

  it("I27/MP-R03: 同 Family 的旧 Start Plan 选择回退 Configured Default", async function () {
    this.timeout(180000);
    await seedPersistedModelSelection({
      modelId: E2E_PLAN_NON_DEFAULT_MODEL,
      providerId: E2E_BIGMODEL_START_PROVIDER_ID,
      reasoningLevel: "max",
    });
    await restartWithTeamPlanSelection();
    await waitForSelectedModel(UPSTREAM_PROVIDER_ID, UPSTREAM_MODEL);
    await waitForRestartedDraftModelReady(UPSTREAM_PROVIDER_ID, UPSTREAM_MODEL);
    await assertRequestUsesModel("E2E_MODEL_PROVIDER_RESTART_R03", UPSTREAM_MODEL);
  });

  it("I28/MP-R04: 已不可用 last-selected 回退 Configured Default", async function () {
    this.timeout(180000);
    await seedPersistedModelSelection({
      modelId: "upstream-removed-e2e",
      providerId: UPSTREAM_PROVIDER_ID,
      reasoningLevel: "max",
    });
    await restartWithTeamPlanSelection();
    await waitForSelectedModel(UPSTREAM_PROVIDER_ID, UPSTREAM_MODEL);
    await waitForRestartedDraftModelReady(UPSTREAM_PROVIDER_ID, UPSTREAM_MODEL);
    await assertRequestUsesModel("E2E_MODEL_PROVIDER_RESTART_R04", UPSTREAM_MODEL);
  });
});

async function restartWithTeamPlanSelection() {
  await restartIntoWorkspace({
    afterElectronProcessExit: async () => {
      await seedBigModelConnectionSelection({
        kind: "team-coding-plan",
        productId: "product-team-a",
        organizationId: "org-team-a",
        projectId: "proj-team-a",
      });
      await seedBigModelOAuthCredential();
    },
  });
}

async function assertRequestUsesModel(marker: string, model: string) {
  const prompt = `${marker}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
  await sendV4Prompt(prompt);
  // Bug 根因：重启后 toolbar 会早于 draft runtime binding 完成水合；旧 case
  // 发送后直接等待 complete capture，无法区分“点击没有进入 runtime”和“请求响应慢”。
  // request-start 是物理 admission 屏障，complete capture 再负责模型与响应断言。
  await waitForUpstreamNetworkRequestStarted(marker);
  const capture = await waitForUpstreamNetworkCapture(marker);
  assertUpstreamRequestCapture(capture, { expectedText: prompt, model });
  await waitForV4TimelineContaining(E2E_REPLY_TOKEN);
  await waitForV4Pane((snapshot) => !snapshot.canStop, `${marker} 没有完成`, 90000);
}

async function waitForRestartedDraftModelReady(provider: string, model: string) {
  await waitForV4ComposerSelectionReady();
  let latest = await getV4ModelConfig();
  let stableSince = 0;
  await browser.waitUntil(
    async () => {
      latest = await getV4ModelConfig();
      const matched =
        latest.source === "composer" && latest.provider === provider && latest.model === model;
      if (!matched) {
        stableSince = 0;
        return false;
      }
      stableSince ||= Date.now();
      return Date.now() - stableSince >= 300;
    },
    {
      timeout: 30000,
      timeoutMsg: `重启后的 draft provider/runtime 没有稳定就绪: ${JSON.stringify({
        expected: { model, provider },
        latest,
      })}`,
    },
  );
}

async function assertPlanRequest(marker: string) {
  const prompt = `${marker}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
  await sendV4Prompt(prompt);
  await waitForV4TimelineContaining(E2E_REPLY_TOKEN);
  await waitForV4Pane((snapshot) => !snapshot.canStop, `${marker} 没有完成`, 90000);
}
