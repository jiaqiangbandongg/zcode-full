import { clearAppData } from "../helpers/desktop-app.js";
import {
  assertUpstreamRequestCapture,
  waitForUpstreamNetworkCapture,
} from "../helpers/upstream-capture.js";
import {
  countUpstreamRequests,
  getUpstreamRequestEvidence,
} from "../helpers/conversation-session-network.js";
import { UPSTREAM_MODEL } from "../helpers/upstream-provider.js";
import {
  getV4Messages,
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4AssistantMessageContaining,
  waitForV4ConversationState,
} from "../helpers/v4-conversation.js";

const EMPTY_COMPLETION_MARKER = "E2E_EMPTY_COMPLETION_RETRY_STREAM";
const EMPTY_COMPLETION_REPLY = "EMPTY_COMPLETION_RETRY_OK";

describe("generic empty completion retry E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("I73: 首个 finish=other 空流不泄漏，并且只重试一次后显示成功回复", async function () {
    this.timeout(180000);

    await prepareV4ConversationE2E();
    const prompt = `${EMPTY_COMPLETION_MARKER}: Reply with exactly "${EMPTY_COMPLETION_REPLY}" and no other text.`;
    await sendV4Prompt(prompt);

    await waitForV4AssistantMessageContaining(EMPTY_COMPLETION_REPLY);
    await waitForV4ConversationState(
      (snapshot) => snapshot.state === "idle" && snapshot.queueCount === 0,
      "空 completion 重试成功后没有回到 idle",
      90000,
    );

    await browser.waitUntil(
      async () =>
        (await countUpstreamRequests({ includes: [EMPTY_COMPLETION_MARKER] })) === 2,
      {
        timeout: 30000,
        timeoutMsg: "空 completion 没有严格产生 first-empty → second-success 两次请求",
      },
    );

    const request = await waitForUpstreamNetworkCapture(EMPTY_COMPLETION_MARKER);
    assertUpstreamRequestCapture(request, {
      expectedText: prompt,
      model: UPSTREAM_MODEL,
    });

    const evidence = await getUpstreamRequestEvidence({
      includes: [EMPTY_COMPLETION_MARKER],
    });
    expect(evidence).toHaveLength(2);
    expect(evidence.map((item) => item.fixtureId)).toEqual([
      "empty-completion-retry-stream-first-empty",
      "empty-completion-retry-stream-second-success",
    ]);
    expect(evidence.every((item) => item.status === "complete")).toBe(true);
    expect(evidence.every((item) => item.responseBodyBytes > 0)).toBe(true);
    expect(evidence[0]?.responseTextPreview).toContain('"stop_reason":"other"');
    expect(evidence[0]?.responseTextPreview).toContain('"output_tokens":0');
    expect(evidence[1]?.responseTextPreview).toContain(EMPTY_COMPLETION_REPLY);

    const assistantMessages = await getV4Messages("assistant");
    expect(assistantMessages).toHaveLength(1);
    expect(assistantMessages[0]?.text).toContain(EMPTY_COMPLETION_REPLY);
  });
});
