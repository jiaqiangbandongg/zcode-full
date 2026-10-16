import { encodeCustomModelValue } from "@zcode/shared";
import { clearAppData } from "../../../helpers/desktop-app.js";
import {
  assertUpstreamRequestCapture,
  waitForUpstreamNetworkCapture,
} from "../../../helpers/upstream-capture.js";
import type { E2ENetworkCaptureRecord } from "../../../helpers/network-capture-proxy.js";
import {
  refreshSeededOpenAIProvidersThroughSettings,
  seedCustomOpenAIChatCompletionsProvider,
} from "../../../helpers/custom-openai-provider.js";
import {
  readLastSelectedAgentConfig,
  restartIntoWorkspacePreservingProfile,
  seedPersistedModelSelection,
  waitForSelectedModel,
} from "../../../helpers/model-provider-restart.js";
import { startConversationModelProviderReplayServer } from "../../../helpers/model-provider-replay.js";
import {
  E2E_REPLY_TOKEN,
  getV4ModelConfig,
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4ComposerSelectionReady,
  waitForV4Pane,
  waitForV4TimelineContaining,
} from "../../../helpers/v4-conversation.js";

const PROVIDER_ID = "e2e-provider-registry-prewarm";
const PROVIDER_NAME = "Provider Registry Prewarm E2E";
const MODEL_ID = "GLM-5.2";
let modelProviderReplayServer: Awaited<
  ReturnType<typeof startConversationModelProviderReplayServer>
> | null = null;

describe("草稿预热 process provider registry 就绪屏障 E2E", () => {
  before(async () => {
    modelProviderReplayServer = await startConversationModelProviderReplayServer(
      "conversation-session-provider-registry-prewarm",
    );
  });

  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
    await modelProviderReplayServer?.stop();
    modelProviderReplayServer = null;
  });

  it("I64/P0-18: 冷启动草稿 createSession 应等待 process registry 就绪", async function () {
    this.timeout(300000);

    await prepareV4ConversationE2E({ skipProvider: true });
    await seedCustomOpenAIChatCompletionsProvider({
      modelId: MODEL_ID,
      providerId: PROVIDER_ID,
      providerName: PROVIDER_NAME,
    });
    await refreshSeededOpenAIProvidersThroughSettings([PROVIDER_NAME]);
    await seedPersistedModelSelection({
      modelId: MODEL_ID,
      providerId: PROVIDER_ID,
      reasoningLevel: "max",
    });

    await restartIntoWorkspacePreservingProfile();
    await waitForV4ComposerSelectionReady(60000);

    const config = await getV4ModelConfig();
    expect(config).toMatchObject({
      model: MODEL_ID,
      provider: PROVIDER_ID,
      source: "composer",
    });
    await waitForSelectedModel(PROVIDER_ID, MODEL_ID);
    expect(await readLastSelectedAgentConfig()).toMatchObject({
      model: encodeCustomModelValue(PROVIDER_ID, MODEL_ID),
      schemaVersion: 1,
    });

    const runId = Date.now();
    const marker = `E2E_PROVIDER_REGISTRY_PREWARM_${runId}`;
    const prompt = `${marker}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
    await sendV4Prompt(prompt);
    const capture = await waitForUpstreamNetworkCapture(marker);
    assertUpstreamRequestCapture(capture, {
      expectedText: prompt,
      model: MODEL_ID,
    });
    assertRequestUsesConfiguredProviderEndpoint(capture);
    await waitForV4TimelineContaining(E2E_REPLY_TOKEN);
    await waitForV4Pane(
      (snapshot) => !snapshot.canStop,
      "provider registry 冷启动首轮没有完成",
      90000,
    );
  });
});

function assertRequestUsesConfiguredProviderEndpoint(record: E2ENetworkCaptureRecord) {
  const expectedBaseURL = modelProviderReplayServer?.baseUrl.trim().replace(/\/+$/u, "");
  if (!expectedBaseURL) {
    throw new Error("provider registry prewarm replay server 尚未初始化");
  }
  if (record.url !== expectedBaseURL && !record.url.startsWith(`${expectedBaseURL}/`)) {
    throw new Error(
      `冷启动首个请求没有命中配置的 custom Provider Endpoint: ${JSON.stringify({
        expectedBaseURL,
        requestUrl: record.url,
      })}`,
    );
  }
}
