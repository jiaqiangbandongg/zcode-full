import { clearAppData } from "../../../helpers/desktop-app.js";
import {
  assertUpstreamRequestCapture,
  assertUpstreamThoughtLevelCapture,
  waitForUpstreamNetworkCapture,
} from "../../../helpers/upstream-capture.js";
import {
  UPSTREAM_ALTERNATE_MODEL,
  UPSTREAM_ALTERNATE_PROVIDER_ID,
  UPSTREAM_ALTERNATE_PROVIDER_NAME,
  UPSTREAM_THOUGHT_LEVEL,
  getUpstreamProviderModelValues,
  getSelectedUpstreamModelLabel,
  selectUpstreamProviderModelById,
} from "../../../helpers/upstream-provider.js";
import {
  E2E_REPLY_TOKEN,
  prepareConversationE2E,
  sendPrompt,
  waitForAssistantMessageContaining,
  waitForChatState,
  waitForComposerText,
  waitForUserMessageContaining,
} from "../../../helpers/conversation-session.js";

describe("会话区跨 provider 模型切换 E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("I13: 选择 alternate provider 后请求应使用 alternate provider 的模型", async function () {
    this.timeout(180000);

    await prepareConversationE2E();

    await selectUpstreamProviderModelById(UPSTREAM_ALTERNATE_MODEL, {
      includePlainModelFallback: false,
      providerId: UPSTREAM_ALTERNATE_PROVIDER_ID,
      providerName: UPSTREAM_ALTERNATE_PROVIDER_NAME,
    });
    await assertSelectedAlternateProviderModel();

    const runId = Date.now();
    const marker = `E2E_SAME_MODEL_PROVIDER_IDENTITY_${runId}`;
    const prompt = `${marker}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
    await sendPrompt(prompt);
    await waitForComposerText("", "跨 provider 模型切换 case 首发后输入框没有清空");
    await waitForUserMessageContaining(marker);
    await assertSelectedAlternateProviderModel();

    const record = await waitForUpstreamNetworkCapture(marker);
    assertUpstreamRequestCapture(record, {
      expectedText: prompt,
      model: UPSTREAM_ALTERNATE_MODEL,
    });
    if (UPSTREAM_THOUGHT_LEVEL) {
      assertUpstreamThoughtLevelCapture(record, UPSTREAM_THOUGHT_LEVEL);
    }

    await waitForAssistantMessageContaining(E2E_REPLY_TOKEN);
    await waitForChatState(
      (snapshot) => snapshot.state === "idle" && snapshot.queueCount === 0,
      "跨 provider 模型切换 case 首轮完成后没有回到 idle",
      90000,
    );
  });
});

async function assertSelectedAlternateProviderModel() {
  const label = await getSelectedUpstreamModelLabel();
  // 窄屏可以隐藏名称前缀，但完整 title 必须保留 Registry 投影的实例名称。
  expect(label.title).toBe(`${UPSTREAM_ALTERNATE_PROVIDER_NAME}/${UPSTREAM_ALTERNATE_MODEL}`);
  const acceptedValues = getUpstreamProviderModelValues(UPSTREAM_ALTERNATE_MODEL, {
    includePlainModelFallback: false,
    providerId: UPSTREAM_ALTERNATE_PROVIDER_ID,
  });
  if (!acceptedValues.includes(label.currentValue)) {
    throw new Error(
      `当前模型没有保留 alternate provider 身份和模型: ${JSON.stringify({
        acceptedValues,
        label,
        model: UPSTREAM_ALTERNATE_MODEL,
        providerId: UPSTREAM_ALTERNATE_PROVIDER_ID,
      })}`,
    );
  }
}
