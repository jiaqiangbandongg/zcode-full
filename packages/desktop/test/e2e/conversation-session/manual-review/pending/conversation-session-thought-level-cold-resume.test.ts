import { clearAppData, waitForDefaultWorkspaceReady } from "../../../helpers/desktop-app.js";
import {
  assertUpstreamRequestCapture,
  waitForUpstreamNetworkCapture,
} from "../../../helpers/upstream-capture.js";
import {
  restartIntoWorkspace,
  seedPersistedModelSelection,
  seedReplayProvider,
} from "../../../helpers/model-provider-restart.js";
import { startConversationModelProviderReplayServer } from "../../../helpers/model-provider-replay.js";
import {
  E2E_REPLY_TOKEN,
  getV4ModelConfig,
  prepareV4ConversationE2E,
  selectV4TaskById,
  sendV4Prompt,
  waitForV4Pane,
  waitForV4TimelineContaining,
} from "../../../helpers/v4-conversation.js";

const PROVIDER_ID = "e2e-glm52-cold-resume";
const MODEL_ID = "GLM-5.2";
const THOUGHT_LEVEL = "max";
let replayServer: Awaited<ReturnType<typeof startConversationModelProviderReplayServer>> | null =
  null;

describe("历史 session 思考深度冷恢复 E2E", () => {
  before(async () => {
    replayServer = await startConversationModelProviderReplayServer(
      "conversation-session-thought-level-cold-resume",
    );
  });

  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
    await replayServer?.stop();
    replayServer = null;
  });

  it("I63: Desktop/Host/CLI 冷重启后同一 completed task 仍保持 GLM-5.2 max", async function () {
    this.timeout(260000);
    await prepareV4ConversationE2E({ skipProvider: true });
    await seedReplayProvider({
      id: PROVIDER_ID,
      models: [MODEL_ID],
      name: "GLM-5.2 Cold Resume E2E",
    });
    await seedPersistedModelSelection({
      modelId: MODEL_ID,
      providerId: PROVIDER_ID,
      reasoningLevel: THOUGHT_LEVEL,
    });
    await restartIntoWorkspace();
    await prepareV4ConversationE2E({ skipProvider: true });
    await waitForModelConfig();

    const runId = Date.now();
    const seedMarker = `E2E_THOUGHT_COLD_RESUME_SEED_${runId}`;
    const seedPrompt = buildPrompt(seedMarker);
    await sendV4Prompt(seedPrompt);
    await waitForV4TimelineContaining(E2E_REPLY_TOKEN, 60000);
    const seedRequest = await waitForUpstreamNetworkCapture(seedMarker);
    assertUpstreamRequestCapture(seedRequest, { expectedText: seedPrompt, model: MODEL_ID });
    assertGlm52MaxRequest(seedRequest.requestJson);
    const completed = await waitForV4Pane(
      (snapshot) =>
        snapshot.sessionId !== null && snapshot.sessionId !== "draft" && !snapshot.canStop,
      "GLM-5.2 max 首轮没有完成",
      90000,
    );
    const sessionId = completed.sessionId;
    if (!sessionId || sessionId === "draft") throw new Error("completed sessionId missing");

    // browser.reloadSession 会完整重启 Electron、Host 与 CLI；renderer reload 不能代替这条边界。
    await browser.reloadSession();
    await waitForRendererAfterReloadSession();
    await waitForDefaultWorkspaceReady(60000);
    await selectV4TaskById(sessionId);
    await waitForModelConfig();

    const followMarker = `E2E_THOUGHT_COLD_RESUME_FOLLOW_${runId}`;
    const followPrompt = buildPrompt(followMarker);
    await sendV4Prompt(followPrompt);
    const followRequest = await waitForUpstreamNetworkCapture(followMarker);
    assertUpstreamRequestCapture(followRequest, { expectedText: followPrompt, model: MODEL_ID });
    assertGlm52MaxRequest(followRequest.requestJson);
    await waitForV4TimelineContaining(E2E_REPLY_TOKEN, 60000);
  });
});

function buildPrompt(marker: string) {
  return `${marker}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
}

async function waitForModelConfig() {
  let latest = await getV4ModelConfig();
  await browser.waitUntil(
    async () => {
      latest = await getV4ModelConfig();
      return (
        latest.provider === PROVIDER_ID &&
        latest.model === MODEL_ID &&
        latest.thought === THOUGHT_LEVEL
      );
    },
    {
      timeout: 30000,
      timeoutMsg: `V4 历史配置没有恢复 GLM-5.2/max: ${JSON.stringify(latest)}`,
    },
  );
}

function assertGlm52MaxRequest(requestJson: unknown) {
  expect(readNested(requestJson, ["chat_template_kwargs", "reasoning_effort"])).toBe(THOUGHT_LEVEL);
  expect(readNested(requestJson, ["chat_template_kwargs", "enable_thinking"])).toBeUndefined();
  expect(readNested(requestJson, ["extra_body"])).toBeUndefined();
}

function readNested(value: unknown, path: string[]) {
  let current: unknown = value;
  for (const key of path) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

async function waitForRendererAfterReloadSession() {
  await browser.waitUntil(
    async () => {
      try {
        const puppeteer = await browser.getPuppeteer();
        const target = puppeteer
          .targets()
          .filter((candidate) => isRendererUrl(candidate.url()))
          .at(-1) as ({ _targetId?: string } & object) | undefined;
        if (!target?._targetId) return false;
        await browser.switchToWindow(target._targetId);
        return true;
      } catch {
        return false;
      }
    },
    {
      timeout: 30000,
      interval: 250,
      timeoutMsg: "CLI cold restart 后没有找到 renderer target",
    },
  );
}

function isRendererUrl(url: string) {
  try {
    return new URL(url).pathname.endsWith("/renderer/index.html");
  } catch {
    return false;
  }
}
