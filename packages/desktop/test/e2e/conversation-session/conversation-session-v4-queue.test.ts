// M4 门禁：queue 单项管理 + B09 撤回到 composer。
// 证据层 L3：running turn 期间 sendText 入队 → QueuePanel → deleteQueueItem 权威移除 →
// 发起端恢复 text + AttachmentRef[]；重发产生新 queueItemId。非空草稿在 UI admission
// 边界阻止命令，queue 与草稿都不变。
import { clearAppData } from "../helpers/desktop-app.js";
import { waitForToastContaining } from "../helpers/conversation-session-toast.js";
import {
  clickV4Stop,
  clickV4QueueItemDelete,
  dragV4QueueItemOnto,
  clickV4QueueItemEdit,
  getV4ComposerAttachments,
  getV4ComposerText,
  getV4PaneSnapshot,
  getV4QueueItems,
  isV4ComposerFocused,
  prepareV4ConversationE2E,
  pasteV4ComposerImageAttachment,
  sendV4Prompt,
  setV4ComposerText,
  waitForV4Pane,
  waitForV4QueueCount,
  waitForV4TimelineContaining,
} from "../helpers/v4-conversation.js";

describe("v4 M4/B09 门禁：queue 单项管理与撤回编辑", () => {
  afterEach(async () => {
    const snapshot = await getV4PaneSnapshot();
    if (!snapshot.canStop) return;
    // 修复原因：controlled stream 会跨 case 存活 45 秒；不主动 stop 会让上一条
    // active runtime 与下一条 draft 并行，并在结尾 drain 残留 queue，污染模型/fixture。
    await clickV4Stop();
    await waitForV4Pane((next) => !next.canStop, "queue operation case 收尾 stop 没有完成", 30000);
  });

  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("running 中入队一条 → QueuePanel 显示 → 删除 → 队列清空", async () => {
    await prepareV4ConversationE2E();

    // 首轮：可控慢流，保持 running
    await sendV4Prompt("E2E_V4_QUEUE_SLOW 慢慢回答");
    await waitForV4TimelineContaining("V4_QUEUE_STREAMING", 45000);
    await waitForV4Pane(
      (s) => s.canStop && s.sessionId !== "draft" && s.sessionId !== null,
      "首轮没有进入 running（canStop）",
      45000,
    );

    // running 中发第二条 → 入队
    await sendV4Prompt("E2E_V4_QUEUE_ITEM 排队的问题");
    await waitForV4QueueCount(1, 30000);
    const before = await getV4QueueItems();
    expect(before).toHaveLength(1);
    expect(before[0]!.text).toContain("E2E_V4_QUEUE_ITEM");

    // 删除该队列项 → 队列清空
    const clicked = await clickV4QueueItemDelete(before[0]!.queueItemId);
    expect(clicked).toBe(true);
    await waitForV4QueueCount(0, 30000);
    expect(await getV4QueueItems()).toHaveLength(0);
  });

  it("running 中带图片入队 → 撤回到 composer → 修改重发产生新 queueItemId", async () => {
    await prepareV4ConversationE2E();

    await sendV4Prompt("E2E_V4_QUEUE_SLOW 慢慢回答");
    await waitForV4TimelineContaining("V4_QUEUE_STREAMING", 45000);
    await waitForV4Pane(
      (s) => s.canStop && s.sessionId !== "draft" && s.sessionId !== null,
      "首轮没有进入 running（canStop）",
      45000,
    );

    await pasteV4ComposerImageAttachment("e2e-queue-edit.png");
    await sendV4Prompt("E2E_V4_QUEUE_ITEM 排队原文");
    await waitForV4QueueCount(1, 30000);
    const before = await getV4QueueItems();
    expect(before[0]!.text).toContain("排队原文");
    const queueItemId = before[0]!.queueItemId;

    // 修复原因：ACK 回来前的双击若发出两个 delete，会重复恢复同一份附件草稿。
    // 同一事件循环连点两次，验证 renderer-local operation lock 在 React 重渲染前也生效。
    const clicked = await clickV4QueueItemEdit(queueItemId, 2);
    expect(clicked).toBe(true);
    await waitForV4QueueCount(0, 30000);
    await browser.waitUntil(
      async () => {
        const text = await getV4ComposerText();
        const attachments = await getV4ComposerAttachments();
        return (
          text === "E2E_V4_QUEUE_ITEM 排队原文" &&
          attachments.length === 1 &&
          // Bug 原因：从 queue 恢复的媒体 ref 不重建本地 object URL，缩略图可能只显示
          // image fallback icon；用 innerText 验证 filename 会误判已恢复且 ready 的附件。
          attachments[0]?.uploadStatus === "ready"
        );
      },
      { timeout: 30000, timeoutMsg: "队列项移除后没有完整恢复 composer 文本与附件" },
    );
    expect(await isV4ComposerFocused()).toBe(true);
    expect(await getV4ComposerAttachments()).toHaveLength(1);

    await sendV4Prompt("E2E_V4_QUEUE_ITEM 编辑后重新提交");
    await waitForV4QueueCount(1, 30000);
    const after = await getV4QueueItems();
    expect(after).toHaveLength(1);
    expect(after[0]?.queueItemId).not.toBe(queueItemId);
    expect(after[0]?.text).toContain("编辑后重新提交");
  });

  it("composer 已有草稿时编辑 queue 不撤回且提示先处理草稿", async () => {
    await prepareV4ConversationE2E();

    await sendV4Prompt("E2E_V4_QUEUE_SLOW 慢慢回答");
    await waitForV4TimelineContaining("V4_QUEUE_STREAMING", 45000);
    await waitForV4Pane(
      (s) => s.canStop && s.sessionId !== "draft" && s.sessionId !== null,
      "首轮没有进入 running（canStop）",
      45000,
    );

    await sendV4Prompt("E2E_V4_QUEUE_ITEM 不应被撤回");
    await waitForV4QueueCount(1, 30000);
    const before = await getV4QueueItems();
    await setV4ComposerText("保留现有草稿");

    expect(await clickV4QueueItemEdit(before[0]!.queueItemId)).toBe(true);
    await waitForToastContaining(
      [
        "Send or clear the current draft before editing a queued message.",
        "请先发送或清空当前草稿，再编辑队列消息。",
      ],
      // Bug 根因：E2E 会继承 workspace locale，旧断言只接受英文，中文环境下把
      // 已正确出现的冲突提示误报为缺失。行为契约必须同时覆盖两种受支持语言。
      "非空草稿没有出现撤回阻止提示",
    );
    expect(await getV4ComposerText()).toBe("保留现有草稿");
    const after = await getV4QueueItems();
    expect(after).toHaveLength(1);
    expect(after[0]?.queueItemId).toBe(before[0]?.queueItemId);
    expect(after[0]?.text).toContain("不应被撤回");
  });

  it("running 中入队两条 → 拖拽第二条到第一条 → 顺序互换（reorderQueueItem）", async () => {
    await prepareV4ConversationE2E();

    await sendV4Prompt("E2E_V4_QUEUE_SLOW 慢慢回答");
    await waitForV4TimelineContaining("V4_QUEUE_STREAMING", 45000);
    await waitForV4Pane(
      (s) => s.canStop && s.sessionId !== "draft" && s.sessionId !== null,
      "首轮没有进入 running（canStop）",
      45000,
    );

    // running 中依次入队两条
    await sendV4Prompt("E2E_V4_QUEUE_ITEM 第一条问题");
    await waitForV4QueueCount(1, 30000);
    await sendV4Prompt("E2E_V4_QUEUE_ITEM 第二条问题");
    await waitForV4QueueCount(2, 30000);

    const before = await getV4QueueItems();
    expect(before).toHaveLength(2);
    expect(before[0]!.text).toContain("第一条问题");
    expect(before[1]!.text).toContain("第二条问题");
    const secondId = before[1]!.queueItemId;

    // 拖拽只发 reorderQueueItem；顺序更新必须来自 CLI projection 回流。
    await dragV4QueueItemOnto(secondId, before[0]!.queueItemId);
    await browser.waitUntil(
      async () => {
        const items = await getV4QueueItems();
        return items.length === 2 && items[0]!.queueItemId === secondId;
      },
      { timeout: 30000, timeoutMsg: "第二条没有拖拽到队首" },
    );
    const after = await getV4QueueItems();
    expect(after).toHaveLength(2);
    expect(after[0]!.queueItemId).toBe(secondId);
    expect(after[0]!.text).toContain("第二条问题");
    expect(after[1]!.text).toContain("第一条问题");
  });
});
