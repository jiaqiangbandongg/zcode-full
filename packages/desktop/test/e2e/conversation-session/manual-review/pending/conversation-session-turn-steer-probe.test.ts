import {
  TID_SETTINGS_BACK_BUTTON,
  TID_SETTINGS_PAGE,
  TID_SETTINGS_SECTION_NAV,
  TID_TASK_SETTINGS_BUTTON,
  testId,
} from "@zcode/shared";
import {
  DEFAULT_WORKSPACE,
  clearAppData,
  clickTestIdByDom,
  readSettings,
  waitForWorkspaceApp,
} from "../../../helpers/desktop-app.js";
import {
  E2E_REPLY_TOKEN,
  assertVisibleUserMessagesNotContaining,
  buildReadonlyToolPrompt,
  clickChatStop,
  countUpstreamRequestsContaining,
  getChatRootSnapshot,
  getQueueItems,
  listToolCallBlocks,
  prepareConversationE2E,
  sendPrompt,
  startNewTask,
  waitForChatState,
  waitForComposerText,
  waitForQueueContaining,
  waitForQueueOrderContaining,
  waitForToastContaining,
} from "../../../helpers/conversation-session.js";
import { sel } from "../../../helpers/selectors.js";

const TEST_TIMEOUT_MS = 120000;
const COMPACT_REQUEST_SENTINEL = "CRITICAL: Respond with TEXT ONLY";
const COMPACT_QUEUED_TOAST_TEXTS = [
  "Compaction queued and will run in order.",
  "已加入队列，将按顺序压缩上下文。",
];

describe("会话区 Turn Steering E2E", () => {
  before(async function () {
    this.timeout(TEST_TIMEOUT_MS);
    await prepareConversationE2E();
    await ensureQueueInteractionBehavior();
  });

  afterEach(async () => {
    await stopIfBusy();
  });

  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("首轮工具调用中发送普通文本时进入未来队列并保留 tool block", async function () {
    this.timeout(TEST_TIMEOUT_MS);

    await startNewTask();
    const runId = Date.now();
    const basePrompt = buildReadonlyToolPrompt(`E2E_TURN_STEER_TOOL_TEXT_${runId}`);
    const guidedMarker = `E2E_TURN_STEER_TEXT_AFTER_TOOL_${runId}`;
    const guidedPrompt = `E2E_SLOW_STREAM ${guidedMarker}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;

    await sendPrompt(basePrompt);
    await waitForComposerText("", "turn steer: 首轮工具 prompt 后输入框没有清空");
    await waitForChatState(
      (snapshot) => snapshot.state === "streaming",
      "turn steer: 首轮工具 prompt 没有进入 streaming",
      30000,
    );
    await waitForToolBlock();

    await sendPrompt(guidedPrompt);
    await waitForComposerText("", "turn steer: 普通后续输入后输入框没有清空");

    const queue = await waitForQueueItemContaining(guidedMarker);
    expect(queue.kind).toBe("text");
    expect(await listToolCallBlocks()).not.toHaveLength(0);
  });

  it("首轮 running 中发送 /goal 时进入未来队列", async function () {
    this.timeout(TEST_TIMEOUT_MS);

    await startNewTask();
    const runId = Date.now();
    const basePrompt = `E2E_SLOW_STREAM E2E_TURN_STEER_GOAL_BASE_${runId}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
    const goalPrompt = `/goal E2E_SLOW_STREAM E2E_TURN_STEER_GOAL_${runId}: 观察当前会话，不修改文件。`;

    await sendPrompt(basePrompt);
    await waitForComposerText("", "turn steer: goal base prompt 后输入框没有清空");
    await waitForChatState(
      (snapshot) => snapshot.state === "streaming",
      "turn steer: goal base prompt 没有进入 streaming",
      30000,
    );

    await sendPrompt(goalPrompt);
    await waitForComposerText("", "turn steer: running /goal 后输入框没有清空");

    const queue = await waitForQueueItemContaining(`E2E_TURN_STEER_GOAL_${runId}`);
    expect(queue.kind).toBe("goal");
  });

  it("首轮 running 中交叉发送 text、/goal、/compact 时按统一 FIFO 入队", async function () {
    this.timeout(TEST_TIMEOUT_MS);

    await startNewTask();
    const runId = Date.now();
    const basePrompt = `E2E_SLOW_STREAM E2E_TURN_STEER_MIXED_BASE_${runId}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
    const textPrompt = `E2E_SLOW_STREAM E2E_TURN_STEER_MIXED_TEXT_${runId}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
    const goalPrompt = `/goal E2E_SLOW_STREAM E2E_TURN_STEER_MIXED_GOAL_${runId}: 观察当前会话，不修改文件。`;

    await sendPrompt(basePrompt);
    await waitForComposerText("", "turn steer: mixed base prompt 后输入框没有清空");
    await waitForChatState(
      (snapshot) => snapshot.state === "streaming",
      "turn steer: mixed base prompt 没有进入 streaming",
      30000,
    );

    await sendPrompt(textPrompt);
    await waitForComposerText("", "turn steer: mixed text 后输入框没有清空");
    let queue = await waitForQueueOrderContaining([`E2E_TURN_STEER_MIXED_TEXT_${runId}`]);
    expect(queue.map((item) => item.kind)).toEqual(["text"]);

    await sendPrompt(goalPrompt);
    await waitForComposerText("", "turn steer: mixed /goal 后输入框没有清空");
    queue = await waitForQueueOrderContaining([
      `E2E_TURN_STEER_MIXED_TEXT_${runId}`,
      `E2E_TURN_STEER_MIXED_GOAL_${runId}`,
    ]);
    expect(queue.map((item) => item.kind)).toEqual(["text", "goal"]);

    const compactRequestsBefore = await countUpstreamRequestsContaining(COMPACT_REQUEST_SENTINEL);
    await sendPrompt("/compact");
    await waitForComposerText("", "turn steer: mixed /compact 后输入框没有清空");
    await waitForToastContaining(
      COMPACT_QUEUED_TOAST_TEXTS,
      "turn steer: running /compact 没有弹出 queued toast",
    );
    queue = await waitForQueueOrderContaining([
      `E2E_TURN_STEER_MIXED_TEXT_${runId}`,
      `E2E_TURN_STEER_MIXED_GOAL_${runId}`,
      "/compact",
    ]);
    expect(queue.map((item) => item.kind)).toEqual(["text", "goal", "compact"]);
    await assertVisibleUserMessagesNotContaining("/compact");
    expect(await countUpstreamRequestsContaining(COMPACT_REQUEST_SENTINEL)).toBe(
      compactRequestsBefore,
    );
  });
});

