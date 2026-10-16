import type { IZCodeTaskService } from "@zcode/services";
import { restartWithSeededOpenAIProviders } from "../../../helpers/custom-openai-provider.js";
import {
  selectUpstreamProviderModelById,
  waitForUpstreamModelSelected,
} from "../../../helpers/upstream-provider.js";
import { startConversationModelProviderReplayServer } from "../../../helpers/model-provider-replay.js";
import { clearAppData } from "../../../helpers/desktop-app.js";
import { getTaskStoreSnapshot } from "../../../helpers/conversation-session-store.js";
import {
  prepareV4ConversationE2E,
  sendV4PromptAndWaitAccepted,
  waitForV4TimelineContaining,
  waitForV4Pane,
  getV4PaneSnapshot,
  waitForV4QueueCount,
  clickV4Stop,
  setV4ElectronWindowSize,
} from "../../../helpers/v4-conversation.js";

// 待用户手动执行。真实 Host/CLI 与 DOM，材料为合成输入；不代表原生飞书验收。
describe("BOT-E2E-TP-01 topic start-now and original messages", () => {
  let replay: Awaited<ReturnType<typeof startConversationModelProviderReplayServer>>;
  before(async () => {
    replay = await startConversationModelProviderReplayServer("feishu-group-runtime");
  });
  after(async () => {
    if ((await getV4PaneSnapshot()).canStop) await clickV4Stop();
    await browser.electron.restoreAllMocks();
    await clearAppData();
    await replay?.stop();
  });
  it("starts the topic batch without queue and renders each original message", async () => {
    await prepareV4ConversationE2E({ skipProvider: true });
    const [provider] = await restartWithSeededOpenAIProviders([
      {
        modelId: "deepseek-v4-flash",
        providerId: "e2e-group-runtime",
        providerName: "Group Runtime E2E",
      },
    ]);
    if (!provider) throw new Error("Group runtime replay provider missing");
    await prepareV4ConversationE2E({ skipProvider: true });
    await selectUpstreamProviderModelById("deepseek-v4-flash", {
      includePlainModelFallback: false,
      providerId: provider.id,
      providerName: provider.name,
    });
    await waitForUpstreamModelSelected("deepseek-v4-flash", {
      includePlainModelFallback: false,
      providerId: provider.id,
    });
    // 冷启动接收曾耗时 36 秒；先等待真实 user row，避免把模型响应预算花在 Host 初始化上。
    await sendV4PromptAndWaitAccepted(
      "E2E_GROUP_RUNTIME_SLOW 慢慢回答",
      "E2E_GROUP_RUNTIME_SLOW",
      "initial desktop input was not accepted",
      90000,
    );
    await waitForV4TimelineContaining("V4_QUEUE_STREAMING", 45000);
    await waitForV4Pane(
      (s) => s.canStop && !!s.sessionId && s.sessionId !== "draft",
      "initial turn is not running",
      45000,
    );
    const pane = await getV4PaneSnapshot();
    const task = await getTaskStoreSnapshot(pane.sessionId!);
    const workspacePath = task.workspaceKey!;
    const botId = "feishu-runtime-e2e";
    const chatId = "oc_runtime_e2e";
    const threadId = "omt_runtime_e2e";
    const originalSize = await browser.execute(() => ({
      width: window.outerWidth,
      height: window.outerHeight,
    }));
    // startNow 必须在权威停止之后提交；Bot 协调器的停止竞争由服务层测试覆盖。
    await clickV4Stop();
    await waitForV4Pane((state) => !state.canStop, "previous run did not stop", 30000);
    const ack = await browser.execute(
      async (params) => {
        const actions = (
          window as unknown as {
            __testActions: {
              submitBotGroupInput: NonNullable<IZCodeTaskService["submitBotGroupInput"]>;
            };
          }
        ).__testActions;
        return actions.submitBotGroupInput(params);
      },
      {
        workspacePath,
        taskId: pane.sessionId!,
        commandId: "e2e-topic-material-input",
        content: "E2E_GROUP_RUNTIME_SLOW E2E_TOPIC_MATERIALS",
        conversationQuotes: [{ text: "E2E_TOPIC_ROOT_ORIGINAL", senderName: "Root author" }],
        attachments: [
          {
            kind: "file",
            sourceKind: "topic-history",
            messageCount: 1,
            filename: "topic-history-e2e.txt",
            mimeType: "text/plain",
            sizeBytes: Buffer.byteLength(
              "Sender: E2E 群成员 | open_id: ou_member\nE2E_HISTORY_ORIGINAL\nOriginal second line",
            ),
            textContent:
              "Sender: E2E 群成员 | open_id: ou_member\nE2E_HISTORY_ORIGINAL\nOriginal second line",
          },
        ],
        source: {
          provider: "feishu",
          botId,
          chatId,
          threadId,
          senderId: "ou_member",
          senderName: "E2E 群成员",
          messageId: "om_material_second",
          messages: [
            {
              messageId: "om_material_first",
              senderId: "ou_first",
              senderName: "First author",
              text: "E2E_TOPIC_FIRST",
              attachmentIndexes: [],
              conversationQuotes: [{ text: "E2E_TOPIC_ROOT_ORIGINAL", senderName: "Root author" }],
            },
            {
              messageId: "om_material_second",
              senderId: "ou_member",
              senderName: "Second author",
              text: "E2E_TOPIC_SECOND",
              attachmentIndexes: [],
            },
          ],
          authorizationId: "e2e-authorization",
        },
      } satisfies Parameters<NonNullable<IZCodeTaskService["submitBotGroupInput"]>>[0],
    );
    expect(ack.result).toMatchObject({ type: "inputAccepted", delivery: "startNow" });
    await waitForV4QueueCount(0, 30000);
    const first = await $('[data-topic-message-id="om_material_first"]');
    const second = await $('[data-topic-message-id="om_material_second"]');
    await first.waitForDisplayed({ timeout: 30000 });
    await second.waitForDisplayed({ timeout: 30000 });
    expect(await first.getText()).toContain("E2E_TOPIC_FIRST");
    expect(await first.getText()).toContain("First author");
    expect(await second.getText()).toContain("E2E_TOPIC_SECOND");
    expect(await second.getText()).toContain("Second author");
    expect(await first.$("[data-v4-user-input-quotes]").isExisting()).toBe(true);
    expect(await second.$("[data-v4-user-input-quotes]").isExisting()).toBe(false);
    expect(await second.$("[data-v4-user-input-attachment-pill]").isExisting()).toBe(false);
    const historyFile = await $(
      '[data-v4-user-input-attachment-pill][aria-label="Open text attachment"]',
    );
    await historyFile.waitForDisplayed({ timeout: 30000 });
    expect(await historyFile.getText()).toContain("Topic history");
    for (const width of [1280, 430]) {
      await setV4ElectronWindowSize(width, 900);
      await historyFile.click();
      const preview = await $("[data-text-attachment-preview]");
      await preview.waitForDisplayed({ timeout: 15000 });
      expect(await preview.getText()).toContain("E2E_HISTORY_ORIGINAL");
      expect(await preview.getText()).toContain("ou_member");
      expect(await preview.getText()).toContain("Original second line");
      await browser.keys("Escape");
      await preview.waitForDisplayed({ reverse: true, timeout: 5000 });
    }
    await setV4ElectronWindowSize(originalSize.width, originalSize.height);
    await clickV4Stop();
    await waitForV4Pane((state) => !state.canStop, "topic task did not stop", 30000);
  });
});
