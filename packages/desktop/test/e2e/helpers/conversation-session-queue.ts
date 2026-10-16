import {
  TID_CHAT_QUEUE_DRAG_HANDLE,
  TID_CHAT_QUEUE_EDIT_BUTTON,
  TID_CHAT_QUEUE_EDIT_INPUT,
  TID_CHAT_QUEUE_EDIT_SAVE_BUTTON,
  TID_CHAT_QUEUE_ITEM,
  TID_CHAT_QUEUE_ITEM_CONTENT,
  TID_CHAT_QUEUE_PANEL,
  TID_CHAT_QUEUE_REMOVE_BUTTON,
  TID_CHAT_QUEUE_SEND_NOW_BUTTON,
  TID_V4_QUEUE,
  TID_V4_QUEUE_ITEM,
  TID_V4_QUEUE_ITEM_DELETE,
  TID_V4_QUEUE_ITEM_EDIT,
  TID_V4_QUEUE_ITEM_SEND_NOW,
} from "@zcode/shared";
import { clickTestIdByDom, setInputValueByTestIdDom } from "./desktop-app.js";

export interface QueueItemSnapshot {
  content: string;
  id: string;
  index: number;
  kind: string | null;
  status: string | null;
}

export async function clickFirstQueueSendNow() {
  const items = await getQueueItems();
  const first = items[0];
  if (!first) {
    throw new Error("队列为空，无法点击立即发送");
  }
  await clickQueueSendNow(first.id);
  return first;
}

export async function clickQueueSendNow(promptId: string) {
  const items = await getQueueItems();
  const target = items.find((item) => item.id === promptId);
  if (!target) {
    throw new Error(
      `队列中不存在可立即发送的项 ${promptId}; latest=${JSON.stringify(items)}`,
    );
  }
  const buttonTestId = await resolveQueueActionTestId(
    target.id,
    TID_CHAT_QUEUE_SEND_NOW_BUTTON,
    TID_V4_QUEUE_ITEM_SEND_NOW,
  );
  await clickTestIdByDom(buttonTestId, {
    timeout: 15000,
    timeoutMsg: `队列项 ${target.id} 的立即发送按钮没有出现`,
  });
  return target;
}

export async function clickQueueEdit(promptId: string) {
  const buttonTestId = await resolveQueueActionTestId(
    promptId,
    TID_CHAT_QUEUE_EDIT_BUTTON,
    TID_V4_QUEUE_ITEM_EDIT,
  );
  await clickTestIdByDom(buttonTestId, {
    timeout: 15000,
    timeoutMsg: `队列项 ${promptId} 的编辑按钮没有出现`,
  });
}

export async function setQueueEditInputText(promptId: string, content: string) {
  await setInputValueByTestIdDom(
    `${TID_CHAT_QUEUE_EDIT_INPUT}-${promptId}`,
    content,
    {
      timeout: 15000,
      timeoutMsg: `队列项 ${promptId} 的编辑输入框没有出现`,
    },
  );
}

export async function clickQueueEditSave(promptId: string) {
  await clickTestIdByDom(`${TID_CHAT_QUEUE_EDIT_SAVE_BUTTON}-${promptId}`, {
    timeout: 15000,
    timeoutMsg: `队列项 ${promptId} 的编辑保存按钮没有出现`,
  });
}

export async function clickQueueRemove(promptId: string) {
  const buttonTestId = await resolveQueueActionTestId(
    promptId,
    TID_CHAT_QUEUE_REMOVE_BUTTON,
    TID_V4_QUEUE_ITEM_DELETE,
  );
  await clickTestIdByDom(buttonTestId, {
    timeout: 15000,
    timeoutMsg: `队列项 ${promptId} 的删除按钮没有出现`,
  });
}