async function waitForToolBlock() {
  await browser.waitUntil(async () => (await listToolCallBlocks()).length > 0, {
    timeout: 30000,
    timeoutMsg: "turn steer: 未观察到 tool block",
  });
}

async function ensureQueueInteractionBehavior() {
  if ((await readSettings()).zcodeInteractionBehavior === "queue") {
    return;
  }

  await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON, {
    timeout: 15000,
    timeoutMsg: "turn steer: 没有找到设置入口按钮",
  });
  await $(sel(TID_SETTINGS_PAGE)).waitForDisplayed({ timeout: 15000 });
  await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "general"), {
    timeout: 15000,
    timeoutMsg: "turn steer: 设置页没有出现通用分区入口",
  });

  // 修复原因：这个 spec 的文件名会命中 WDIO 的 guide seed，但 M01-M05
  // 锁定的是 queue 模式产品语义；转正后必须通过设置页切回 queue，
  // 避免把 guide/turn-steer 的 M06 行为混进普通 queue 断言。
  await clickInteractionBehaviorSelect();
  await clickInteractionBehaviorQueueOption();

  await browser.waitUntil(async () => (await readSettings()).zcodeInteractionBehavior === "queue", {
    timeout: 15000,
    timeoutMsg: "turn steer: 交互行为没有保存为 queue",
  });
  await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON, {
    timeout: 15000,
    timeoutMsg: "turn steer: 设置页返回按钮没有出现",
  });
  await waitForWorkspaceApp(DEFAULT_WORKSPACE, 30000);
}

async function clickInteractionBehaviorSelect() {
  await browser.waitUntil(
    async () =>
      browser.execute(() => {
        const triggers = Array.from(document.querySelectorAll<HTMLElement>('[role="combobox"]'));
        const trigger = triggers.find((element) =>
          ["引导", "Guide", "队列", "Queue"].some((label) =>
            (element.innerText || element.textContent || "").includes(label),
          ),
        );
        if (!trigger) {
          return false;
        }
        trigger.scrollIntoView({ block: "center", inline: "nearest" });
        trigger.dispatchEvent(
          new PointerEvent("pointerdown", {
            bubbles: true,
            button: 0,
            buttons: 1,
            cancelable: true,
            pointerId: 1,
            pointerType: "mouse",
          }),
        );
        trigger.click();
        return true;
      }),
    {
      timeout: 15000,
      timeoutMsg: "turn steer: 没有找到交互行为 Select",
    },
  );
}

async function clickInteractionBehaviorQueueOption() {
  await browser.waitUntil(
    async () =>
      browser.execute(() => {
        const options = Array.from(
          document.querySelectorAll<HTMLElement>('[role="option"], [data-radix-collection-item]'),
        );
        const option = options.find((element) =>
          ["队列", "Queue"].includes((element.innerText || element.textContent || "").trim()),
        );
        if (!option) {
          return false;
        }
        option.scrollIntoView({ block: "center", inline: "nearest" });
        option.click();
        return true;
      }),
    {
      timeout: 15000,
      timeoutMsg: "turn steer: 没有找到交互行为 queue 选项",
    },
  );
}

async function waitForQueueItemContaining(text: string) {
  await waitForQueueContaining(text);
  const queue = await getQueueItems();
  const item = queue.find((candidate) => candidate.content.includes(text));
  if (!item) {
    throw new Error(`turn steer: 队列等待后仍找不到 ${text}; latest=${JSON.stringify(queue)}`);
  }
  return item;
}

async function stopIfBusy() {
  const snapshot = await getChatRootSnapshot().catch(() => null);
  if (snapshot?.state !== "streaming") {
    return;
  }
  await clickChatStop().catch(() => undefined);
  await waitForChatState(
    (candidate) => candidate.state !== "streaming",
    "turn steer 清理阶段没有退出 streaming",
    30000,
  ).catch(() => undefined);
  await getQueueItems().catch(() => []);
}
