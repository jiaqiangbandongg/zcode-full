import { clearAppData } from "../helpers/desktop-app.js";
import {
  selectUpstreamProviderModelById,
  selectUpstreamThoughtLevelValue,
} from "../helpers/upstream-provider.js";
import {
  E2E_BIGMODEL_PLAN_PROVIDER_ID,
  E2E_PLAN_DEFAULT_MODEL,
  E2E_PLAN_TURBO_MODEL,
  restartIntoWorkspace,
  seedTurboAgentStartupModel,
  seedGlobalAgentReasoningLevel,
  seedBigModelOAuthCredential,
  seedBigModelConnectionSelection,
  seedPersistedModelSelection,
  waitForDraftThoughtLevelState,
  waitForSelectedModel,
  waitForV4DraftModelConfig,
} from "../helpers/model-provider-restart.js";
import { prepareV4ConversationE2E } from "../helpers/v4-conversation.js";

describe("模型 Provider Turbo 跨能力切换 E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  beforeEach(async () => {
    await prepareV4ConversationE2E({ skipProvider: true });
  });

  it("I38/MP-T04: workspace 迟到回包不能污染 Turbo draft 能力", async function () {
    this.timeout(180000);
    await prepareTurboDraft("off");
    await selectUpstreamThoughtLevelValue("enabled");
    await browser.pause(1500);
    await waitForSelectedModel(E2E_BIGMODEL_PLAN_PROVIDER_ID, E2E_PLAN_TURBO_MODEL);
    await waitForDraftThoughtLevelState({ current: "enabled", values: ["off", "enabled"] });
  });

  it("I39/MP-T05: GLM-5.2 切 Turbo 时原子更新思考能力", async function () {
    this.timeout(180000);
    await seedPersistedModelSelection({
      modelId: E2E_PLAN_DEFAULT_MODEL,
      providerId: E2E_BIGMODEL_PLAN_PROVIDER_ID,
      reasoningLevel: "high",
    });
    await restartWithTurboProviderFixture({ thoughtLevel: "high" });
    await selectUpstreamProviderModelById(E2E_PLAN_TURBO_MODEL, {
      providerId: E2E_BIGMODEL_PLAN_PROVIDER_ID,
      providerName: "BigModel Coding Plan E2E",
      includePlainModelFallback: false,
    });
    await waitForSelectedModel(E2E_BIGMODEL_PLAN_PROVIDER_ID, E2E_PLAN_TURBO_MODEL);
    // Bug 根因：V4 草稿跨模型切换以 toolbar projection 为显示真值，不再把乐观
    // 配置反写旧 zcodeSessionStore.configOptions。原子切换应读取 V4 稳定投影。
    await waitForV4DraftModelConfig({ model: E2E_PLAN_TURBO_MODEL, thought: "enabled" });
    await waitForDraftThoughtLevelState({ current: "enabled", values: ["off", "enabled"] });
  });

  it("I42/MP-T06: Turbo 切 GLM-5.2 时丢弃源模型 thought", async function () {
    this.timeout(180000);
    await seedPersistedModelSelection({
      modelId: E2E_PLAN_TURBO_MODEL,
      providerId: E2E_BIGMODEL_PLAN_PROVIDER_ID,
      reasoningLevel: "enabled",
    });
    await restartWithTurboProviderFixture({
      startupModel: E2E_PLAN_TURBO_MODEL,
      thoughtLevel: "enabled",
      // I39 的旧 Agent 仍持有 SQLite writer；必须等完整进程树退出后再隔离全局偏好，
      // 否则退出阶段的迟到写回会把 enabled 覆盖成上一 case 的 high。
    });
    await selectUpstreamProviderModelById(E2E_PLAN_DEFAULT_MODEL, {
      providerId: E2E_BIGMODEL_PLAN_PROVIDER_ID,
      providerName: "BigModel Coding Plan E2E",
      includePlainModelFallback: false,
    });
    await waitForSelectedModel(E2E_BIGMODEL_PLAN_PROVIDER_ID, E2E_PLAN_DEFAULT_MODEL);
    await waitForV4DraftModelConfig({ model: E2E_PLAN_DEFAULT_MODEL, thought: "max" });
    await waitForDraftThoughtLevelState({
      current: "max",
      values: ["nothink", "high", "max"],
    });
  });
});

async function prepareTurboDraft(thoughtLevel: "off" | "enabled") {
  await seedPersistedModelSelection({
    modelId: E2E_PLAN_TURBO_MODEL,
    providerId: E2E_BIGMODEL_PLAN_PROVIDER_ID,
    reasoningLevel: thoughtLevel,
  });
  await restartWithTurboProviderFixture({
    startupModel: E2E_PLAN_TURBO_MODEL,
    thoughtLevel,
  });
  await waitForSelectedModel(E2E_BIGMODEL_PLAN_PROVIDER_ID, E2E_PLAN_TURBO_MODEL);
  await waitForDraftThoughtLevelState({ current: thoughtLevel, values: ["off", "enabled"] });
}

async function restartWithTurboProviderFixture(options: {
  startupModel?: string;
  thoughtLevel: "off" | "enabled" | "high";
}) {
  // Bug 根因：direct seed 与旧 Host/Agent 的退出写回并发时，新 provider 目录会被
  // 旧快照覆盖。所有磁盘 fixture 都放到 Electron 进程树退出后的同一屏障中。
  await restartIntoWorkspace({
    afterElectronProcessExit: async () => {
      await seedBigModelConnectionSelection({
        kind: "team-coding-plan",
        productId: "product-team-a",
        organizationId: "org-team-a",
        projectId: "proj-team-a",
      });
      await seedBigModelOAuthCredential();
      if (options.startupModel) {
        await seedTurboAgentStartupModel(E2E_BIGMODEL_PLAN_PROVIDER_ID, options.startupModel);
      }
      await seedGlobalAgentReasoningLevel(options.thoughtLevel);
    },
  });
}