export async function dragQueueItemOnto(
  sourcePromptId: string,
  targetPromptId: string,
) {
  const positions = (await browser.execute(
    (dragHandleTestId, targetItemTestId) => {
      const dragHandle = document.querySelector<HTMLElement>(
        `[data-testid="${dragHandleTestId}"]`,
      );
      const targetItem = document.querySelector<HTMLElement>(
        `[data-testid="${targetItemTestId}"]`,
      );
      if (!dragHandle || !targetItem) {
        return {
          ok: false,
          reason: "missing-element",
          hasDragHandle: Boolean(dragHandle),
          hasTargetItem: Boolean(targetItem),
        };
      }
      const dragRect = dragHandle.getBoundingClientRect();
      const targetRect = targetItem.getBoundingClientRect();
      return {
        ok: true,
        startX: Math.round(dragRect.left + dragRect.width / 2),
        startY: Math.round(dragRect.top + dragRect.height / 2),
        endX: Math.round(targetRect.left + targetRect.width / 2),
        endY: Math.round(targetRect.top + targetRect.height / 2),
      };
    },
    `${TID_CHAT_QUEUE_DRAG_HANDLE}-${sourcePromptId}`,
    `${TID_CHAT_QUEUE_ITEM}-${targetPromptId}`,
  )) as
    | { ok: true; startX: number; startY: number; endX: number; endY: number }
    | {
        ok: false;
        reason: string;
        hasDragHandle: boolean;
        hasTargetItem: boolean;
      };

  if (!positions.ok) {
    throw new Error(`队列项拖拽元素不存在: ${JSON.stringify(positions)}`);
  }

  await browser.performActions([
    {
      id: "queue-drag-pointer",
      type: "pointer",
      parameters: { pointerType: "mouse" },
      actions: [
        {
          type: "pointerMove",
          duration: 0,
          x: positions.startX,
          y: positions.startY,
        },
        { type: "pointerDown", button: 0 },
        { type: "pause", duration: 80 },
        {
          type: "pointerMove",
          duration: 120,
          x: positions.startX,
          y: positions.startY - 10,
        },
        {
          type: "pointerMove",
          duration: 260,
          x: positions.endX,
          y: positions.endY,
        },
        { type: "pointerUp", button: 0 },
      ],
    },
  ]);
  await browser.releaseActions();
  // 修复原因：dnd-kit 会在拖拽结束后屏蔽紧随其后的 click，避免 pointerup
  // 被误判成一次普通点击。WebDriver pointer actions 在这里不会稳定补发浏览器合成 click，
  // 因此测试里先用一次空白 click 消耗该屏蔽，后续按钮点击才等价于真实用户拖完再点。
  await browser.execute(() => {
    document.body.dispatchEvent(
      new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        view: window,
      }),
    );
  });
  await browser.pause(50);
}

export async function waitForQueueOrderContaining(
  expectedTokens: readonly string[],
  timeoutMsg?: string,
) {
  let latest: QueueItemSnapshot[] = [];
  try {
    await browser.waitUntil(
      async () => {
        latest = await getQueueItems();
        if (latest.length < expectedTokens.length) {
          return false;
        }
        return expectedTokens.every((token, index) =>
          latest[index]?.content.includes(token),
        );
      },
      {
        timeout: 30000,
        timeoutMsg:
          timeoutMsg ?? `队列顺序不符合预期 ${JSON.stringify(expectedTokens)}`,
      },
    );
  } catch (error) {
    // 修复原因：WebdriverIO 的 timeoutMsg 是等待开始时固定的字符串，
    // 队列枚举失败时必须补采最终 UI 队列，才能判断是产品状态错了还是测试动作没命中。
    latest = await getQueueItems();
    throw new Error(
      `${timeoutMsg ?? `队列顺序不符合预期 ${JSON.stringify(expectedTokens)}`}; latest=${JSON.stringify(latest)}`,
      {
        cause: error,
      },
    );
  }
  return latest;
}

