import { TID_CHAT_ERROR_BANNER } from "@zcode/shared/test-ids";
import { clearAppData } from "../../../helpers/desktop-app.js";
import { prepareHighspeedDrawWorkspace } from "../../../helpers/highspeed-card.js";
import { E2E_BIGMODEL_PLAN_PROVIDER_ID } from "../../../helpers/model-provider-restart.js";
import {
  clickV4QueueItemDelete,
  clickV4QueueItemEdit,
  clickV4Stop,
  getV4ComposerText,
  getV4ModelConfig,
  getV4QueueItems,
  sendV4Prompt,
  waitForV4Pane,
  waitForV4QueueCount,
  waitForV4TimelineContaining,
} from "../../../helpers/v4-conversation.js";

const RUNNING_PROMPT = "E2E_HIGHSPEED_QUEUE_EDIT_SLOW keep running";
const QUEUED_PROMPT = "E2E_HIGHSPEED_QUEUE_EDIT_PENDING original";
const RESUBMITTED_PROMPT = "E2E_HIGHSPEED_QUEUE_EDIT_RESUBMITTED changed";
const RUNNING_REPLY_TOKEN = "HIGHSPEED_QUEUE_EDIT_STREAMING";
const INTERNAL_HIGHSPEED_PROVIDER = "account:bigmodel-highspeed-card";

// Host Mock 场景：hit-queue-edit（按 spec 文件注入，见 helpers/highspeed-mock-env.ts）。
describe("Highspeed queued prompt edit E2E", () => {
  afterEach(async () => {
    const queued = await getV4QueueItems();
    for (const item of queued) {
      await clickV4QueueItemDelete(item.queueItemId);
    }
    if (queued.length > 0) await waitForV4QueueCount(0, 30000);

    const pane = await waitForV4Pane(() => true, "无法读取 Highspeed queue pane");
    if (pane.canStop) {
      await clickV4Stop();
      await waitForV4Pane((snapshot) => !snapshot.canStop, "Highspeed queue 收尾 stop 未完成");
    }
  });

  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("HS-E2E-06: 撤回 Highspeed 队列输入后恢复普通模型，修改重发仍可排队", async function () {
    this.timeout(180000);

    await prepareHighspeedDrawWorkspace();
    await sendV4Prompt(RUNNING_PROMPT);
    await waitForV4TimelineContaining(RUNNING_REPLY_TOKEN, 45000);
    await waitForV4Pane(
      (snapshot) => snapshot.canStop,
      "首轮 Highspeed 输入没有保持 running",
      45000,
    );

    await sendV4Prompt(QUEUED_PROMPT);
    await waitForV4QueueCount(1, 30000);
    const [queued] = await getV4QueueItems();
    expect(queued?.text).toContain(QUEUED_PROMPT);
    if (!queued) throw new Error("Highspeed 队列项不存在");

    expect(await clickV4QueueItemEdit(queued.queueItemId)).toBe(true);
    await waitForV4QueueCount(0, 30000);
    await browser.waitUntil(async () => (await getV4ComposerText()) === QUEUED_PROMPT, {
      timeout: 30000,
      timeoutMsg: "Highspeed 队列项没有恢复到 Composer",
    });

    // Bug 根因：旧 QueueItem 保存单轮 Highspeed Selection，撤回编辑会把隐藏 Provider
    // 恢复到 Composer，并污染修改后重发的 fallback。Composer 只能恢复队列项的普通模型。
    expect(await getV4ModelConfig()).toMatchObject({
      provider: E2E_BIGMODEL_PLAN_PROVIDER_ID,
    });

    await sendV4Prompt(RESUBMITTED_PROMPT);
    await waitForV4QueueCount(1, 30000);
    const [resubmitted] = await getV4QueueItems();
    expect(resubmitted?.queueItemId).not.toBe(queued.queueItemId);
    expect(resubmitted?.text).toContain(RESUBMITTED_PROMPT);
    expect((await getV4ModelConfig()).provider).not.toBe(INTERNAL_HIGHSPEED_PROVIDER);

    const errorBanner = $(`[data-testid="${TID_CHAT_ERROR_BANNER}"]`);
    expect(await errorBanner.isExisting()).toBe(false);
    expect((await $("body").getText()).includes(INTERNAL_HIGHSPEED_PROVIDER)).toBe(false);
  });
});