export async function waitForQueueCount(count: number, timeoutMsg?: string) {
  let latest: QueueItemSnapshot[] = [];
  try {
    await browser.waitUntil(
      async () => {
        latest = await getQueueItems();
        return latest.length === count;
      },
      {
        timeout: 30000,
        timeoutMsg: timeoutMsg ?? `队列数量没有变为 ${count}`,
      },
    );
  } catch (error) {
    // 修复原因同 waitForQueueOrderContaining：失败证据必须来自最后一帧队列 DOM。
    latest = await getQueueItems();
    throw new Error(
      `${timeoutMsg ?? `队列数量没有变为 ${count}`}; latest=${JSON.stringify(latest)}`,
      {
        cause: error,
      },
    );
  }
  return latest;
}

export function getQueueItems(): Promise<QueueItemSnapshot[]> {
  return browser.execute(
    (
      queueItemPrefix,
      queueContentPrefix,
      queuePanelTestId,
      v4QueueItemPrefix,
      v4QueuePanelTestId,
    ) => {
      const panel =
        document.querySelector<HTMLElement>(
          `[data-testid="${v4QueuePanelTestId}"]`,
        ) ??
        document.querySelector<HTMLElement>(
          `[data-testid="${queuePanelTestId}"]`,
        );
      if (!panel) {
        return [];
      }
      const activeItemPrefix =
        panel.getAttribute("data-testid") === v4QueuePanelTestId
          ? v4QueueItemPrefix
          : queueItemPrefix;
      return Array.from(
        panel.querySelectorAll<HTMLElement>(
          `li[data-testid^="${activeItemPrefix}-"][data-queue-item-id]`,
        ),
      ).map((element, index) => {
        const id = element.getAttribute("data-queue-item-id") ?? "";
        const legacyContent = element.querySelector<HTMLElement>(
          `[data-testid="${queueContentPrefix}-${id}"]`,
        );
        const v4Content = element.querySelector<HTMLElement>("span[title]");
        const rawKind = element.getAttribute("data-kind");
        return {
          // 修复原因：V4 队列迁移后不再渲染 chat-queue-item-content，正文保存在
          // title span；旧 helper 把真实 queue 读成空，导致 guide/verifier 与 send-now
          // E2E 都误报丢消息。这里统一成历史 helper 的 text/goal/compact 术语。
          content: (
            legacyContent?.innerText ??
            v4Content?.getAttribute("title") ??
            v4Content?.innerText ??
            ""
          )
            .replace(/\u00a0/g, " ")
            .trim(),
          id,
          index,
          kind:
            rawKind === "sendText"
              ? "text"
              : rawKind === "sendGoalCommand"
                ? "goal"
                : rawKind,
          status:
            element.getAttribute("data-status") ??
            element.getAttribute("data-dispatch-state"),
        };
      });
    },
    TID_CHAT_QUEUE_ITEM,
    TID_CHAT_QUEUE_ITEM_CONTENT,
    TID_CHAT_QUEUE_PANEL,
    TID_V4_QUEUE_ITEM,
    TID_V4_QUEUE,
  );
}

async function resolveQueueActionTestId(
  promptId: string,
  legacyPrefix: string,
  v4Prefix: string,
) {
  const testIdValue = await browser.execute(
    (itemId, legacyActionPrefix, v4ActionPrefix) => {
      const v4TestId = `${v4ActionPrefix}-${itemId}`;
      if (document.querySelector(`[data-testid="${v4TestId}"]`)) {
        return v4TestId;
      }
      const legacyTestId = `${legacyActionPrefix}-${itemId}`;
      if (document.querySelector(`[data-testid="${legacyTestId}"]`)) {
        return legacyTestId;
      }
      return v4TestId;
    },
    promptId,
    legacyPrefix,
    v4Prefix,
  );
  return testIdValue;
}

export async function waitForQueueContaining(text: string) {
  let latest: QueueItemSnapshot[] = [];
  try {
    await browser.waitUntil(
      async () => {
        latest = await getQueueItems();
        return latest.some((item) => item.content.includes(text));
      },
      {
        timeout: 30000,
        timeoutMsg: `队列中没有出现 ${text}`,
      },
    );
  } catch (error) {
    latest = await getQueueItems();
    throw new Error(
      `队列中没有出现 ${text}; latest=${JSON.stringify(latest)}`,
      {
        cause: error,
      },
    );
  }
}
